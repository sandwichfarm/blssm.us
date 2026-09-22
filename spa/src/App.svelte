<script lang="ts">
  import { onMount } from "svelte";
  import Admin from "./Admin.svelte";
  import type { ISigner, NostrPool } from "applesauce-signers";
  import { ExtensionSigner, PrivateKeySigner, NostrConnectSigner } from "applesauce-signers";
  import { Notemine } from "@notemine/wrapper";
  import { SimplePool } from "nostr-tools/pool";
  import type { NostrEvent } from "nostr-tools";
  import { Subscription, Observable, merge } from "rxjs";
  import { QR } from "qr-svg";

  const SERVER_URL = window.location.origin;

  interface ServerInfo {
    public: boolean;
    paymentsEnabled: boolean;
    allowlist?: string[];
    payment?: {
      amounts: { upload: number; mirror: number };
      fixedAmounts: boolean;
      pricing?: {
        cost_per_gb_usd: number;
        profit_margin_pct: number;
        slippage_premium_pct: number;
      };
      mints: string[];
    };
  }

  const REPORT_CATEGORIES = [
    { value: "nudity", label: "Nudity" },
    { value: "malware", label: "Malware" },
    { value: "profanity", label: "Profanity" },
    { value: "illegal", label: "Illegal" },
    { value: "spam", label: "Spam" },
    { value: "impersonation", label: "Impersonation" },
    { value: "other", label: "Other" },
  ] as const;

  type SignerType = "extension" | "nip46" | "anonymous";

  // Client-side routing
  let currentPath = $state(window.location.pathname);

  function navigate(path: string) {
    history.pushState(null, "", path);
    currentPath = path;
  }

  const isReportPage = $derived(currentPath === "/report");
  const isAdminPage = $derived(currentPath === "/admin" || currentPath === "/admin/");

  let loading = $state(true);
  let error = $state<string | null>(null);
  let serverInfo = $state<ServerInfo | null>(null);
  let reportHash = $state("");
  let reportCategory = $state<string>("spam");
  let reportDescription = $state("");
  let signerType = $state<SignerType>("anonymous");
  let bunkerUri = $state("");
  let nip46Mode = $state<"bunker" | "qr">("qr");
  let nip46ConnectUri = $state("");
  let nip46QrSvg = $state("");
  let nip46Connected = $state(false);
  let nip46Connecting = $state(false);
  let nip46Signer: NostrConnectSigner | null = null;
  let nip46AbortController: AbortController | null = null;
  let mining = $state(false);
  let miningProgress = $state<{ bestPow: number; hashRate: number } | null>(null);
  let submitting = $state(false);
  let reportResult = $state<{ success: boolean; message: string } | null>(null);
  let hasExtension = $state(false);
  let hashChecking = $state(false);
  let hashVerified = $state(false);
  let hashError = $state<string | null>(null);

  let activeMiner: Notemine | null = null;
  let miningSubscriptions: Subscription[] = [];

  const isValidHash = $derived(/^[0-9a-f]{64}$/.test(reportHash));
  const canSubmit = $derived(
    hashVerified && !mining && !submitting && (
      signerType !== "nip46" || nip46Connected || (nip46Mode === "bunker" && bunkerUri.length > 0)
    )
  );

  async function checkHash() {
    hashError = null;
    hashChecking = true;
    hashVerified = false;
    try {
      const res = await fetch(`/${reportHash}`, { method: "HEAD" });
      if (res.ok) {
        hashVerified = true;
      } else if (res.status === 404) {
        hashError = "Blob not found on this server";
      } else {
        hashError = `Server returned ${res.status}`;
      }
    } catch {
      hashError = "Could not reach server";
    } finally {
      hashChecking = false;
    }
  }

  function resetHash() {
    reportHash = "";
    hashVerified = false;
    hashError = null;
    reportResult = null;
  }

  const NIP46_RELAYS = ["wss://relay.nsec.app", "wss://relay.damus.io"];

  async function getSigner(): Promise<ISigner> {
    switch (signerType) {
      case "extension":
        return new ExtensionSigner();
      case "nip46": {
        if (nip46Signer && nip46Connected) return nip46Signer;
        // Bunker URI mode — create fresh signer from URI
        const signer = await NostrConnectSigner.fromBunkerURI(bunkerUri, {
          pool: makeNostrPool(),
        });
        await signer.open();
        await signer.connect();
        nip46Signer = signer;
        nip46Connected = true;
        return signer;
      }
      case "anonymous":
      default:
        return new PrivateKeySigner();
    }
  }

  function makeNostrPool(): NostrPool {
    const pool = new SimplePool();
    return {
      subscription(relays, filters) {
        return merge(...filters.map(filter => new Observable<NostrEvent>(observer => {
          const sub = pool.subscribeMany(relays, filter, {
            onevent(event) { observer.next(event); },
            oneose() {},
            onclose() { observer.complete(); },
          });
          return () => sub.close();
        })));
      },
      publish(relays, event) {
        return Promise.all(pool.publish(relays, event));
      },
    };
  }

  async function initNip46QR() {
    nip46Connecting = true;
    nip46Connected = false;
    nip46AbortController?.abort();
    nip46AbortController = new AbortController();

    try {
      const signer = new NostrConnectSigner({
        relays: NIP46_RELAYS,
        pool: makeNostrPool(),
      });
      nip46Signer = signer;
      await signer.open();

      const uri = signer.getNostrConnectURI({
        name: "blssm.us",
        url: window.location.origin,
        permissions: NostrConnectSigner.buildSigningPermissions([1984]),
      });
      nip46ConnectUri = uri;
      nip46QrSvg = QR(uri, "L");

      await signer.waitForSigner(nip46AbortController.signal);
      nip46Connected = true;
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        reportResult = { success: false, message: `NIP-46 connection failed: ${e?.message ?? "Unknown error"}` };
      }
    } finally {
      nip46Connecting = false;
    }
  }

  function cancelNip46() {
    nip46AbortController?.abort();
    nip46Signer?.close();
    nip46Signer = null;
    nip46Connected = false;
    nip46Connecting = false;
    nip46ConnectUri = "";
    nip46QrSvg = "";
  }

  function cleanupMining() {
    miningSubscriptions.forEach(s => s.unsubscribe());
    miningSubscriptions = [];
    activeMiner = null;
    mining = false;
  }

  function cancelMining() {
    activeMiner?.cancel();
    cleanupMining();
    miningProgress = null;
  }

  async function submitReport() {
    reportResult = null;
    mining = true;
    miningProgress = { bestPow: 0, hashRate: 0 };

    try {
      const signer = await getSigner();
      const pubkey = await signer.getPublicKey();

      // Mine first, then sign
      const miner = new Notemine({
        kind: 1984,
        content: reportDescription || "",
        tags: [["x", reportHash, reportCategory]],
        pubkey,
        difficulty: 16,
      });

      activeMiner = miner;

      // Wait for mining to complete
      const minedEvent = await new Promise<any>((resolve, reject) => {
        const sub1 = miner.progress$.subscribe((p) => {
          miningProgress = {
            bestPow: p.bestPowData?.bestPow ?? 0,
            hashRate: p.hashRate ?? 0,
          };
        });

        const sub2 = miner.success$.subscribe((s) => {
          if (s?.result) resolve(s.result.event);
        });

        const sub3 = miner.error$.subscribe((e) => {
          reject(new Error(e.message ?? "Mining failed"));
        });

        const sub4 = miner.cancelledEvent$.subscribe(() => {
          reject(new Error("Mining cancelled"));
        });

        miningSubscriptions = [sub1, sub2, sub3, sub4];
        miner.mine();
      });

      cleanupMining();
      miningProgress = null;
      submitting = true;

      // Sign the mined event template
      const signedEvent = await signer.signEvent({
        kind: minedEvent.kind ?? 1984,
        created_at: minedEvent.created_at ?? Math.floor(Date.now() / 1000),
        tags: minedEvent.tags ?? [],
        content: minedEvent.content ?? "",
      });

      // Close NIP-46 connection if applicable
      if (signerType === "nip46" && "close" in signer) {
        (signer as NostrConnectSigner).close();
      }

      // Submit to server
      const res = await fetch("/report", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signedEvent),
      });

      const body = await res.json().catch(() => null);

      if (res.ok) {
        reportResult = { success: true, message: body?.message ?? "Report received" };
        reportHash = "";
        hashVerified = false;
        reportDescription = "";
      } else {
        reportResult = { success: false, message: body?.message ?? `HTTP ${res.status}` };
      }
    } catch (e: any) {
      cleanupMining();
      miningProgress = null;
      if (e?.message !== "Mining cancelled") {
        reportResult = { success: false, message: e?.message ?? "Unknown error" };
      }
    } finally {
      submitting = false;
      mining = false;
    }
  }

  const buds = $derived(
    [
      { id: "01", name: "Server Requirements & Blob Retrieval", status: "full" },
      { id: "02", name: "Blob Upload & Management", status: "full" },
      { id: "04", name: "Mirroring", status: "full" },
      { id: "06", name: "Upload Pre-flight", status: "full" },
      ...(serverInfo?.paymentsEnabled
        ? [{ id: "07", name: "Payments", status: "partial" as const }]
        : []),
      { id: "08", name: "File Metadata (NIP-94)", status: "full" },
      { id: "09", name: "Content Reporting", status: "full", href: "/report" },
    ]
  );

  const endpoints = [
    { method: "GET", path: "/<sha256>", desc: "Retrieve a blob" },
    { method: "HEAD", path: "/<sha256>", desc: "Check blob existence" },
    { method: "PUT", path: "/upload", desc: "Upload a blob" },
    { method: "HEAD", path: "/upload", desc: "Upload pre-flight check" },
    { method: "GET", path: "/list/<pubkey>", desc: "List blobs by pubkey" },
    { method: "DELETE", path: "/<sha256>", desc: "Delete a blob" },
    { method: "PUT", path: "/mirror", desc: "Mirror from remote URL" },
{ method: "PUT", path: "/report", desc: "Report content" },
  ];

  const showAllowlist = import.meta.env.VITE_SHOW_ALLOWLIST === "true";

  function methodColor(method: string): string {
    switch (method) {
      case "GET": return "text-emerald-400";
      case "PUT": return "text-amber-400";
      case "HEAD": return "text-sky-400";
      case "DELETE": return "text-red-400";
      default: return "text-zinc-400";
    }
  }

  function statusBadge(status: string): string {
    switch (status) {
      case "full": return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
      case "partial": return "bg-amber-500/20 text-amber-400 border-amber-500/30";
      default: return "bg-zinc-500/20 text-zinc-400 border-zinc-500/30";
    }
  }

  function truncatePubkey(pk: string): string {
    return pk.length > 16 ? `${pk.slice(0, 8)}...${pk.slice(-8)}` : pk;
  }

  onMount(() => {
    hasExtension = !!(window as any).nostr;
    if (hasExtension) signerType = "extension";

    const onPopState = () => { currentPath = window.location.pathname; };
    window.addEventListener("popstate", onPopState);

    (async () => {
      try {
        const res = await fetch("/server-info");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        serverInfo = await res.json();
      } catch (e) {
        error = e instanceof Error ? e.message : "Failed to load server info";
      } finally {
        loading = false;
      }
    })();

    return () => window.removeEventListener("popstate", onPopState);
  });
