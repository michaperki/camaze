const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const price = value => `$${value.toFixed(2)}`;
const stamp = value => value ? new Date(value).toLocaleString(undefined, { timeZone: "UTC" }) + " UTC" : "Not provided";
function sourceLink(url, label) {
  if (!url || !/^https:\/\//.test(url)) return escapeHtml(label) + " (fictional example)";
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}
function renderInsights(data) {
  const status = document.getElementById("status");
  status.className = data.sample ? "sample" : "";
  let message = data.sample ? "Sample examples: all models, scores, prices and usage below are fictional. They do not affect your spending totals." :
    data.observedModels === 0 ? "No recorded usage in this period. Connect a provider in Integrations, or view Sample examples." :
    data.insights.length ? `${data.insights.length} candidate${data.insights.length === 1 ? "" : "s"} to evaluate. These are general comparisons, not personalized savings estimates.` :
    "No comparison available for your recorded models. This does not mean your current models are optimal.";
  if (!data.sample && data.source.status !== "ok") message += " Benchmark source " + ({ error: "refresh failed; the last successful snapshot is retained.", unavailable: "is unavailable. Shared storage may need setup.", pending: "is awaiting its first refresh.", refreshing: "refresh is in progress; the previous snapshot is retained." }[data.source.status] || "is unavailable.");
  if (!data.sample && data.source.ageDays > 7) message += " The benchmark snapshot is older than 7 days; comparisons are paused.";
  status.textContent = message;
  document.getElementById("period").textContent = `${data.sample ? "Example" : "Recorded usage"} window: ${data.period.start} to ${data.period.end} (end exclusive, UTC).` + (data.source.fetchedAt ? ` Benchmark snapshot: ${stamp(data.source.fetchedAt)}.` : "");
  document.getElementById("insights").innerHTML = data.insights.map(item => {
    const { current: a, candidate: b, benchmark: bm, usage } = item;
    const scoreLabel = estimated => data.sample ? "" : estimated === true ? "<br><small>Estimated by Artificial Analysis</small>" : estimated === false ? "" : "<br><small>Measurement status unavailable</small>";
    return `<article class="insight">
      <div class="insight-top"><span class="eyebrow">${escapeHtml(a.provider.toUpperCase())} &middot; ${data.sample ? "FICTIONAL SAMPLE" : "SAME-PROVIDER COMPARISON"}</span>
      <div class="model-pair"><div><p>You used</p><h2>${escapeHtml(a.name)}</h2></div><span class="arrow" aria-hidden="true">&rarr;</span><div><p class="candidate">Worth evaluating</p><h2>${escapeHtml(b.name)}</h2></div></div></div>
      <div class="metric-grid"><span></span><span>Current model</span><span>Candidate</span>
        <span>${data.sample ? "Example index" : "AA Intelligence Index"} (${escapeHtml(bm.version)})</span><strong>${bm.current.toFixed(1)}${scoreLabel(bm.currentEstimated)}</strong><strong class="candidate">${bm.candidate.toFixed(1)}${scoreLabel(bm.candidateEstimated)}</strong>
        <span>Input / 1M tokens</span><strong>${price(a.input)}</strong><strong class="candidate">${price(b.input)}</strong>
        <span>Output / 1M tokens</span><strong>${price(a.output)}</strong><strong class="candidate">${price(b.output)}</strong></div>
      <p class="reason">Higher ${data.sample ? "example" : "AA Intelligence Index"} score. Neither published token rate is higher, and at least one is lower. It may be worth evaluating on your own tasks.</p>
      <details><summary>Evidence, freshness &amp; limitations</summary>
        <p>Observed ${escapeHtml(usage.firstSeen)} through ${escapeHtml(usage.lastSeen)}. Exact identifiers: ${escapeHtml(a.id)} &rarr; ${escapeHtml(b.id)}.</p>
        <p>${sourceLink(bm.currentSource, "Current benchmark")} &middot; ${sourceLink(bm.candidateSource, "Candidate benchmark")}<br>Snapshot fetched: ${data.sample ? "Fictional sample" : stamp(item.fetchedAt)}. Evaluation observation dates: ${stamp(bm.observedAt)} / ${stamp(bm.candidateObservedAt)}.</p>
        <p>${sourceLink(a.pricingSource, "Current provider pricing")} &middot; ${sourceLink(b.pricingSource, "Candidate provider pricing")}<br>Provider metadata reviewed: ${data.sample ? "Fictional sample" : stamp(b.reviewedAt)}.</p>
        <ul><li>Standard published USD text-token rates. Discounts, cached tokens, batch pricing, tool charges and taxes are excluded.</li>
        <li>Billing data does not establish your context, modality, tool or reasoning requirements. Compare behavior, output quality and latency before switching.</li>
        <li>Known context capacity: ${a.context.toLocaleString()} &rarr; ${b.context.toLocaleString()} tokens. Text and tool support checked; application compatibility is unverified.</li>
        <li>A higher benchmark score does not guarantee better results. Token counts and completed-task cost may change. No personal savings are calculated.</li></ul>
        ${data.sample ? "" : '<p>Source: <a href="https://artificialanalysis.ai/">Artificial Analysis</a>. Recommendation by Camaze; no endorsement implied.</p>'}
      </details></article>`;
  }).join("");
  const coverage = [...data.unsupported.map(r => ({ ...r, reason: "Exact model or version unsupported" })), ...data.excluded];
  document.getElementById("coverage").innerHTML = coverage.length ? `<details open><summary>Models without a comparison (${coverage.length})</summary><ul>${coverage.map(r => `<li><strong>${escapeHtml(r.model)}</strong> (${escapeHtml(r.provider)}): ${escapeHtml(r.reason)}</li>`).join("")}</ul></details>` : "";
}
(async () => {
  const status = document.getElementById("status");
  try {
    const config = await fetch("/api/config").then(r => r.json());
    const client = supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    const { data: { session } } = await client.auth.getSession();
    if (!session) { location.replace("/login.html"); return; }
    document.getElementById("user-email").textContent = session.user.email || "";
    document.getElementById("header-right").style.visibility = "visible";
    document.getElementById("signout-btn").onclick = async () => { await client.auth.signOut(); location.replace("/login.html"); };
    let requestNumber = 0;
    async function load() {
      const number = ++requestNumber;
      const sample = document.querySelector('input[name="view"]:checked').value === "sample";
      status.className = sample ? "sample" : "";
      status.textContent = sample ? "Loading fictional sample examples..." : "Loading recorded usage...";
      document.getElementById("insights").innerHTML = "";
      document.getElementById("coverage").innerHTML = "";
      document.getElementById("period").textContent = "";
      try {
        const { data: { session: currentSession } } = await client.auth.getSession();
        const response = await fetch(`/api/insights${sample ? "?sample=1" : ""}`, { headers: { Authorization: `Bearer ${currentSession?.access_token || ""}` }, signal: AbortSignal.timeout(30000) });
        if (response.status === 401) { location.replace("/login.html"); return; }
        if (!response.ok) throw new Error("Insights could not be loaded. Refresh to retry, or view Sample examples.");
        const data = await response.json();
        if (number === requestNumber) renderInsights(data);
      } catch (error) { if (number === requestNumber) status.textContent = error.message; }
    }
    document.querySelectorAll('input[name="view"]').forEach(input => input.addEventListener("change", load));
    await load();
  } catch { status.textContent = "Sign-in could not be loaded. Refresh to try again."; }
})();
