// Request-local business context. Never changes global fetch or Date.
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const OWNER = '0fdc87e0-60fc-4e48-af96-d363d92ad7a8';
const current = () => storage.getStore();
const now = () => current()?.environment ? new Date(current().environment.business_now) : new Date();
function assertOwner(id) {
  const ctx = current();
  if (ctx && id !== OWNER) throw new Error('Simulation owner mismatch');
  if (id === OWNER && !ctx) throw new Error('Simulation requires an authorized context');
}
function headers() {
  const ctx = current();
  return ctx ? { 'x-simulation-revision': String(ctx.environment.revision), 'x-simulation-operation': ctx.operation || '' } : {};
}
async function providerFetch(url, options) {
  const ctx = current();
  if (ctx) return require('./simulation/scenario').respond(ctx.environment, url, options);
  // A synthetic credential must never reach the network even if a caller loses context.
  if (JSON.stringify(options || {}).includes('camaze-simulation')) throw new Error('Simulation transport context missing');
  return fetch(url, options);
}
module.exports = { OWNER, current, now, assertOwner, headers, providerFetch, run: (ctx, fn) => storage.run(ctx, fn) };
