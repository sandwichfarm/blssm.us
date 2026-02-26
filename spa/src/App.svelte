<script lang="ts">
  import { onMount } from "svelte";

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

  let loading = $state(true);
  let error = $state<string | null>(null);
  let serverInfo = $state<ServerInfo | null>(null);

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
      { id: "09", name: "Content Reporting", status: "full" },
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

  onMount(async () => {
    try {
      const res = await fetch("/server-info");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      serverInfo = await res.json();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load server info";
    } finally {
      loading = false;
    }
  });
</script>

<div class="min-h-screen bg-zinc-950 text-zinc-100">
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

  <main class="max-w-3xl mx-auto px-6 py-12 space-y-12">
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
              <span class="text-sm text-zinc-300">{bud.name}</span>
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
  </main>

  <footer class="border-t border-zinc-800 mt-12">
    <div class="max-w-3xl mx-auto px-6 py-6 flex items-center justify-between text-xs text-zinc-600">
      <span>blssm.us</span>
      <a href="https://github.com/hzrd149/blossom" target="_blank" rel="noopener" class="hover:text-zinc-400">
        Blossom Protocol
      </a>
    </div>
  </footer>
</div>
