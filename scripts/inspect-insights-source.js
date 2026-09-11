// Prints normalized public evidence only; no credentials or database writes.
const fs = require("node:fs");
const { extract, normalize, fetchPublicSnapshot } = require("../lib/insights/source");
const { models } = require("../lib/insights/catalog");
(async () => {
  const snapshot = process.argv[2] ? normalize(extract(fs.readFileSync(process.argv[2], "utf8")), models, fs.statSync(process.argv[2]).mtime.toISOString()) : await fetchPublicSnapshot(models);
  console.log(JSON.stringify(snapshot, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
