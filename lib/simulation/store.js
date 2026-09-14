const { OWNER } = require('../context');
async function rest(path, options = {}) {
  const response = await fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    ...options, headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.text();
  if (!response.ok) throw new Error('Simulation database: ' + (JSON.parse(body).message || response.status));
  return body ? JSON.parse(body) : null;
}
const environment = async () => (await rest('/simulation_environments?owner_id=eq.' + OWNER))[0];
const rpc = (name, args) => rest('/rpc/' + name, { method: 'POST', body: JSON.stringify(args) });
async function authorize(actor) {
  if (!actor || actor.id === OWNER) return false;
  return (await rest('/simulation_admins?user_id=eq.' + encodeURIComponent(actor.id) + '&select=user_id')).length === 1;
}
module.exports = { rest, rpc, environment, authorize };
