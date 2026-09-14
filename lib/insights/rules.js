const DAY = 86400000;
// ~6 months: wide enough to catch usage from occasional/toy projects between
// months of zero variable spend, not just the current billing cycle.
const WINDOW_DAYS = 182;
const catalog = require("./catalog");
const { recordFor } = require("./evidence");
function recentWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: new Date(+end - WINDOW_DAYS * DAY).toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function fresh(timestamp, now, days) {
  const age = +now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= 0 && age <= days * DAY;
}
function recommend(rows, snapshot, now = new Date(), config = catalog, evidenceNow = now) {
  const period = recentWindow(now);
  const seen = new Map();
  for (const row of rows) {
    if (row.date < period.start || row.date >= period.end || row.is_subscription || !Number.isFinite(Number(row.amount_usd)) || Number(row.amount_usd) <= 0) continue;
    const key = `${row.provider}:${row.model}`;
    const previous = seen.get(key);
    // Any row in the range without a token breakdown (pre-migration data, or
    // a provider gap) poisons the whole aggregate — a partial sum would
    // under-count and produce a misleadingly-low cost estimate below. The
    // explicit != null checks matter: Supabase returns a genuinely-missing
    // breakdown as null, and Number(null) is 0 — which Number.isFinite
    // can't tell apart from an actual, real zero-token row.
    const rowTokensKnown = row.input_tokens != null && row.output_tokens != null &&
      Number.isFinite(Number(row.input_tokens)) && Number(row.input_tokens) >= 0 &&
      Number.isFinite(Number(row.output_tokens)) && Number(row.output_tokens) >= 0;
    const inputTokens = rowTokensKnown ? Number(row.input_tokens) : 0;
    const outputTokens = rowTokensKnown ? Number(row.output_tokens) : 0;
    const tokensKnown = (previous ? previous.tokensKnown : true) && rowTokensKnown;
    seen.set(key, { provider: row.provider, model: row.model, firstSeen: previous && previous.firstSeen < row.date ? previous.firstSeen : row.date,
      lastSeen: previous && previous.lastSeen > row.date ? previous.lastSeen : row.date,
      actualCostUsd: (previous?.actualCostUsd || 0) + Number(row.amount_usd),
      tokensKnown, inputTokens: (previous?.inputTokens || 0) + (rowTokensKnown ? inputTokens : 0),
      outputTokens: (previous?.outputTokens || 0) + (rowTokensKnown ? outputTokens : 0) });
  }
  const insights = [], unsupported = [], excluded = [], evaluated = [];
  for (const usage of seen.values()) {
    const current = config.models.find(m => m.provider === usage.provider && m.id === usage.model);
    if (!current) { unsupported.push(usage); continue; }
    const a = recordFor(snapshot, current);
    const unavailable = !snapshot || !fresh(snapshot.fetchedAt, evidenceNow, 7) ? "Benchmark snapshot missing or older than 7 days" :
      !fresh(current.reviewedAt, evidenceNow, 30) || expiredPrice(current, evidenceNow) ? "Provider prices and capabilities need review" :
      !validScore(a, snapshot) ? "Comparable benchmark evidence missing" :
      !validMetadata(current) ? "Price or compatibility evidence missing" : null;
    if (unavailable) { excluded.push({ ...usage, reason: unavailable }); continue; }
    const comparisons = [], eligible = [];
    for (const candidate of config.models.filter(m => m.provider === usage.provider && m.id !== current.id)) {
      const b = recordFor(snapshot, candidate);
      const reason = candidate.available !== true ? "Candidate availability has not been confirmed" :
        !fresh(candidate.reviewedAt, evidenceNow, 30) || expiredPrice(candidate, evidenceNow) ? "Provider prices and capabilities need review" :
        !validScore(b, snapshot) ? "Comparable benchmark evidence missing" :
        !validMetadata(candidate) ? "Price or compatibility evidence missing" :
        !compatible(current, candidate) ? "Known capability reduction" :
        b.score <= a.score || candidate.input > current.input || candidate.output > current.output ||
          (candidate.input === current.input && candidate.output === current.output) ? "No higher AA Intelligence Index score with lower published rates" : null;
      comparisons.push({ model: candidate.id, name: candidate.name, reason });
      if (!reason) eligible.push({ candidate, benchmark: b });
    }
    // Keep alternatives with meaningful price/quality/capability tradeoffs. A
    // better, cheaper, equally capable reviewed option supersedes an older one.
    const best = eligible.filter(x => !eligible.some(y => y !== x &&
      compatible(x.candidate, y.candidate) && y.benchmark.score >= x.benchmark.score &&
      y.candidate.input <= x.candidate.input && y.candidate.output <= x.candidate.output &&
      (y.benchmark.score > x.benchmark.score || y.candidate.input < x.candidate.input || y.candidate.output < x.candidate.output)))
      .sort((x, y) => y.benchmark.score - x.benchmark.score || x.candidate.input - y.candidate.input || x.candidate.id.localeCompare(y.candidate.id));
    evaluated.push({ ...usage, comparisons, candidateCount: comparisons.length, eligibleCount: best.length,
      reason: best.length ? null : "No reviewed candidate meets the score, price and capability criteria" });
    for (const { candidate, benchmark: b } of best) {
      // Same-token standard-rate scenario, not a prediction of completed-task
      // cost. Unknown modes, tiered prices and mixed Google billing preclude it.
      const savings = usage.tokensKnown && current.tokenEstimateSupported !== false && candidate.tokenEstimateSupported !== false ? (() => {
        const estimatedCandidateCostUsd = (usage.inputTokens / 1_000_000) * candidate.input + (usage.outputTokens / 1_000_000) * candidate.output;
        const savingsUsd = usage.actualCostUsd - estimatedCandidateCostUsd;
        return savingsUsd > 0 ? { actualCostUsd: usage.actualCostUsd, estimatedCandidateCostUsd, savingsUsd, savingsPct: (savingsUsd / usage.actualCostUsd) * 100 } : undefined;
      })() : undefined;
      insights.push({ current, candidate, benchmark: { name: "Artificial Analysis Intelligence Index", version: a.version,
        current: a.score, candidate: b.score, currentEstimated: a.estimated ?? null, candidateEstimated: b.estimated ?? null,
        currentConfiguration: a.name ?? null, candidateConfiguration: b.name ?? null,
        currentDeprecated: a.deprecated ?? null, candidateDeprecated: b.deprecated ?? null,
        currentSource: a.source, candidateSource: b.source, observedAt: a.observedAt, candidateObservedAt: b.observedAt }, usage, savings, fetchedAt: snapshot.fetchedAt });
    }
  }
  return { period, insights, unsupported, excluded, evaluated, observedModels: seen.size };
}
function validScore(record, snapshot) {
  return record && Number.isFinite(record.score) && record.version && record.version === snapshot.version;
}
function expiredPrice(model, now) {
  return model.pricingValidUntil && (!Number.isFinite(Date.parse(model.pricingValidUntil)) || +now >= Date.parse(model.pricingValidUntil));
}
function validMetadata(m) {
  return [m.input, m.output, m.context].every(n => Number.isFinite(n) && n >= 0) &&
    Array.isArray(m.inputModalities) && Array.isArray(m.outputModalities) && typeof m.tools === "boolean";
}
function compatible(current, candidate) {
  return candidate.context >= current.context && (!current.tools || candidate.tools) &&
    current.inputModalities.every(m => candidate.inputModalities.includes(m)) &&
    current.outputModalities.every(m => candidate.outputModalities.includes(m));
}
module.exports = { recommend, recentWindow, fresh };
