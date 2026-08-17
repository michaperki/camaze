// Lightweight per-request timing collector, threaded implicitly via
// AsyncLocalStorage so nested modules (lib/costs.js, providers/*, lib/pricing.js)
// can record marks without every function signature growing a `timings` param.
// A no-op outside of run() — callers that aren't request-scoped (lib/digest.js,
// lib/alertRunner.js) just don't get instrumented.
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");

const als = new AsyncLocalStorage();

function newStore() {
  return { marks: {} };
}

function run(store, fn) {
  return als.run(store, fn);
}

// Times one async operation under `label`. Repeated calls with the same
// label (e.g. one per pagination page) accumulate ms and count rather than
// overwrite, so the mark reflects total time/round-trips for that stage.
// A cheap no-op — skips performance.now() entirely — when called outside a
// run() scope (i.e. debug timing wasn't requested for this request), so
// leaving these marks scattered through lib/costs.js and providers/*.js
// costs nothing on the hot path.
function mark(label, fn) {
  const store = als.getStore();
  if (!store) return fn();

  const t0 = performance.now();
  return (async () => {
    try {
      return await fn();
    } finally {
      const ms = performance.now() - t0;
      const existing = store.marks[label];
      if (existing) {
        existing.ms += ms;
        existing.count += 1;
      } else {
        store.marks[label] = { ms, count: 1 };
      }
    }
  })();
}

function snapshot() {
  const store = als.getStore();
  if (!store) return {};
  const out = {};
  for (const [label, { ms, count }] of Object.entries(store.marks)) {
    out[label] = { ms: Math.round(ms * 100) / 100, count };
  }
  return out;
}

module.exports = { newStore, run, mark, snapshot };
