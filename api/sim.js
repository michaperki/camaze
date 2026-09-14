const { verifyUser } = require('../lib/supabase');
const context = require('../lib/context');
const store = require('../lib/simulation/store');
const { control } = require('../lib/simulation/runner');
// Explicit allowlist: no cron, config, credential-validation or arbitrary module access.
const handlers={costs:require('./costs'),org:require('./org'),budget:require('./budget'),
  'fixed-costs':require('./fixed-costs'),keys:require('./keys'),notifications:require('./notifications'),
  insights:require('./insights'),digest:require('./digest'),'alerts/test':require('./alerts/test'),
  'alerts/dryrun':require('./alerts/dryrun'),'audit-signin':require('./audit-signin')};
function publicState(env){const {operation,operation_started_at,...safe}=env;return safe;}
module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  try {
    const actor=await verifyUser(req.headers.authorization);
    if(!actor)return res.status(401).json({error:'Sign in to access the simulator.'});
    if(!await store.authorize(actor))return res.status(403).json({error:'Simulator access is restricted to administrators.'});
    const route=req.query?.route||'state';
    if(route==='control'){
      if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
      const state=await control(actor,req.body?.action,req.body?.revision);
      await require('../lib/audit').logAudit(req,actor,'simulation.'+req.body.action,{revision:state.revision},'api/sim.js');
      return res.status(200).json({environment:publicState(state)});
    }
    const environment=await store.environment();
    if(!environment)return res.status(503).json({error:'Simulation has not been provisioned.'});
    if(route==='state'){
      if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
      const messages=await store.rest('/simulation_messages?user_id=eq.'+context.OWNER+'&order=created_at.desc&limit=30&select=id,business_date,subject,body');
      return res.status(200).json({environment:publicState(environment),messages});
    }
    if(!handlers[route])return res.status(404).json({error:'Unknown simulation route'});
    if(environment.status!=='ready')return res.status(409).json({error:'Simulation is '+environment.status+'. Load/reset the scenario or wait for the current operation.'});
    // Hold the response until the handler completes and its revision is rechecked.
    // A reset racing a read must not render a mixture of old and new company data.
    let status=200,body;
    const buffered={status(n){status=n;return this;},json(value){body=value;return this;},setHeader(name,value){res.setHeader(name,value);}};
    await context.run({actor,environment},()=>handlers[route](req,buffered));
    const latest=await store.environment();
    if(latest.revision!==environment.revision||latest.status!=='ready')return res.status(409).json({error:'Simulation changed during this request. Refresh to see the current company.'});
    return res.status(status).json(body);
  } catch(error) {
    console.error('Simulation request failed:',error.message);
    return res.status(409).json({error:error.message});
  }
};
