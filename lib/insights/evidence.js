const { createHash } = require('node:crypto');

function fingerprint(models) {
  return createHash('sha256').update(JSON.stringify([...models].sort((a, b) =>
    `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`)))).digest('hex');
}

function recordFor(snapshot, model) {
  return snapshot?.records?.find(r => r.id === model.benchmarkId && r.provider === model.provider &&
    (!model.slug || r.slug === model.slug) &&
    (!model.benchmarkName || (r.name === model.benchmarkName && r.reasoning === model.benchmarkReasoning)));
}

function coverage(snapshot, models) {
  const missing = models.filter(m => {
    const r = recordFor(snapshot, m);
    return !r || !Number.isFinite(r.score) || !snapshot.version || r.version !== snapshot.version;
  }).map(m => `${m.provider}:${m.id}`);
  const catalogMatches = snapshot?.catalogFingerprint === fingerprint(models);
  return { expected: models.length, matched: models.length - missing.length, missing,
    catalogMatches, complete: catalogMatches && missing.length === 0 };
}

module.exports = { fingerprint, recordFor, coverage };
