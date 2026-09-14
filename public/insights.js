const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const price = value => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    data.insights.length ? `${data.insights.length} candidate${data.insights.length === 1 ? "" : "s"} to evaluate.${data.insights.some(i => i.savings) ? "" : " Dollar estimates require complete token counts and supported pricing assumptions."}` :
    "No comparison available for your recorded models. This does not mean your current models are optimal.";
  if (data.source.status !== "ok") message += " Benchmark source " + ({ error: "refresh failed; the last successful snapshot is retained.", unavailable: "is unavailable. Shared storage may need setup.", pending: "is awaiting its first refresh.", refreshing: "refresh is in progress; the previous snapshot is retained." }[data.source.status] || "is unavailable.");
  if (data.source.ageDays > 7) message += " The benchmark snapshot is older than 7 days; comparisons are paused.";
  if (data.source.coverage && !data.source.coverage.complete) message += ` Benchmark coverage is incomplete (${data.source.coverage.matched}/${data.source.coverage.expected} reviewed models); missing evidence is not a finding that no better model exists.`;
  if (data.source.origin === 'bundled') message += ' Using reviewed public evidence shipped with this catalog while shared storage catches up.';
  if (data.simulationKnowledge) message += ` Simulation uses frozen evidence as of ${stamp(data.simulationKnowledge.asOf)}; advancing the simulation does not refresh model data.`;
  status.textContent = message;
  document.getElementById("period").textContent = `Recorded usage window: ${data.period.start} to ${data.period.end} (end exclusive, UTC).` + (data.source.fetchedAt ? ` Benchmark snapshot: ${stamp(data.source.fetchedAt)}.` : "") +
    (data.source.coverage ? ` Reviewed benchmark coverage: ${data.source.coverage.matched}/${data.source.coverage.expected} models. This is a reviewed subset of the market.` : '');
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
      ${bm.currentConfiguration || bm.candidateConfiguration ? `<p class="benchmark-configuration">AA configurations: ${escapeHtml(bm.currentConfiguration || 'Not provided')} &rarr; ${escapeHtml(bm.candidateConfiguration || 'Not provided')}. Your usage settings are unknown.</p>` : ''}
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
        <p>${escapeHtml(a.pricingNotes || '')}<br>${escapeHtml(b.pricingNotes || '')}</p>
        ${bm.currentDeprecated || bm.candidateDeprecated ? '<p>AA marks ' + (bm.currentDeprecated && bm.candidateDeprecated ? 'both benchmark entries' : bm.currentDeprecated ? 'the current benchmark entry' : 'the candidate benchmark entry') + ' as superseded/deprecated. This is distinct from provider API availability.</p>' : ''}
        <ul><li>Standard published USD text-token rates. Discounts, cached tokens, batch pricing, tool charges and taxes are excluded.</li>
        <li>Billing data does not establish your context, modality, tool or reasoning requirements. Compare behavior, output quality and latency before switching.</li>
        <li>Known context capacity: ${a.context.toLocaleString()} &rarr; ${b.context.toLocaleString()} tokens. Text and tool support checked; application compatibility is unverified.</li>
        <li>A higher benchmark score does not guarantee better results. Token counts and completed-task cost may change.${savings ? " Savings use the same token counts at standard rates; they do not predict your bill after switching." : " No dollar estimate is shown: complete token counts and supported pricing assumptions are required."}</li></ul>
        <p>Source: <a href="https://artificialanalysis.ai/">Artificial Analysis</a>. Recommendation by Camaze; no endorsement implied.</p>
      </details></article>`;
  }).join("");
  const coverage = [...data.unsupported.map(r => ({ ...r, reason: "Model identifier not yet reviewed by Camaze" })), ...data.excluded];
  const evaluated = data.evaluated || [];
  const evaluationsHtml = evaluated.length ? `<details><summary>${evaluated.length} model${evaluated.length === 1 ? '' : 's'} evaluated against reviewed alternatives</summary>
    <p>Same provider, higher AA score, neither published rate higher and at least one lower, with no known capability reduction. A model can be evaluated without a qualifying candidate.</p>
    ${evaluated.map(r => `<details><summary>${escapeHtml(r.model)}: ${r.eligibleCount} candidate${r.eligibleCount === 1 ? '' : 's'} from ${r.candidateCount} reviewed alternatives</summary>
      ${r.reason ? `<p>${escapeHtml(r.reason)}</p>` : ''}<ul>${r.comparisons.map(c => `<li>${escapeHtml(c.name)}: ${escapeHtml(c.reason || 'Meets criteria; only alternatives not superseded by a better reviewed option are shown above')}</li>`).join('')}</ul></details>`).join('')}</details>` : '';
  if (!coverage.length) {
    document.getElementById("coverage").innerHTML = evaluationsHtml;
  } else {
    const groups = new Map();
    for (const r of coverage) {
      if (!groups.has(r.reason)) groups.set(r.reason, []);
      groups.get(r.reason).push(r);
    }
    const groupsHtml = [...groups].map(([reason, items]) =>
      `<p><strong>${escapeHtml(reason)} (${items.length})</strong></p><ul>${items.map(r => `<li>${escapeHtml(r.model)} (${escapeHtml(r.provider)})</li>`).join("")}</ul>`
    ).join("");
    document.getElementById("coverage").innerHTML = evaluationsHtml + `<details><summary>${coverage.length} model${coverage.length === 1 ? "" : "s"} not evaluated</summary>${groupsHtml}</details>`;
  }
}
async function loadInsights(session) {
  const status = document.getElementById("status");
  status.textContent = "Loading recorded usage...";
  try {
    const response = await window.camazeFetch("/api/insights", { headers: { Authorization: `Bearer ${session.access_token || ""}` }, signal: AbortSignal.timeout(30000) });
    if (response.status === 401) { location.replace("/login.html"); return; }
    if (!response.ok) throw new Error("Insights could not be loaded. Refresh to retry.");
    const data = await response.json();
    renderInsights(data);
  } catch (error) { status.textContent = error.message; }
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
    // Recorded usage is date-scoped, so a sim day/month advance changes
    // what this page should show — re-fetch in place instead of the page
    // reloading (see simulation.js's window.camazeSimRefresh).
    window.camazeSimRefresh = () => loadInsights(session);
    await loadInsights(session);
  } catch { status.textContent = "Sign-in could not be loaded. Refresh to try again."; }
})();
