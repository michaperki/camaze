const DAY = 86400000;
// ~6 months: wide enough to catch usage from occasional/toy projects between
// months of zero variable spend, not just the current billing cycle.
const WINDOW_DAYS = 182;
const catalog = require("./catalog");
function recentWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: new Date(+end - WINDOW_DAYS * DAY).toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function fresh(timestamp, now, days) {
  const age = +now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= 0 && age <= days * DAY;
}
function recommend(rows, snapshot, now = new Date(), config = catalog) {
  const period = recentWindow(now);
  const seen = new Map();
  for (const row of rows) {
    if (row.date < period.start || row.date >= period.end || row.is_subscription || !Number.isFinite(Number(row.amount_usd)) || Number(row.amount_usd) <= 0) continue;
    const key = `${row.provider}:${row.model}`;
    const previous = seen.get(key);
    const inputTokens = Number(row.input_tokens);
    const outputTokens = Number(row.output_tokens);
    // Any row in the range without a token breakdown (pre-migration data, or
    // a provider gap) poisons the whole aggregate — a partial sum would
    // under-count and produce a misleadingly-low cost estimate below.
    const rowTokensKnown = Number.isFinite(inputTokens) && Number.isFinite(outputTokens);
    const tokensKnown = (previous ? previous.tokensKnown : true) && rowTokensKnown;
    seen.set(key, { provider: row.provider, model: row.model, firstSeen: previous && previous.firstSeen < row.date ? previous.firstSeen : row.date,
      lastSeen: previous && previous.lastSeen > row.date ? previous.lastSeen : row.date,
      actualCostUsd: (previous?.actualCostUsd || 0) + Number(row.amount_usd),
      tokensKnown, inputTokens: (previous?.inputTokens || 0) + (rowTokensKnown ? inputTokens : 0),
      outputTokens: (previous?.outputTokens || 0) + (rowTokensKnown ? outputTokens : 0) });
  }
  const insights = [], unsupported = [], excluded = [];
  for (const usage of seen.values()) {
    const current = config.models.find(m => m.provider === usage.provider && m.id === usage.model);
    if (!current) { unsupported.push(usage); continue; }
    const pairs = config.replacements.filter(p => p[0] === usage.provider && p[1] === usage.model);
    let reason = "No reviewed replacement";
    for (const [, , id] of pairs) {
      const candidate = config.models.find(m => m.provider === usage.provider && m.id === id);
      const a = snapshot?.records?.find(r => r.id === current.benchmarkId && r.provider === usage.provider);
      const b = snapshot?.records?.find(r => r.id === candidate?.benchmarkId && r.provider === usage.provider);
      if (!snapshot || !fresh(snapshot.fetchedAt, now, 7)) { reason = "Benchmark snapshot missing or older than 7 days"; continue; }
      if (!candidate || candidate.available !== true) { reason = "Candidate availability has not been confirmed"; continue; }
      if (![current, candidate].every(m => fresh(m.reviewedAt, now, 30))) { reason = "Provider prices and capabilities need review"; continue; }
      if (!a || !b || !Number.isFinite(a.score) || !Number.isFinite(b.score) || !a.version || a.version !== b.version || a.version !== snapshot.version) { reason = "Comparable benchmark evidence missing"; continue; }
      if (![current, candidate].every(m => [m.input, m.output, m.context].every(n => Number.isFinite(n) && n >= 0) && Array.isArray(m.inputModalities) && Array.isArray(m.outputModalities) && typeof m.tools === "boolean")) { reason = "Price or compatibility evidence missing"; continue; }
      if (candidate.context < current.context || (current.tools && !candidate.tools) || !current.inputModalities.every(m => candidate.inputModalities.includes(m)) || !current.outputModalities.every(m => candidate.outputModalities.includes(m))) { reason = "Known capability reduction"; continue; }
      if (b.score <= a.score || candidate.input > current.input || candidate.output > current.output || (candidate.input === current.input && candidate.output === current.output)) { reason = "No higher AA Intelligence Index score with lower published rates"; continue; }
      // Exact, not estimated: the candidate's own published rate applied to
      // the user's own actual token counts for the exact usage observed.
      // Only computable when every contributing daily_costs row carried a
      // token breakdown (see tokensKnown above) — omitted otherwise rather
      // than guessing a split from a blended dollar total.
      const savings = usage.tokensKnown ? (() => {
        const estimatedCandidateCostUsd = (usage.inputTokens / 1_000_000) * candidate.input + (usage.outputTokens / 1_000_000) * candidate.output;
        const savingsUsd = usage.actualCostUsd - estimatedCandidateCostUsd;
        return { actualCostUsd: usage.actualCostUsd, estimatedCandidateCostUsd, savingsUsd, savingsPct: (savingsUsd / usage.actualCostUsd) * 100 };
      })() : undefined;
      insights.push({ current, candidate, benchmark: { name: "Artificial Analysis Intelligence Index", version: a.version, current: a.score, candidate: b.score, currentEstimated: a.estimated ?? null, candidateEstimated: b.estimated ?? null, currentSource: a.source, candidateSource: b.source, observedAt: a.observedAt, candidateObservedAt: b.observedAt }, usage, savings, fetchedAt: snapshot.fetchedAt });
      reason = null;
    }
    if (reason) excluded.push({ ...usage, reason });
  }
  return { period, insights, unsupported, excluded, observedModels: seen.size };
}
module.exports = { recommend, recentWindow, fresh };