</script>

<div class="min-h-screen bg-zinc-950 text-zinc-100">
  {#if !isAdminPage}
  <header class="border-b border-zinc-800">
    <div class="max-w-3xl mx-auto px-6 py-16">
      <h1 class="text-4xl font-bold tracking-tight">blssm.us</h1>
      <p class="mt-3 text-lg text-zinc-400">
        Content-addressable blob storage powered by
        <a href="https://github.com/hzrd149/blossom" target="_blank" rel="noopener" class="text-purple-400 hover:text-purple-300 underline underline-offset-2">Blossom</a>
        &
        <a href="https://nostr.com" target="_blank" rel="noopener" class="text-purple-400 hover:text-purple-300 underline underline-offset-2">Nostr</a>, running on the edge.
      </p>
      <div class="mt-6 flex items-center gap-3 text-sm text-zinc-500">
        <span class="inline-flex items-center gap-1.5">
          {#if loading}
            <span class="w-2 h-2 rounded-full bg-zinc-500 animate-pulse"></span>
            Loading
          {:else if error}
            <span class="w-2 h-2 rounded-full bg-amber-500"></span>
            Degraded
          {:else}
            <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
            Online
          {/if}
        </span>
        <span class="text-zinc-700">|</span>
        <code class="text-zinc-400">{SERVER_URL}</code>
      </div>
    </div>
  </header>
  {/if}

  <main class={`${isAdminPage ? 'max-w-7xl' : 'max-w-3xl'} mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-12`}>
  {#if isAdminPage}
    <Admin />
  {:else if isReportPage}
    <!-- Report Content Page -->
    <div class="space-y-6">
      <div class="flex items-center gap-3">
        <button onclick={() => navigate("/")} class="text-zinc-500 hover:text-zinc-300 text-sm">&larr; Back</button>
        <h2 class="text-2xl font-semibold">Report Content</h2>
      </div>

      <div class="border border-zinc-800 rounded-lg p-4 space-y-4">
        <!-- Stage 1: SHA-256 Hash -->
        <div>
          <label for="report-hash" class="block text-sm font-medium text-zinc-400 mb-1">Blob SHA-256 Hash</label>
          {#if hashVerified}
            <div class="flex items-center gap-2">
              <code class="flex-1 bg-zinc-900 border border-emerald-500/30 rounded px-3 py-2 font-mono text-xs text-zinc-200 truncate">{reportHash}</code>
              <button onclick={resetHash} class="text-xs text-zinc-500 hover:text-zinc-300 shrink-0">Change</button>
            </div>
            <p class="mt-1 text-xs text-emerald-400">Blob found on server</p>
          {:else}
            <div class="flex gap-2">
              <input
                id="report-hash"
                type="text"
                bind:value={reportHash}
                placeholder="e.g. a1b2c3d4..."
                spellcheck="false"
                disabled={hashChecking}
                class="flex-1 bg-zinc-900 border rounded px-3 py-2 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-purple-500 {reportHash && !isValidHash ? 'border-red-500/50' : hashError ? 'border-red-500/50' : 'border-zinc-700'}"
              />
              <button
                onclick={checkHash}
                disabled={!isValidHash || hashChecking}
                class="px-4 py-2 rounded text-xs font-medium transition-colors shrink-0 {isValidHash && !hashChecking ? 'bg-purple-600 hover:bg-purple-500 text-white' : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
              >
                {hashChecking ? "Checking..." : "Verify"}
              </button>
            </div>
            {#if reportHash && !isValidHash}
              <p class="mt-1 text-xs text-red-400">Must be a 64-character hex string</p>
            {/if}
            {#if hashError}
              <p class="mt-1 text-xs text-red-400">{hashError}</p>
            {/if}
          {/if}
        </div>

        <!-- Stage 2: Remaining fields (only after hash verified) -->
        {#if hashVerified}
        <!-- Report Category -->
        <div>
          <label for="report-category" class="block text-sm font-medium text-zinc-400 mb-1">Category</label>
          <select
            id="report-category"
            bind:value={reportCategory}
            class="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
          >
            {#each REPORT_CATEGORIES as cat}
              <option value={cat.value}>{cat.label}</option>
            {/each}
          </select>
        </div>

        <!-- Description -->
        <div>
          <label for="report-desc" class="block text-sm font-medium text-zinc-400 mb-1">Description <span class="text-zinc-600">(optional)</span></label>
          <textarea
            id="report-desc"
            bind:value={reportDescription}
            rows="3"
            placeholder="Why is this content being reported?"
            class="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-purple-500 resize-y"
          ></textarea>
        </div>

        <!-- Signing Method -->
        <div>
          <span class="block text-sm font-medium text-zinc-400 mb-2">Signing Method</span>
          <div class="flex gap-1 bg-zinc-900 border border-zinc-700 rounded p-0.5">
            {#if hasExtension}
              <button
                onclick={() => signerType = "extension"}
                class="flex-1 text-xs py-1.5 rounded transition-colors {signerType === 'extension' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}"
              >Extension (NIP-07)</button>
            {/if}
            <button
              onclick={() => { signerType = "nip46"; if (nip46Mode === "qr" && !nip46ConnectUri && !nip46Connecting) initNip46QR(); }}
              class="flex-1 text-xs py-1.5 rounded transition-colors {signerType === 'nip46' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}"
            >Remote Signer</button>
            <button
              onclick={() => signerType = "anonymous"}
              class="flex-1 text-xs py-1.5 rounded transition-colors {signerType === 'anonymous' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}"
            >Anonymous</button>
          </div>

          {#if signerType === "nip46"}
            <div class="mt-2 space-y-3">
              {#if nip46Connected}
                <div class="flex items-center gap-2 text-xs text-emerald-400">
                  <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                  Connected to remote signer
                  <button onclick={cancelNip46} class="ml-auto text-zinc-500 hover:text-zinc-300">Disconnect</button>
                </div>
              {:else}
                <!-- Mode toggle -->
                <div class="flex gap-1 bg-zinc-900/50 border border-zinc-800 rounded p-0.5">
                  <button
                    onclick={() => { nip46Mode = "qr"; if (!nip46ConnectUri && !nip46Connecting) initNip46QR(); }}
                    class="flex-1 text-xs py-1 rounded transition-colors {nip46Mode === 'qr' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}"
                  >QR Code</button>
                  <button
                    onclick={() => { nip46Mode = "bunker"; cancelNip46(); }}
                    class="flex-1 text-xs py-1 rounded transition-colors {nip46Mode === 'bunker' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}"
                  >Bunker URI</button>
                </div>

                {#if nip46Mode === "qr"}
                  <div class="flex flex-col items-center gap-2">
                    {#if nip46Connecting && !nip46QrSvg}
                      <div class="w-48 h-48 flex items-center justify-center border border-zinc-700 rounded">
                        <span class="text-xs text-zinc-500 animate-pulse">Generating...</span>
                      </div>
                    {:else if nip46QrSvg}
                      <div class="bg-white p-3 rounded w-48 h-48">
                        {@html nip46QrSvg}
                      </div>
                      <p class="text-xs text-zinc-500 text-center">Scan with your remote signer app</p>
                      {#if nip46Connecting}
                        <div class="flex items-center gap-2 text-xs text-zinc-400">
                          <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                          Waiting for connection...
                          <button onclick={cancelNip46} class="text-zinc-500 hover:text-zinc-300">Cancel</button>
                        </div>
                      {/if}
                      <button
                        onclick={() => navigator.clipboard.writeText(nip46ConnectUri)}
                        class="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
                      >Copy connect URI</button>
                    {/if}
                  </div>
                {:else}
                  <input
                    type="text"
                    bind:value={bunkerUri}
                    placeholder="bunker://..."
                    spellcheck="false"
                    class="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-purple-500"
                  />
                {/if}
              {/if}
            </div>
          {/if}

          {#if signerType === "anonymous"}
            <p class="mt-1.5 text-xs text-zinc-500">Generates an ephemeral keypair. The report will not be linked to your identity.</p>
          {/if}
        </div>

        <!-- Mining Progress -->
        {#if mining && miningProgress}
          <div class="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 space-y-1">
            <div class="flex items-center justify-between text-xs">
              <span class="text-zinc-400">Mining to difficulty 16...</span>
              <button onclick={cancelMining} class="text-red-400 hover:text-red-300">Cancel</button>
            </div>
            <div class="flex gap-4 text-xs font-mono text-zinc-500">
              <span>Best POW: <span class="text-zinc-300">{miningProgress.bestPow}</span> / 16</span>
              <span>Hash rate: <span class="text-zinc-300">{miningProgress.hashRate > 0 ? `${(miningProgress.hashRate / 1000).toFixed(1)}k/s` : "..."}</span></span>
            </div>
            <div class="w-full bg-zinc-800 rounded-full h-1 mt-1">
              <div
                class="bg-purple-500 h-1 rounded-full transition-all"
                style="width: {Math.min(100, (miningProgress.bestPow / 16) * 100)}%"
              ></div>
            </div>
          </div>
        {/if}

        <!-- Submit -->
        <button
          onclick={submitReport}
          disabled={!canSubmit}
          class="w-full py-2 rounded text-sm font-medium transition-colors {canSubmit ? 'bg-purple-600 hover:bg-purple-500 text-white' : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}"
        >
          {#if mining}
            Mining...
          {:else if submitting}
            Submitting...
          {:else}
            Submit Report
          {/if}
        </button>
        {/if}

        <!-- Keep feedback visible when a successful submission resets verification. -->
        {#if reportResult}
          <div role={reportResult.success ? 'status' : 'alert'} class="text-sm px-3 py-2 rounded border {reportResult.success ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}">
            {reportResult.message}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <!-- Dashboard -->
    <!-- Private server notice -->
    {#if serverInfo && !serverInfo.public}
      <div class="border border-amber-500/30 bg-amber-500/10 rounded-lg px-4 py-3 text-sm text-amber-300">
        This is a <strong>private server</strong>. Only allowlisted pubkeys may upload, mirror, or manage blobs.
      </div>
    {/if}

    <!-- Allowlist (private + env flag) -->
    {#if serverInfo && !serverInfo.public && showAllowlist && serverInfo.allowlist?.length}
      <section>
        <h2 class="text-xl font-semibold mb-4">Allowlist</h2>
        <div class="border border-zinc-800 rounded-lg overflow-hidden">
          <div class="divide-y divide-zinc-800/50">
            {#each serverInfo.allowlist as pk}
              <div class="px-4 py-2.5 font-mono text-xs text-zinc-400" title={pk}>
                {truncatePubkey(pk)}
              </div>
            {/each}
          </div>
        </div>
      </section>
    {/if}

    <section>
      <h2 class="text-xl font-semibold mb-4">API Endpoints</h2>
      <div class="border border-zinc-800 rounded-lg overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-zinc-800 text-zinc-500 text-left">
              <th class="px-4 py-2.5 font-medium w-24">Method</th>
              <th class="px-4 py-2.5 font-medium">Path</th>
              <th class="px-4 py-2.5 font-medium hidden sm:table-cell">Description</th>
            </tr>
          </thead>
          <tbody>
            {#each endpoints as ep}
              <tr class="border-b border-zinc-800/50 hover:bg-zinc-900/50">
                <td class="px-4 py-2.5">
                  <code class="font-mono text-xs font-bold {methodColor(ep.method)}">{ep.method}</code>
                </td>
                <td class="px-4 py-2.5">
                  <code class="font-mono text-xs text-zinc-300">{ep.path}</code>
                </td>
                <td class="px-4 py-2.5 text-zinc-500 hidden sm:table-cell">{ep.desc}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2 class="text-xl font-semibold mb-4">BUD Support</h2>
      <div class="grid gap-2">
        {#each buds as bud}
          <div class="flex items-center justify-between px-4 py-2.5 border border-zinc-800 rounded-lg">
            <div class="flex items-center gap-3">
              <code class="text-xs font-mono text-zinc-500">BUD-{bud.id}</code>
              {#if bud.href}
                <a href={bud.href} onclick={(e) => { e.preventDefault(); navigate(bud.href); }} class="text-sm text-purple-400 hover:text-purple-300 underline underline-offset-2">{bud.name}</a>
              {:else}
                <span class="text-sm text-zinc-300">{bud.name}</span>
              {/if}
            </div>
            <span class="text-xs px-2 py-0.5 rounded-full border {statusBadge(bud.status)}">
              {bud.status}
            </span>
          </div>
        {/each}
      </div>
    </section>

    <!-- Pricing section -->
    {#if serverInfo?.payment}
      <section>
        <h2 class="text-xl font-semibold mb-4">Pricing</h2>
        {#if serverInfo.payment.fixedAmounts}
          <div class="border border-zinc-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-zinc-800 text-zinc-500 text-left">
                  <th class="px-4 py-2.5 font-medium">Action</th>
                  <th class="px-4 py-2.5 font-medium">Amount (sats)</th>
                </tr>
              </thead>
              <tbody>
                <tr class="border-b border-zinc-800/50">
                  <td class="px-4 py-2.5 text-zinc-300">Upload</td>
                  <td class="px-4 py-2.5 font-mono text-sm text-zinc-400">
                    {serverInfo.payment.amounts.upload === 0 ? "Free" : serverInfo.payment.amounts.upload.toLocaleString()}
                  </td>
                </tr>
                <tr class="border-b border-zinc-800/50">
                  <td class="px-4 py-2.5 text-zinc-300">Mirror</td>
                  <td class="px-4 py-2.5 font-mono text-sm text-zinc-400">
                    {serverInfo.payment.amounts.mirror === 0 ? "Free" : serverInfo.payment.amounts.mirror.toLocaleString()}
                  </td>
                </tr>
                <tr>
                  <td class="px-4 py-2.5 text-zinc-300">Delete</td>
                  <td class="px-4 py-2.5 font-mono text-sm text-zinc-400">Free</td>
                </tr>
              </tbody>
            </table>
          </div>
        {:else if serverInfo.payment.pricing}
          <div class="border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400 space-y-2">
            <p>Pricing is calculated dynamically based on file size:</p>
            <div class="font-mono text-xs bg-zinc-900 rounded px-3 py-2 text-zinc-300">
              cost = fileSize_GB × ${serverInfo.payment.pricing.cost_per_gb_usd}/GB × (1 + {(serverInfo.payment.pricing.profit_margin_pct * 100).toFixed(0)}% margin) × (1 + {(serverInfo.payment.pricing.slippage_premium_pct * 100).toFixed(0)}% slippage)
            </div>
            <p class="text-xs text-zinc-500">Final amount in sats is computed using the current BTC/USD rate. Minimum: 1 sat.</p>
          </div>
        {/if}
      </section>

      <!-- Accepted Mints -->
      {#if serverInfo.payment.mints.length > 0}
        <section>
          <h2 class="text-xl font-semibold mb-4">Accepted Mints</h2>
          <div class="border border-zinc-800 rounded-lg overflow-hidden">
            <div class="divide-y divide-zinc-800/50">
              {#each serverInfo.payment.mints as mint}
                <div class="px-4 py-2.5">
                  <a href={mint} target="_blank" rel="noopener" class="font-mono text-xs text-purple-400 hover:text-purple-300 underline underline-offset-2">
                    {mint}
                  </a>
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/if}
    {/if}

    <section>
      <h2 class="text-xl font-semibold mb-4">Authentication</h2>
      <div class="border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400 space-y-2">
        <p>
          Authenticated via <strong class="text-zinc-300">Nostr kind 24242</strong> events using schnorr signatures (secp256k1).
        </p>
        <p>
          Pass auth as <code class="text-xs bg-zinc-800 px-1.5 py-0.5 rounded">Authorization: Nostr &lt;base64-event&gt;</code>
        </p>
      </div>
    </section>

    <section>
      <h2 class="text-xl font-semibold mb-4">Quick Start</h2>
      <div class="border border-zinc-800 rounded-lg overflow-hidden">
        <div class="px-4 py-2 bg-zinc-900 text-xs text-zinc-500 border-b border-zinc-800">
          Check if a blob exists
        </div>
        <pre class="px-4 py-3 text-sm font-mono text-zinc-300 overflow-x-auto"><code>curl -I {SERVER_URL}/&lt;sha256&gt;</code></pre>
      </div>
      <div class="border border-zinc-800 rounded-lg overflow-hidden mt-3">
        <div class="px-4 py-2 bg-zinc-900 text-xs text-zinc-500 border-b border-zinc-800">
          Retrieve a blob
        </div>
        <pre class="px-4 py-3 text-sm font-mono text-zinc-300 overflow-x-auto"><code>curl {SERVER_URL}/&lt;sha256&gt; -o file.bin</code></pre>
      </div>
    </section>

  {/if}
  </main>

  <footer class="border-t border-zinc-800 mt-12">
    <div class="max-w-3xl mx-auto px-6 py-6 flex items-center justify-between text-xs text-zinc-600">
      <span>blssm.us — <a href="https://github.com/sandwichfarm/blssm.us" target="_blank" rel="noopener" class="hover:text-zinc-400 underline underline-offset-2">git</a></span>
      <div class="flex items-center gap-4">
        <a href="/admin" onclick={(e) => { e.preventDefault(); navigate("/admin"); }} class="hover:text-zinc-400">Administration</a>
        <a href="/report" onclick={(e) => { e.preventDefault(); navigate("/report"); }} class="hover:text-zinc-400">Report Content</a>
        <a href="https://github.com/hzrd149/blossom" target="_blank" rel="noopener" class="hover:text-zinc-400">
          Blossom Protocol
        </a>
      </div>
    </div>
  </footer>
</div>
