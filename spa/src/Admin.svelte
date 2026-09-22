<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { ISigner } from 'applesauce-signers';
  import { ExtensionSigner, NostrConnectSigner } from 'applesauce-signers';
  import { SimplePool } from 'nostr-tools/pool';
  import type { NostrEvent } from 'nostr-tools';
  import { Observable, merge } from 'rxjs';
  import { ADMIN_PUBKEY, adminRequest, parseTrustedReporters, reportView, type Report, type ReportPage, type ModerationPolicy } from './admin-api';

  const origin = window.location.origin;
  const columns = [
    ['receivedAt', 'Received'], ['sha256', 'Blob'], ['category', 'Category'],
    ['pubkey', 'Reporter'], ['pow', 'PoW'], ['status', 'Status'],
  ];
  let signer: ISigner | null = null;
  let remote: NostrConnectSigner | null = null;
  let pool: SimplePool | null = null;
  let controller = new AbortController();
  let epoch = 0;
  let connected = $state(false);
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let bunker = $state('');
  let data = $state<ReportPage | null>(null);
  let allReports: Report[] = [];
  let livePolicy: ModerationPolicy | null = null;
  let progress = $state('');
  let status = $state('all');
  let query = $state('');
  let sort = $state('receivedAt');
  let order = $state('desc');
  let page = $state(1);
  let pageSize = $state(25);
  let mode = $state<ModerationPolicy['mode']>('manual');
  let trusted = $state('');
  let selected = $state<Report | null>(null);
  let reason = $state('');
  let directHash = $state('');
  let directReason = $state('');
  let protectDirect = $state(true);
  const pages = $derived(Math.max(1, Math.ceil((data?.total ?? 0) / pageSize)));
  const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-6)}`;
  const message = (e: unknown) => e instanceof Error ? e.message : 'Request failed.';

  async function request<T>(path: string, method = 'GET', body?: unknown) {
    if (!signer) throw new Error('Sign in to continue.');
    return adminRequest<T>(signer, origin, path, method, body, controller.signal);
  }

  async function loadReports(resetPolicy = false) {
    const current = epoch;
    const collected = new Map<string, Report>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let nextPolicy: ModerationPolicy | null = null;
    let batches = 0;
    do {
      if (current !== epoch) return;
      progress = `Loading reports: ${collected.size} found · ${batches} batches complete. Statistics update after the full scan.`;
      const next: ReportPage = await request<ReportPage>(`/admin/reports${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (current !== epoch) return;
      for (const report of next.reports) collected.set(report.id, report);
      nextPolicy = next.policy;
      batches++;
      cursor = next.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) throw new Error('The server repeated a report cursor. Refresh to retry the scan.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    allReports = [...collected.values()];
    livePolicy = nextPolicy;
    if (selected) selected = allReports.find(report => report.id === selected?.id) ?? null;
    applyView();
    if (resetPolicy && livePolicy) { mode = livePolicy.mode; trusted = livePolicy.trustedReporters.join('\n'); }
    progress = '';
  }

  function applyView() {
    if (!livePolicy) return;
    data = reportView(allReports, livePolicy, { status, query, sort, order, page, pageSize });
    page = data.page;
  }

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    const current = epoch;
    busy = true; error = ''; notice = '';
    try { await action(); }
    catch (e) { if (current === epoch) error = message(e); }
    finally { if (current === epoch) { busy = false; progress = ''; } }
  }

  async function login(type: 'extension' | 'remote') {
    await perform(async () => {
      const current = epoch;
      try {
        if (type === 'extension') signer = new ExtensionSigner();
        else {
          pool = new SimplePool();
          const relayPool = pool;
          const pendingRemote = await NostrConnectSigner.fromBunkerURI(bunker.trim(), {
            pool: {
              subscription(relays, filters) {
                return merge(...filters.map(filter => new Observable<NostrEvent>(observer => {
                  const subscription = relayPool.subscribeMany(relays, filter, {
                    onevent(event) { observer.next(event); },
                    oneose() {}, onclose() { observer.complete(); },
                  });
                  return () => subscription.close();
                })));
              },
              publish(relays: string[], event: any) { return Promise.all(relayPool.publish(relays, event)); },
            },
          });
          if (current !== epoch) { pendingRemote.close(); return; }
          remote = pendingRemote;
          await pendingRemote.open();
          await pendingRemote.connect();
          if (current !== epoch) { pendingRemote.close(); return; }
          signer = pendingRemote;
        }
        const session = await request<{ pubkey: string }>('/admin/session');
        if (current !== epoch) return;
        if (session.pubkey !== ADMIN_PUBKEY) throw new Error('The server did not authorize this account.');
        connected = true;
        bunker = '';
        await loadReports(true);
      } catch (e) {
        if (current === epoch && !connected) {
          remote?.close(); pool?.destroy(); remote = null; pool = null; signer = null;
        }
        throw e;
      }
    });
  }

  function logout() {
    epoch++; controller.abort(); controller = new AbortController();
    remote?.close(); pool?.destroy(); remote = null; pool = null; signer = null;
    connected = false; busy = false; data = null; selected = null;
    allReports = []; livePolicy = null; progress = '';
    bunker = ''; trusted = ''; query = ''; reason = ''; directHash = ''; directReason = '';
    error = ''; notice = '';
  }
  onDestroy(logout);

  function refresh(resetPage = false) {
    if (resetPage) page = 1;
    applyView();
  }
  function sortBy(column: string) {
    order = sort === column && order === 'desc' ? 'asc' : 'desc';
    sort = column; return refresh(true);
  }
  async function savePolicy() {
    await perform(async () => {
      await request('/admin/moderation', 'PUT', { mode, trustedReporters: parseTrustedReporters(trusted) });
      await loadReports(true);
      notice = 'Automation policy saved.';
    });
  }
  async function processPending() {
    await perform(async () => {
      const current = epoch;
      const totals = { processed: 0, blocked: 0, skipped: 0, failed: 0 };
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        if (current !== epoch) return;
        progress = `Applying saved policy: ${totals.processed} processed, ${totals.blocked} blocked, ${totals.failed} failed.`;
        const result: typeof totals & { nextCursor?: string | null } = await request('/admin/moderation/process', 'POST', cursor ? { cursor } : {});
        if (current !== epoch) return;
        for (const key of ['processed', 'blocked', 'skipped', 'failed'] as const) totals[key] += result[key];
        cursor = result.nextCursor ?? null;
        if (cursor && cursors.has(cursor)) throw new Error('The server repeated a processing cursor. Refresh before retrying.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      await loadReports();
      notice = `Processed ${totals.processed}: ${totals.blocked} blocked, ${totals.skipped} skipped, ${totals.failed} failed.`;
    });
  }
  async function setHash(hash: string, blocked: boolean, automationProtected: boolean, actionReason: string) {
    await perform(async () => {
      const normalized = hash.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error('Enter a valid 64-character SHA-256 hash.');
      await request(`/admin/hashes/${normalized}`, 'PUT', { blocked, automationProtected, reason: actionReason });
      await loadReports();
      notice = `${short(normalized)} ${blocked ? 'blocked' : 'allowed'}${automationProtected ? ' and protected from automation' : ''}.`;
    });
  }
  async function setReport(nextStatus: string) {
    if (!selected) return;
    const id = selected.id;
    const sha256 = selected.sha256;
    await perform(async () => {
      await request(`/admin/reports/${encodeURIComponent(id)}`, 'PUT', { sha256, status: nextStatus, reason });
      await loadReports();
      notice = nextStatus === 'pending' ? 'Report reopened.' : 'Report dismissed.';
    });
  }
</script>

<section class="console" aria-label="Moderation administration">
  <header class="console-heading">
    <div><p class="eyebrow">blssm.us / administration</p><h1>Moderation desk</h1><p class="muted">Review reports. Control access. Keep every decision reversible.</p></div>
    {#if connected}<div class="account"><span class="signed-in">● Signed in</span><code title={ADMIN_PUBKEY}>{short(ADMIN_PUBKEY)}</code><button onclick={logout}>Sign out</button></div>{/if}
  </header>

  {#if error}<div class="feedback failure" role="alert">{error}</div>{/if}
  {#if notice}<div class="feedback success" role="status">{notice}</div>{/if}
  {#if busy}<p class="working" role="status">{progress || 'Waiting for signature or server response…'}</p>{/if}

  {#if !connected}
    <div class="login panel">
      <p class="eyebrow">Restricted access</p><h2>Sign in with Nostr</h2>
      <p class="muted">Use the administrator account in your browser extension or remote signer. Each request requires a signature.</p>
      <p class="key-label">Authorized public key</p><code class="full-key">{ADMIN_PUBKEY}</code>
      <button class="primary" disabled={busy} onclick={() => login('extension')}>Connect browser extension</button>
      <div class="divider">or use a remote signer</div>
      <form onsubmit={(event) => { event.preventDefault(); login('remote'); }}>
        <label for="bunker-uri">Bunker URI</label><input id="bunker-uri" type="password" bind:value={bunker} placeholder="bunker://…" autocomplete="off" disabled={busy} />
        <button disabled={busy || !bunker.trim()}>Connect remote signer</button>
      </form>
      {#if busy}<button onclick={logout}>Cancel connection</button>{/if}
    </div>
  {:else}
    {#if data}
      <div class="stats" aria-label="Report statistics">
        {#each [['Reports', data.stats.total], ['Pending', data.stats.pending], ['Blocked', data.stats.blocked], ['Allowed', data.stats.allowed], ['Dismissed', data.stats.dismissed], ['Unique blobs', data.stats.uniqueHashes], ['Protected blobs', data.stats.protectedHashes], ['Average PoW', `${Number(data.stats.averagePow).toFixed(1)} bits`]] as [label, value]}
          <div class="stat"><span>{label}</span><strong>{value}</strong></div>
        {/each}
      </div>
    {/if}

    <div class="settings-grid">
      <section class="panel" aria-labelledby="policy-title">
        <div class="panel-heading"><h2 id="policy-title">Automation</h2><span class="badge">Live: {data?.policy.mode ?? 'unknown'}</span></div>
        <form onsubmit={(event) => { event.preventDefault(); savePolicy(); }}>
          <label for="moderation-mode">New report handling</label>
          <select id="moderation-mode" bind:value={mode} disabled={busy}>
            <option value="manual">Manual review only</option><option value="trusted">Automatically block trusted reporters' hashes</option><option value="all">Automatically block all reported hashes</option>
          </select>
          <p class="help">{mode === 'manual' ? 'Reports wait for your decision.' : mode === 'trusted' ? 'Only reports signed by a listed reporter can trigger a block.' : 'Every accepted report can block a blob. Proof of work does not establish whether a report is correct.'} Protected hashes remain exempt.</p>
          <label for="trusted-reporters">Trusted reporters · npub or hex</label>
          <textarea id="trusted-reporters" bind:value={trusted} rows="3" placeholder="One public key per line" disabled={busy}></textarea>
          <div class="actions"><button class="primary" disabled={busy}>Save policy</button><button type="button" disabled={busy || !data || data.policy.mode === 'manual'} onclick={processPending}>Apply saved policy to pending</button></div>
        </form>
      </section>
      <section class="panel" aria-labelledby="hash-title">
        <h2 id="hash-title">Direct hash control</h2><p class="help">Block or restore access to any hash, including those without reports. Blob data is retained.</p>
        <label for="direct-hash">SHA-256 hash</label><input id="direct-hash" bind:value={directHash} placeholder="64-character hash" class="mono" disabled={busy} />
        <label for="direct-reason">Decision note</label><input id="direct-reason" bind:value={directReason} placeholder="Reason for this decision" disabled={busy} />
        <label class="checkbox"><input type="checkbox" bind:checked={protectDirect} disabled={busy} /> Protect this hash from automation</label>
        <div class="actions"><button class="danger" disabled={busy || !directHash.trim()} onclick={() => setHash(directHash, true, protectDirect, directReason)}>Block hash</button><button disabled={busy || !directHash.trim()} onclick={() => setHash(directHash, false, protectDirect, directReason)}>Allow hash</button></div>
      </section>
    </div>

    <section class="panel inbox" aria-labelledby="reports-title">
      <div class="panel-heading"><h2 id="reports-title">Report inbox <span class="muted">{data?.total ?? '—'}</span></h2><button disabled={busy} onclick={() => perform(() => loadReports())}>Refresh</button></div>
      <form class="filters" onsubmit={(event) => { event.preventDefault(); refresh(true); }}>
        <div class="search"><label for="report-query">Search reports</label><input id="report-query" bind:value={query} placeholder="Hash, reporter or report text" disabled={busy} /></div>
        <div><label for="status-filter">Status</label><select id="status-filter" bind:value={status} disabled={busy} onchange={() => refresh(true)}><option value="all">All reports</option><option value="pending">Pending</option><option value="blocked">Blocked</option><option value="dismissed">Dismissed</option><option value="allowed">Allowed</option></select></div>
        <button disabled={busy}>Search</button>
      </form>
      <div class="table-scroll">
        <table>
          <thead><tr>{#each columns as [key, label]}<th aria-sort={sort === key ? order === 'asc' ? 'ascending' : 'descending' : 'none'}><button disabled={busy} onclick={() => sortBy(key)}>{label}<span class:active-sort={sort === key}>{sort === key ? order === 'asc' ? ' ↑' : ' ↓' : ' ↕'}</span></button></th>{/each}<th><span class="sr-only">Details</span></th></tr></thead>
          <tbody>
            {#each data?.reports ?? [] as report (report.id)}
              <tr class:selected={selected?.id === report.id}>
                <td class="received">{new Date(report.receivedAt).toLocaleString()}</td>
                <td><button class="text-button mono" onclick={() => { selected = report; reason = ''; }} title={report.sha256}>{short(report.sha256)}</button>{#if report.automationProtected}<span class="protected" title="Exempt from automated blocking">Protected</span>{/if}</td>
                <td>{report.category}</td><td><code title={report.event.pubkey}>{short(report.event.pubkey)}</code></td>
                <td class="pow"><strong>{report.pow}</strong><span> bits</span></td><td><span class="badge" class:blocked={report.blocked}>{report.status}</span>{#if report.automationError}<span class="retry">Retry needed</span>{/if}</td>
                <td><button aria-label={`Review report ${report.id}`} onclick={() => { selected = report; reason = ''; }}>Review</button></td>
              </tr>
            {:else}<tr><td colspan="7" class="empty">{busy ? 'Loading reports…' : 'No reports match this view.'}</td></tr>{/each}
          </tbody>
        </table>
      </div>
      <div class="pagination"><span>Page {page} of {pages} · {data?.total ?? 0} results</span><div class="actions"><label for="page-size" class="sr-only">Rows per page</label><select id="page-size" bind:value={pageSize} disabled={busy} onchange={() => refresh(true)}><option value={25}>25 / page</option><option value={50}>50 / page</option><option value={100}>100 / page</option></select><button disabled={busy || page <= 1} onclick={() => { page--; refresh(); }}>Previous</button><button disabled={busy || page >= pages} onclick={() => { page++; refresh(); }}>Next</button></div></div>
    </section>

    {#if selected}
      <section class="panel detail" aria-labelledby="detail-title">
        <div class="panel-heading"><h2 id="detail-title">Report detail</h2><button onclick={() => selected = null}>Close details</button></div>
        {#if selected.automationError}<p class="feedback failure">The automated action did not finish. Apply the saved policy to pending reports to retry, or make a manual decision below.</p>{/if}
        <div class="detail-grid">
          <div><p class="field-label">Blob hash</p><code class="full-key">{selected.sha256}</code><a class="content-link" href={`/${selected.sha256}`} target="_blank" rel="noopener noreferrer">Open blob in a new tab ↗</a></div>
          <div><p class="field-label">Reporter</p><code class="full-key">{selected.event.pubkey}</code></div>
          <div><p class="field-label">Category / proof of work</p><p>{selected.category} · {selected.pow} bits</p></div><div><p class="field-label">Decision</p><p>{selected.status} · {selected.blocked ? 'Access blocked' : 'Access allowed'} · {selected.source ?? 'No decision source'}</p></div>
        </div>
        <p class="field-label">Report text</p><p class="report-content">{selected.event.content || 'No description provided.'}</p>
        <label for="decision-reason">Decision note</label><input id="decision-reason" bind:value={reason} placeholder="Reason for this decision" disabled={busy} />
        <div class="actions decision-actions">
          {#if selected.blocked}<button class="primary" disabled={busy} onclick={() => selected && setHash(selected.sha256, false, true, reason)}>Unblock & protect</button>{:else}<button class="danger" disabled={busy} onclick={() => selected && setHash(selected.sha256, true, selected.automationProtected, reason)}>Block hash</button>{/if}
          <button disabled={busy} onclick={() => selected && setHash(selected.sha256, selected.blocked, !selected.automationProtected, reason)}>{selected.automationProtected ? 'Remove automation protection' : 'Protect from automation'}</button>
          <button disabled={busy} onclick={() => setReport(selected?.status === 'dismissed' ? 'pending' : 'dismissed')}>{selected.status === 'dismissed' ? 'Reopen report' : 'Dismiss report'}</button>
        </div>
        <p class="help">Unblocking protects this hash from future automated blocks. Dismissing a report does not change blob access.</p>
        <details><summary>Signed event</summary><pre>{JSON.stringify(selected.event, null, 2)}</pre></details>
      </section>
    {/if}
  {/if}
</section>

<style>
  .console { color: #e4e4e7; font-size: 14px; }
  .console-heading,.panel-heading,.pagination,.account,.actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .console-heading { margin-bottom: 28px; align-items: flex-start; }
  h1 { font-size: clamp(26px, 3vw, 36px); font-weight: 650; letter-spacing: -.04em; line-height: 1.2; margin: 5px 0 9px; }
  h2 { font-size: 17px; font-weight: 600; letter-spacing: -.02em; margin: 0 0 12px; }
  .panel-heading h2 { margin: 0; }.panel-heading { margin-bottom: 18px; }
  .eyebrow { font-size: 10px; text-transform: uppercase; letter-spacing: .16em; color: #c084fc; font-weight: 600; }
  .muted,.help,.key-label { color: #a1a1aa; }.help { font-size: 12px; line-height: 1.6; margin: 8px 0 16px; }
  .account { flex-wrap: wrap; justify-content: flex-end; font-size: 11px; max-width: 270px; }.signed-in { color: #6ee7b7; }
  .panel { border: 1px solid #27272a; border-radius: 10px; padding: 22px; background: #0d0d10; }
  .login { max-width: 530px; margin: 40px auto; padding: 30px; }.login h2 { font-size: 23px; margin: 10px 0; }.login .muted { line-height: 1.7; }.key-label { margin-top: 25px; font-size: 11px; }.full-key { display: block; overflow-wrap: anywhere; font-size: 12px; line-height: 1.7; }.login .full-key { margin: 7px 0 24px; }.login button { width: 100%; margin-top: 12px; }
  .divider { border-top: 1px solid #27272a; margin: 28px 0 16px; padding-top: 20px; text-align: center; color: #71717a; font-size: 11px; }
  button,input,textarea,select { font: inherit; border-radius: 5px; border: 1px solid #3f3f46; }
  button { cursor: pointer; background: #18181b; color: #e4e4e7; padding: 8px 12px; font-size: 12px; white-space: nowrap; transition: background 120ms; }
  button:hover:not(:disabled) { background: #27272a; border-color: #71717a; }button:disabled { opacity: .42; cursor: not-allowed; }
  button.primary { background: #9333ea; border-color: #a855f7; color: white; }button.primary:hover:not(:disabled) { background: #a855f7; }.danger { border-color: #7f1d1d; color: #fca5a5; background: #251214; }
  input,textarea,select { display: block; width: 100%; background: #18181b; color: #e4e4e7; padding: 9px 10px; }input::placeholder,textarea::placeholder { color: #71717a; }textarea { resize: vertical; min-height: 70px; }
  :is(button,input,textarea,select,a,summary):focus-visible { outline: 2px solid #c084fc; outline-offset: 3px; }
  label,.field-label { display: block; font-size: 11px; color: #a1a1aa; margin: 15px 0 6px; }.checkbox { display: flex; align-items: center; gap: 9px; font-size: 12px; margin: 18px 0; }.checkbox input { width: 15px; height: 15px; accent-color: #a855f7; }
  .stats { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); border: 1px solid #27272a; border-radius: 8px; margin-bottom: 24px; overflow: hidden; }.stat { padding: 15px; border-right: 1px solid #27272a; }.stat:last-child { border: 0; }.stat span { display: block; color: #a1a1aa; font-size: 10px; white-space: nowrap; }.stat strong { display: block; margin-top: 9px; font-size: 23px; font-weight: 550; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
  .settings-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 20px; margin-bottom: 24px; }.actions { justify-content: flex-start; flex-wrap: wrap; }.settings-grid .actions { margin-top: 18px; }
  .badge { display: inline-block; padding: 3px 7px; border: 1px solid #3f3f46; border-radius: 4px; color: #c4b5fd; font-size: 10px; white-space: nowrap; }.badge.blocked { border-color: #7f1d1d; color: #fca5a5; }.retry { display: block; color: #fbbf24; font-size: 10px; margin-top: 5px; }.protected { display: block; color: #6ee7b7; font-size: 9px; margin-top: 5px; }
  .filters { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 20px; }.search { flex: 1; }.filters label { margin-top: 0; }.table-scroll { position: relative; overflow-x: auto; margin: 0 -22px; }table { border-collapse: collapse; width: 100%; text-align: left; font-size: 12px; }th { background: #151518; border-top: 1px solid #27272a; border-bottom: 1px solid #27272a; padding: 8px 12px; font-weight: 400; white-space: nowrap; }th:first-child,td:first-child { padding-left: 22px; }th button { border: 0; padding: 2px 0; color: #a1a1aa; background: transparent; }th button span { color: #52525b; }th button .active-sort { color: #c084fc; }td { padding: 15px 12px; border-bottom: 1px solid #222225; }tr.selected { background: #a855f70c; }td:last-child { padding-right: 22px; }.received { max-width: 155px; font-size: 11px; color: #a1a1aa; font-variant-numeric: tabular-nums; }.mono,code { font-family: ui-monospace, monospace; }.text-button { border: 0; padding: 0; color: #d8b4fe; background: transparent; }.pow { font-variant-numeric: tabular-nums; white-space: nowrap; }.pow span { color: #71717a; font-size: 10px; }.empty { text-align: center; padding: 45px; color: #71717a; }.pagination { margin-top: 18px; font-size: 11px; color: #a1a1aa; }.pagination select { width: auto; font-size: 11px; }
  .detail { margin-top: 24px; border-color: #6b21a8; }.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 30px; }.detail-grid .field-label { margin-top: 8px; }.content-link { display: inline-block; margin-top: 7px; color: #c084fc; font-size: 11px; }.report-content { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #27272a; background: #18181b; padding: 14px; border-radius: 5px; }.decision-actions { margin-top: 18px; }details { border-top: 1px solid #27272a; padding-top: 12px; color: #a1a1aa; font-size: 12px; }summary { cursor: pointer; }pre { font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 12px; }
  .feedback { border: 1px solid; border-radius: 6px; padding: 12px 15px; margin-bottom: 18px; overflow-wrap: anywhere; }.failure { border-color: #7f1d1d; background: #251214; color: #fca5a5; }.success { border-color: #065f46; background: #022c2222; color: #6ee7b7; }.working { color: #c084fc; margin-bottom: 15px; font-size: 12px; }
  @media(max-width: 1050px) { .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }.stat:nth-child(-n+4) { border-bottom: 1px solid #27272a; }.stat:nth-child(4) { border-right: 0; } }
  @media(max-width: 700px) { .console-heading { flex-direction: column; gap: 20px; }.account { max-width: none; }.settings-grid,.detail-grid { grid-template-columns: 1fr; }.panel { padding: 16px; }.table-scroll { margin: 0 -16px; }.filters { flex-wrap: wrap; }.search { flex-basis: 100%; }.pagination { align-items: flex-start; flex-direction: column; }.stat { padding: 11px 8px; }.stat strong { font-size: 19px; }.stat span { font-size: 9px; }.login { padding: 22px; margin-top: 10px; }.actions button { white-space: normal; } }
</style>
