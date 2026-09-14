const SOURCE_URL = "https://artificialanalysis.ai/models/gpt-4-1";
const MAX_BYTES = 8 * 1024 * 1024;
const { fingerprint, coverage } = require('./evidence');

// The public Next.js HTML embeds JSON string chunks. Decode JSON, never execute scripts.
function extract(html) {
  if (Buffer.byteLength(html) > MAX_BYTES) throw new Error("Public page exceeds size limit");
  const chunks = [];
  for (const match of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    try {
      const chunk = JSON.parse(match[1]);
      if (chunk[0] === 1 && typeof chunk[1] === "string") chunks.push(chunk[1]);
    } catch { /* Ignore unrelated or incomplete script chunks. */ }
  }
  const stream = chunks.join("");
  const versions = [...new Set([...stream.matchAll(/Intelligence Index v(\d+\.\d+(?:\.\d+)?)/g)].map(m => m[1]))];
  if (versions.length !== 1) throw new Error("Missing or ambiguous Intelligence Index version");
  const records = new Map();
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.id === "string" && typeof value.slug === "string" && Object.hasOwn(value, "intelligenceIndex")) {
      const previous = records.get(value.id);
      if (previous && (previous.intelligenceIndex !== value.intelligenceIndex || previous.slug !== value.slug || previous.name !== value.name || previous.isReasoning !== value.isReasoning || previous.deprecated !== value.deprecated || previous.intelligenceIndexIsEstimated !== value.intelligenceIndexIsEstimated || previous.creator?.slug !== value.creator?.slug)) {
        throw new Error("Conflicting public benchmark records");
      }
      records.set(value.id, value);
    }
    for (const child of Object.values(value)) walk(child);
  }
  for (const line of stream.split("\n")) {
    let value;
    try { value = JSON.parse(line.slice(line.indexOf(":") + 1)); } catch { continue; }
    walk(value);
  }
  if (!records.size) throw new Error("Public page contains no structured benchmark records");
  return { version: versions[0], records: [...records.values()] };
}

function normalize(extracted, catalog, fetchedAt) {
  const records = [];
  for (const entry of catalog) {
    const raw = extracted.records.find(r => r.id === entry.benchmarkId && r.slug === entry.slug && r.creator?.slug === entry.provider);
    if (!raw) continue;
    records.push({ id: raw.id, slug: raw.slug, provider: entry.provider,
      name: raw.name ?? null, reasoning: raw.isReasoning ?? null,
      deprecated: typeof raw.deprecated === 'boolean' ? raw.deprecated : null,
      releaseDate: raw.releaseDate ?? null,
      score: typeof raw.intelligenceIndex === "number" && Number.isFinite(raw.intelligenceIndex) ? raw.intelligenceIndex : null,
      estimated: typeof raw.intelligenceIndexIsEstimated === "boolean" ? raw.intelligenceIndexIsEstimated : null,
      version: extracted.version, observedAt: null,
      source: `https://artificialanalysis.ai/models/${raw.slug}`,
    });
  }
  if (!records.length) throw new Error("No reviewed identifiers found on public page");
  const snapshot = { source: SOURCE_URL, adapter: "aa-public-html-v2", fetchedAt, version: extracted.version,
    catalogFingerprint: fingerprint(catalog), records };
  snapshot.coverage = coverage(snapshot, catalog);
  return snapshot;
}

async function fetchPublicSnapshot(catalog, { fetchImpl = fetch, now = () => new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  // One central request, at most one retry on transient failure. Never retry access denial.
  for (let attempt = 0; attempt < 2; attempt++) {
    let html;
    try {
      const response = await fetchImpl(SOURCE_URL, { signal: AbortSignal.timeout(20000), redirect: "error" });
      if (!response.ok) {
        const error = new Error(`Public benchmark page HTTP ${response.status}`);
        error.retryable = response.status >= 500;
        throw error;
      }
      const reader = response.body.getReader();
      const parts = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { await reader.cancel(); throw Object.assign(new Error("Public page exceeds size limit"), { retryable: false }); }
        parts.push(Buffer.from(value));
      }
      html = Buffer.concat(parts).toString("utf8");
    } catch (error) {
      if (attempt === 0 && error.retryable !== false) { await sleep(1000); continue; }
      throw error;
    }
    const snapshot = normalize(extract(html), catalog, now().toISOString());
    if (!snapshot.coverage.complete) throw new Error(`Incomplete benchmark coverage: ${snapshot.coverage.matched}/${snapshot.coverage.expected}; missing or changed: ${snapshot.coverage.missing.join(', ')}`);
    return snapshot;
  }
}
module.exports = { extract, normalize, fetchPublicSnapshot, SOURCE_URL };
