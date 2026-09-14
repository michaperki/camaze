const test = require("node:test");
const assert = require("node:assert/strict");
const { extract, normalize, fetchPublicSnapshot } = require("../lib/insights/source");
const { models } = require("../lib/insights/catalog");
const { recommend, recentWindow } = require("../lib/insights/rules");
const { createHandler } = require("../api/insights");
const { refreshSource, getUsage } = require("../lib/insights/store");
const now = new Date("2026-09-11T12:00:00Z");
function html(record, version = "4.3") {
  const stream = `1:${JSON.stringify({ title: `Intelligence Index v${version}`, models: [record] })}\n`;
  // A chunk boundary inside a JSON string reproduces the public streaming envelope.
  return [stream.slice(0, 35), stream.slice(35)].map(s => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`).join("");
}
const raw = { name: models[0].benchmarkName, isReasoning: models[0].benchmarkReasoning, deprecated: true, id: models[0].benchmarkId, slug: models[0].slug, creator: { slug: "openai" }, intelligenceIndex: 8.4416392330287, intelligenceIndexIsEstimated: true };
// Two synthetic openai models forming one reviewed replacement pair — same
// shape recommend()/catalog entries take, kept local to this file rather
// than pulled from product data so the test suite doesn't depend on
// whatever real models the catalog happens to carry.
function scenario() {
  const current = { provider: "openai", id: "test-model-a", name: "Test Model A", benchmarkId: "bench-a",
    input: 2.5, output: 10, context: 200000, inputModalities: ["text"], outputModalities: ["text"], tools: true,
    available: true, reviewedAt: now.toISOString(), pricingSource: null, compatibilitySource: null };
  const candidate = { provider: "openai", id: "test-model-b", name: "Test Model B", benchmarkId: "bench-b",
    input: 1.5, output: 6, context: 200000, inputModalities: ["text"], outputModalities: ["text"], tools: true,
    available: true, reviewedAt: now.toISOString(), pricingSource: null, compatibilitySource: null };
  const config = { models: [current, candidate] };
  const records = [
    { id: current.benchmarkId, provider: "openai", version: "test-1", score: 32, estimated: false },
    { id: candidate.benchmarkId, provider: "openai", version: "test-1", score: 40, estimated: false },
  ];
  return { config, snapshot: { fetchedAt: now.toISOString(), version: "test-1", records }, rows: [{ date: "2026-09-10", provider: "openai", model: current.id, amount_usd: 10 }] };
}
test("public HTML chunks parse exact identities, version, estimated flag and missing observation date", () => {
  const result = normalize(extract(html(raw)), models, now.toISOString());
  assert.equal(result.records[0].id, raw.id);
  assert.equal(result.records[0].score, raw.intelligenceIndex);
  assert.equal(result.records[0].estimated, true);
  assert.equal(result.records[0].observedAt, null);
  assert.equal(result.version, "4.3");
  assert.equal(normalize(extract(html({ ...raw, intelligenceIndex: null })), models, now.toISOString()).records[0].score, null);
  assert.throws(() => normalize(extract(html({ ...raw, id: "unknown" })), models, now.toISOString()), /No reviewed/);
});
test("rejects markup changes, login pages, mixed versions and conflicting records", () => {
  assert.throws(() => extract("<h1>Sign in</h1>"), /version/);
  assert.throws(() => extract(html(raw) + html(raw, "4.2")), /ambiguous/);
  assert.throws(() => extract(html(raw) + html({ ...raw, intelligenceIndex: 99 })), /Conflicting/);
  assert.throws(() => extract(html(raw) + html({ ...raw, intelligenceIndexIsEstimated: false })), /Conflicting/);
});
test("fetch retries transient failures once but does not retry access denial or parser failure", async () => {
  let calls = 0;
  await assert.rejects(fetchPublicSnapshot(models, { fetchImpl: async () => { calls++; return new Response("blocked", { status: 403 }); }, sleep: async () => {} }), /403/);
  assert.equal(calls, 1);
  calls = 0;
  const snapshot = await fetchPublicSnapshot([models[0]], { fetchImpl: async () => { calls++; return calls === 1 ? new Response("bad", { status: 503 }) : new Response(html(raw)); }, sleep: async () => {}, now: () => now });
  assert.equal(calls, 2); assert.equal(snapshot.records.length, 1);
  calls = 0;
  await assert.rejects(fetchPublicSnapshot(models, { fetchImpl: async () => { calls++; return new Response("changed"); }, sleep: async () => {} }));
  assert.equal(calls, 1);
});
test("recent usage crosses month boundary and excludes today, zero spend, subscriptions and old records", () => {
  assert.deepEqual(recentWindow(now), { start: "2026-03-13", end: "2026-09-11" });
  const s = scenario();
  for (const changed of [{ date: "2026-09-11" }, { date: "2026-03-12" }, { amount_usd: 0 }, { is_subscription: true }]) {
    assert.equal(recommend([{ ...s.rows[0], ...changed }], s.snapshot, now, s.config).observedModels, 0);
  }
});
test("strict price dominance allows one equal price, never higher prices or equal prices on both", () => {
  for (const [input, output, expected] of [[2.5, 6, 1], [1.5, 10, 1], [2.5, 10, 0], [3, 1, 0], [1, 11, 0]]) {
    const s = scenario(); Object.assign(s.config.models[1], { input, output });
    assert.equal(recommend(s.rows, s.snapshot, now, s.config).insights.length, expected);
  }
});
test("missing/stale evidence, versions, availability and compatibility suppress comparisons", () => {
  const mutations = [s => { s.snapshot = null; }, s => { s.snapshot.fetchedAt = "2026-09-01"; }, s => { s.snapshot.fetchedAt = "2027-01-01"; },
    s => { s.snapshot.records[1].score = null; }, s => { s.snapshot.records[1].score = 32; }, s => { s.snapshot.records[1].version = "different"; },
    s => { s.config.models[1].available = false; }, s => { s.config.models[1].available = null; },
    s => { s.config.models[1].input = null; }, s => { s.config.models[1].reviewedAt = "2026-01-01"; }, s => { s.config.models[1].context = 100; },
    s => { s.config.models[1].tools = false; }, s => { s.config.models[1].inputModalities = []; }, s => { s.config.models[1].outputModalities = []; }];
  for (const mutate of mutations) { const s = scenario(); mutate(s); assert.equal(recommend(s.rows, s.snapshot, now, s.config).insights.length, 0); }
});
test("exact model IDs only, provider scoped, no dollars-based savings without token data", () => {
  const s = scenario();
  const result = recommend(s.rows, s.snapshot, now, s.config);
  assert.equal(result.insights.length, 1);
  assert.equal(JSON.stringify(result).includes("savings"), false);
  for (const model of ["test-model-a-latest", "test-model", "gpt-4o", "gpt-4o-2024-08-06"]) {
    const result = recommend([{ ...s.rows[0], model }], s.snapshot, now, s.config);
    assert.equal(result.insights.length, 0); assert.equal(result.unsupported.length, 1);
  }
  assert.equal(recommend([{ ...s.rows[0], provider: "anthropic" }], s.snapshot, now, s.config).insights.length, 0);
});
test("computes exact dollar savings from the candidate's own rate applied to actual token counts", () => {
  const s = scenario();
  s.rows[0].input_tokens = 2_000_000;
  s.rows[0].output_tokens = 500_000;
  const result = recommend(s.rows, s.snapshot, now, s.config);
  assert.equal(result.insights.length, 1);
  // candidate: input $1.5/1M, output $6/1M -> 2*1.5 + 0.5*6 = $6 on the same usage.
  assert.deepEqual(result.insights[0].savings, { actualCostUsd: 10, estimatedCandidateCostUsd: 6, savingsUsd: 4, savingsPct: 40 });
});
test("any row missing a token count poisons the whole savings aggregate, not just that row", () => {
  const s = scenario();
  s.rows[0].input_tokens = 2_000_000;
  s.rows[0].output_tokens = 500_000;
  s.rows.push({ date: "2026-09-09", provider: "openai", model: s.rows[0].model, amount_usd: 5 }); // no token fields
  const result = recommend(s.rows, s.snapshot, now, s.config);
  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].savings, undefined);
});
test("a row with explicit null token columns (Supabase's real shape for a missing breakdown) also poisons the aggregate, rather than being read as zero tokens", () => {
  const s = scenario();
  s.rows[0].input_tokens = null;
  s.rows[0].output_tokens = null;
  const result = recommend(s.rows, s.snapshot, now, s.config);
  assert.equal(result.insights.length, 1);
  // Regression: Number(null) === 0 previously passed the Number.isFinite
  // check, so this row's real $10 of spend was "estimated" against 0
  // tokens — a 0-cost, 100%-savings candidate rather than no estimate.
  assert.equal(result.insights[0].savings, undefined);
});
function response() { return { code: 200, headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } }; }
test("API derives tenant from verified token, ignores supplied user ID, rejects unauthenticated requests", async () => {
  const ids = [];
  const handler = createHandler({ verifyUser: async token => token ? { id: token } : null, getUsage: async id => { ids.push(id); return [{ date: "2026-09-10", provider: "openai", model: id, amount_usd: 1 }]; }, getSource: async () => null }, () => now);
  for (const id of ["tenant-a", "tenant-b"]) {
    const res = response(); await handler({ method: "GET", headers: { authorization: id }, query: { user_id: "victim" } }, res);
    assert.equal(res.body.unsupported[0].model, id); assert.equal(res.headers["Cache-Control"], "private, no-store");
  }
  assert.deepEqual(ids, ["tenant-a", "tenant-b"]);
  const unauth = response(); await handler({ method: "GET", headers: {}, query: {} }, unauth);
  assert.equal(unauth.code, 401); assert.equal(ids.length, 2);
});
test("failed refresh preserves last successful snapshot and a held daily claim skips extraction", async () => {
  const writes = [];
  await refreshSource({ request: async (path, options) => { writes.push(JSON.parse(options.body)); return writes.length === 1 ? [{ id: "artificial-analysis" }] : null; }, getSnapshot: async () => { throw new Error("Public page changed"); }, now });
  assert.equal(writes[1].status, "error"); assert.equal(Object.hasOwn(writes[1], "snapshot"), false);
  const skipped = await refreshSource({ request: async () => [], getSnapshot: async () => { throw new Error("must not fetch"); }, now });
  assert.equal(skipped.status, "skipped");
});
test("every usage page retains verified tenant and time filters", async () => {
  const paths = [];
  const rows = await getUsage("tenant-a", recentWindow(now), async path => {
    paths.push(path);
    return paths.length === 1 ? Array(500).fill({ model: "a" }) : [{ model: "b" }];
  });
  assert.equal(rows.length, 501);
  for (const path of paths) {
    const query = new URL(path, "https://example.test").searchParams;
    assert.equal(query.get("user_id"), "eq.tenant-a");
    assert.deepEqual(query.getAll("date"), ["gte.2026-03-13", "lt.2026-09-11"]);
  }
  assert.match(paths[1], /offset=500/);
});
test("cron rejects unauthenticated refresh requests without writing", async () => {
  const cron = require("../api/cron/insights");
  const res = response();
  await cron({ method: "GET", headers: {} }, res);
  assert.equal(res.code, 401);
});

test("published estimated scores remain eligible and preserve each score's status", () => {
  for (const [current, candidate] of [[true, true], [true, false], [false, true], [null, true]]) {
    const s = scenario();
    s.snapshot.records[0].estimated = current;
    s.snapshot.records[1].estimated = candidate;
    const result = recommend(s.rows, s.snapshot, now, s.config);
    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].benchmark.currentEstimated, current);
    assert.equal(result.insights[0].benchmark.candidateEstimated, candidate);
    s.snapshot.records[1].score = null;
    assert.equal(recommend(s.rows, s.snapshot, now, s.config).insights.length, 0);
  }
});

test('partial extraction is diagnosed and never published as a successful refresh', async () => {
  const partial = normalize(extract(html(raw)), models, now.toISOString());
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.matched, 1);
  let calls = 0;
  await assert.rejects(fetchPublicSnapshot(models, { fetchImpl: async () => { calls++; return new Response(html(raw)); } }), /Incomplete benchmark coverage/);
  assert.equal(calls, 1);
  const writes = [];
  await refreshSource({ now, getSnapshot: async () => partial, request: async (path, options) => {
    writes.push(JSON.parse(options.body)); return writes.length === 1 ? [{}] : null;
  } });
  assert.equal(writes[1].status, 'error');
  assert.equal(Object.hasOwn(writes[1], 'snapshot'), false);
  assert.equal(writes[0].next_attempt_at, '2026-09-12T00:00:00.000Z');
});

test('a complete refresh is validated at completion time and publishes the expanded snapshot', async () => {
  const snapshot = require('../lib/insights/snapshot.json');
  const fetchedAt = new Date(snapshot.fetchedAt);
  const writes = [];
  const result = await refreshSource({ now: new Date(+fetchedAt - 2000), clock: () => new Date(+fetchedAt + 1000),
    getSnapshot: async () => snapshot, request: async (path, options) => {
      writes.push(JSON.parse(options.body)); return writes.length === 1 ? [{}] : null;
    } });
  assert.equal(result.status, 'ok');
  assert.equal(result.records, models.length);
  assert.deepEqual(writes[1].snapshot, snapshot);
});

test('benchmark configuration, provider, slug and catalog changes cannot silently match', () => {
  const { coverage } = require('../lib/insights/evidence');
  const entries = [models[0]];
  const snapshot = normalize(extract(html(raw)), entries, now.toISOString());
  assert.equal(coverage(snapshot, entries).complete, true);
  for (const change of [{ name: 'Different snapshot' }, { reasoning: true }, { provider: 'anthropic' }, { slug: 'other-version' }, { score: null }]) {
    const changed = structuredClone(snapshot); Object.assign(changed.records[0], change);
    assert.equal(coverage(changed, entries).complete, false);
  }
  assert.equal(coverage(snapshot, [{ ...entries[0], input: 99 }]).catalogMatches, false);
  assert.throws(() => extract(html(raw) + html({ ...raw, isReasoning: true })), /Conflicting/);
});

test('bundled evidence bridges old shared snapshots but cannot extend freshness', () => {
  const { selectSource } = require('../lib/insights/store');
  const { fingerprint } = require('../lib/insights/evidence');
  const s = scenario(); s.snapshot.catalogFingerprint = fingerprint(s.config.models);
  const partial = structuredClone(s.snapshot); partial.records.pop();
  assert.equal(selectSource({ status: 'ok', snapshot: partial }, s.snapshot, s.config.models, now).origin, 'bundled');
  const newer = { ...s.snapshot, fetchedAt: new Date(+now + 1000).toISOString() };
  assert.equal(selectSource({ status: 'ok', snapshot: newer }, s.snapshot, s.config.models, new Date(+now + 2000)).origin, 'shared');
  assert.equal(selectSource(null, s.snapshot, s.config.models, new Date(+now + 8 * 86400000)).snapshot, null);
  assert.equal(selectSource(null, s.snapshot, s.config.models, new Date(+now - 1000)).snapshot, null);
});

test('all reviewed same-provider models are considered and superseded alternatives are removed', () => {
  const s = scenario();
  const better = { ...s.config.models[1], id: 'new-current-generation', benchmarkId: 'bench-c', input: 1, output: 5 };
  s.config.models.push(better, { ...better, provider: 'google', id: 'other-provider', input: 0, output: 0 });
  s.snapshot.records.push({ id: better.benchmarkId, provider: 'openai', version: 'test-1', score: 45 });
  const result = recommend(s.rows, s.snapshot, now, s.config);
  assert.deepEqual(result.insights.map(i => i.candidate.id), [better.id]);
  assert.equal(result.evaluated[0].candidateCount, 2);
  assert.equal(result.excluded.length, 0);
});

test('a qualifying alternative is never followed by a contradictory exclusion', () => {
  const s = scenario();
  s.config.models.push({ ...s.config.models[1], id: 'expensive', input: 100, output: 100 });
  const result = recommend(s.rows, s.snapshot, now, s.config);
  assert.equal(result.insights.length, 1);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.evaluated[0].comparisons.length, 2);
});

test('recognized models without qualifying alternatives are evaluated, not unsupported', () => {
  const s = scenario(); s.rows[0].model = s.config.models[1].id;
  const result = recommend(s.rows, s.snapshot, now, s.config);
  assert.equal(result.insights.length, 0);
  assert.equal(result.unsupported.length, 0);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.evaluated[0].eligibleCount, 0);
  assert.match(result.evaluated[0].reason, /No reviewed candidate meets/);
});

test('negative savings, invalid token counts and unsupported pricing do not produce a savings claim', () => {
  for (const change of ['negative-savings', 'negative-tokens', 'tiered-pricing']) {
    const s = scenario(); Object.assign(s.rows[0], { input_tokens: 10000000, output_tokens: 10000000 });
    if (change === 'negative-tokens') s.rows[0].input_tokens = -1;
    if (change === 'tiered-pricing') s.config.models[1].tokenEstimateSupported = false;
    const result = recommend(s.rows, s.snapshot, now, s.config);
    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].savings, undefined);
  }
});

test('time-limited provider pricing cannot remain eligible past its end date', () => {
  const s = scenario(); s.config.models[1].pricingValidUntil = now.toISOString();
  const result = recommend(s.rows, s.snapshot, now, s.config);
  assert.equal(result.insights.length, 0);
  assert.match(result.evaluated[0].comparisons[0].reason, /need review/);
});

test('shipped catalog and simulation evidence cover the reported models and current generations', () => {
  const catalog = require('../lib/insights/catalog');
  const snapshot = require('../lib/insights/snapshot.json');
  const knowledge = require('../lib/simulation/knowledge.json');
  const { coverage } = require('../lib/insights/evidence');
  assert.equal(coverage(snapshot, catalog.models).complete, true);
  assert.equal(knowledge.evidenceNow, snapshot.fetchedAt);
  assert.equal(knowledge.version, catalog.version);
  const pairs = [['openai', 'gpt-4o-2024-11-20'], ['openai', 'gpt-4o-mini-2024-07-18'],
    ['anthropic', 'claude-sonnet-4-6'], ['anthropic', 'claude-haiku-4-5-20251001'], ['google', 'gemini-2.5-flash']];
  const evidenceNow = new Date(knowledge.evidenceNow);
  const rows = pairs.map(([provider, model]) => ({ provider, model, amount_usd: 1,
    date: new Date(+evidenceNow - 86400000).toISOString().slice(0, 10) }));
  const result = recommend(rows, snapshot, evidenceNow, catalog);
  assert.equal(result.unsupported.length, 0);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.evaluated.length, 5);
  assert(result.insights.some(i => i.current.id === pairs[0][1] && i.candidate.id === 'gpt-5.6-luna'));
  assert(result.insights.some(i => i.current.id === pairs[1][1] && i.candidate.id === 'gpt-4.1-nano-2025-04-14'));
  assert(result.insights.some(i => i.current.id === 'claude-sonnet-4-6' && i.candidate.id === 'claude-sonnet-5'));
  for (const id of ['gpt-6-astra', 'claude-opus-5', 'gemini-3.8-flash']) assert(catalog.models.some(m => m.id === id));
});
