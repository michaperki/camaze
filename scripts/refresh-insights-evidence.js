// Refresh checked-in public evidence after reviewing catalog.json. No DB writes.
const fs = require('node:fs');
const path = require('node:path');
const { fetchPublicSnapshot } = require('../lib/insights/source');
const catalog = require('../lib/insights/catalog');

(async () => {
  const snapshot = await fetchPublicSnapshot(catalog.models);
  const write = (file, data) => fs.writeFileSync(path.join(__dirname, '..', file), JSON.stringify(data, null, 2) + '\n');
  write('lib/insights/snapshot.json', snapshot);
  write('lib/simulation/knowledge.json', { version: catalog.version, evidenceNow: snapshot.fetchedAt });
  console.log(`Reviewed evidence: ${snapshot.coverage.matched}/${snapshot.coverage.expected} models, AA ${snapshot.version}, fetched ${snapshot.fetchedAt}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
