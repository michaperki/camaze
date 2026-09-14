const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const price = value => `$${value.toFixed(2)}`;
const stamp = value => value ? new Date(value).toLocaleString(undefined, { timeZone: "UTC" }) + " UTC" : "Not provided";
function sourceLink(url, label) {
  if (!url || !/^https:\/\//.test(url)) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}
// "Higher benchmark score and ~67% lower published token pricing." — the
// dominance rule in lib/insights/rules.js already guarantees neither rate is
// higher and at least one is strictly lower, so this only has to describe
// which side(s) moved and by how much, never assert a direction that isn't true.
function reasonSentence(a, b) {
  const pct = (from, to) => Math.round(((from - to) / from) * 100);
  const inputPct = pct(a.input, b.input), outputPct = pct(a.output, b.output);
  let pricePhrase;
  if (inputPct === outputPct) pricePhrase = `~${inputPct}% lower published token pricing`;
  else if (inputPct === 0) pricePhrase = `the same input pricing and ~${outputPct}% lower output pricing`;
  else if (outputPct === 0) pricePhrase = `~${inputPct}% lower input pricing and the same output pricing`;
  else pricePhrase = `~${inputPct}% lower input pricing and ~${outputPct}% lower output pricing`;
  return `Higher benchmark score and ${pricePhrase}.`;
}
function renderInsights(data) {
  const status = document.getElementById("status");
  let message = data.observedModels === 0 ? "No recorded usage in this period. Connect a provider in Integrations if you haven't yet." :
    data.insights.length ? `${data.insights.length} candidate${data.insights.length === 1 ? "" : "s"} to evaluate.${data.insights.some(i => i.savings) ? "" : " These are general comparisons — a dollar estimate needs a token breakdown on your recorded usage, which isn't available yet for these."}` :
    "No comparison available for your recorded models. This does not mean your current models are optimal.";
  if (data.source.status !== "ok") message += " Benchmark source " + ({ error: "refresh failed; the last successful snapshot is retained.", unavailable: "is unavailable. Shared storage may need setup.", pending: "is awaiting its first refresh.", refreshing: "refresh is in progress; the previous snapshot is retained." }[data.source.status] || "is unavailable.");
  if (data.source.ageDays > 7) message += " The benchmark snapshot is older than 7 days; comparisons are paused.";
  status.textContent = message;
  document.getElementById("period").textContent = `Recorded usage window: ${data.period.start} to ${data.period.end} (end exclusive, UTC).` + (data.source.fetchedAt ? ` Benchmark snapshot: ${stamp(data.source.fetchedAt)}.` : "");
  document.getElementById("insights").innerHTML = data.insights.map(item => {
    const { current: a, candidate: b, benchmark: bm, usage, savings } = item;
    const scoreLabel = estimated => estimated === true ? "<br><small>Estimated by Artificial Analysis</small>" : estimated === false ? "" : "<br><small>Measurement status unavailable</small>";
    // Exact math on your own recorded token counts (see lib/insights/rules.js) —
    // only present when every contributing day had a token breakdown, so this
    // never guesses a split from a blended dollar total. Absent otherwise;
    // the qualitative reason sentence below stands on its own either way.
    const savingsBlock = savings ? `<div class="savings">
        <div class="savings-headline">Estimated savings: ${price(savings.savingsUsd)} (${savings.savingsPct.toFixed(0)}%)</div>
        <div class="savings-detail">Based on your observed usage: actual spend ${price(savings.actualCostUsd)} &rarr; estimated on ${escapeHtml(b.name)} ${price(savings.estimatedCandidateCostUsd)}.</div>
      </div>` : "";
    return `<article class="insight">
      <div class="insight-top"><span class="eyebrow">${escapeHtml(a.provider.toUpperCase())} &middot; SAME-PROVIDER COMPARISON</span>
      <div class="model-pair"><div><p>You used</p><h2>${escapeHtml(a.name)}</h2></div><span class="arrow" aria-hidden="true">&rarr;</span><div><p class="candidate">Worth evaluating</p><h2>${escapeHtml(b.name)}</h2></div></div></div>
      <div class="metric-grid"><span></span><span>Current model</span><span>Candidate</span>
        <span>AA Intelligence Index (${escapeHtml(bm.version)})</span><strong>${bm.current.toFixed(1)}${scoreLabel(bm.currentEstimated)}</strong><strong class="candidate">${bm.candidate.toFixed(1)}${scoreLabel(bm.candidateEstimated)}</strong>
        <span>Input / 1M tokens</span><strong>${price(a.input)}</strong><strong class="candidate">${price(b.input)}</strong>
        <span>Output / 1M tokens</span><strong>${price(a.output)}</strong><strong class="candidate">${price(b.output)}</strong></div>
      ${savingsBlock}
      <p class="reason">${reasonSentence(a, b)} It may be worth evaluating on your own tasks.</p>
      <details><summary>Evidence, freshness &amp; limitations</summary>
        <p>Observed ${escapeHtml(usage.firstSeen)} through ${escapeHtml(usage.lastSeen)}. Exact identifiers: ${escapeHtml(a.id)} &rarr; ${escapeHtml(b.id)}.</p>
        <p>${sourceLink(bm.currentSource, "Current benchmark")} &middot; ${sourceLink(bm.candidateSource, "Candidate benchmark")}<br>Snapshot fetched: ${stamp(item.fetchedAt)}. Evaluation observation dates: ${stamp(bm.observedAt)} / ${stamp(bm.candidateObservedAt)}.</p>
        <p>${sourceLink(a.pricingSource, "Current provider pricing")} &middot; ${sourceLink(b.pricingSource, "Candidate provider pricing")}<br>Provider metadata reviewed: ${stamp(b.reviewedAt)}.</p>
        <ul><li>Standard published USD text-token rates. Discounts, cached tokens, batch pricing, tool charges and taxes are excluded.</li>
        <li>Billing data does not establish your context, modality, tool or reasoning requirements. Compare behavior, output quality and latency before switching.</li>
        <li>Known context capacity: ${a.context.toLocaleString()} &rarr; ${b.context.toLocaleString()} tokens. Text and tool support checked; application compatibility is unverified.</li>
        <li>A higher benchmark score does not guarantee better results. Token counts and completed-task cost may change.${savings ? "" : " No personal savings are calculated for this comparison — your recorded usage doesn't have a token breakdown yet."}</li></ul>
        <p>Source: <a href="https://artificialanalysis.ai/">Artificial Analysis</a>. Recommendation by Camaze; no endorsement implied.</p>
      </details></article>`;
  }).join("");
  const coverage = [...data.unsupported.map(r => ({ ...r, reason: "Exact model or version unsupported" })), ...data.excluded];
  if (!coverage.length) {
    document.getElementById("coverage").innerHTML = "";
  } else {
    const groups = new Map();
    for (const r of coverage) {
      if (!groups.has(r.reason)) groups.set(r.reason, []);
      groups.get(r.reason).push(r);
    }
    const groupsHtml = [...groups].map(([reason, items]) =>
      `<p><strong>${escapeHtml(reason)} (${items.length})</strong></p><ul>${items.map(r => `<li>${escapeHtml(r.model)} (${escapeHtml(r.provider)})</li>`).join("")}</ul>`
    ).join("");
    document.getElementById("coverage").innerHTML = `<details><summary>${coverage.length} model${coverage.length === 1 ? "" : "s"} not evaluated</summary>${groupsHtml}</details>`;
  }
}
(async () => {
  const status = document.getElementById("status");
  try {
    const config = await window.camazeFetch("/api/config").then(r => r.json());
    const client = supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    const { data: { session } } = await client.auth.getSession();
    if (!session) { location.replace("/login.html"); return; }
    await window.initializeSimulation(session);
    document.getElementById("user-email").textContent = session.user.email || "";
    document.getElementById("header-right").style.visibility = "visible";
    document.getElementById("signout-btn").onclick = async () => { await client.auth.signOut(); location.replace("/login.html"); };
    status.textContent = "Loading recorded usage...";
    try {
      const response = await window.camazeFetch("/api/insights", { headers: { Authorization: `Bearer ${session.access_token || ""}` }, signal: AbortSignal.timeout(30000) });
      if (response.status === 401) { location.replace("/login.html"); return; }
      if (!response.ok) throw new Error("Insights could not be loaded. Refresh to retry.");
      const data = await response.json();
      renderInsights(data);
    } catch (error) { status.textContent = error.message; }
  } catch { status.textContent = "Sign-in could not be loaded. Refresh to try again."; }
})();
