const crypto = require('node:crypto');
const context = require('../context');
const store = require('./store');
const scenario = require('./scenario');
const { syncUserMonth } = require('../costSync');
const { runAlertChecksForUser } = require('../alertRunner');
const { getNotificationSettings } = require('../supabase');
const id = name => { const s=crypto.createHash('sha256').update('camaze-mid-size-v1:'+name).digest('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`; };
async function insert(table,rows) {
  return store.rest('/'+table,{method:'POST',headers:context.headers(),body:JSON.stringify(rows.map(r=>({user_id:context.OWNER,...r})))});
}
async function seedCompany(){
  await insert('departments',scenario.departments.map((d,i)=>({id:id('department-'+i),...d})));
  const first=['Alex','Jordan','Sam','Taylor','Morgan','Casey','Riley','Avery','Quinn','Jamie'];
  const last=['Chen','Patel','Cohen','Garcia','Kim','Silva','Levy','Martin','Ali','Reed'];
  await insert('people',Array.from({length:100},(_,i)=>({id:id('person-'+i),name:first[i%10]+' '+last[Math.floor(i/10)],department_id:id('department-'+(i<55?0:i<85?1:2))})));
  await insert('entity_assignments',scenario.entities.filter(e=>e.dept!==null).map(e=>({id:id('assignment-'+e.provider+e.id),provider:e.provider,scope:e.scope,entity_id:e.id,department_id:id('department-'+e.dept),person_id:e.person===undefined?null:id('person-'+e.person),effective_from:scenario.START})));
  await insert('user_settings',[{monthly_budget:39000,alert_threshold:80}]);
  await insert('user_notification_settings',[{digest_enabled:false,digest_hour:9,spike_alerts_enabled:true,budget_alerts_enabled:true}]);
  await insert('user_fixed_costs',[{vendor:'Internal tooling',label:'Engineering assistant seats',unit_cost_usd:20,seats:100,billing_period:'monthly',started_on:scenario.START}]);
}
async function sync(month) {
  const result=await syncUserMonth(context.OWNER,month);
  if(result.status!=='ok' && !context.current().environment.events.some(e=>e.type==='failure' && context.now().toISOString().slice(0,10)>=e.date && context.now().toISOString().slice(0,10)<e.until)) throw new Error('Scenario sync failed: '+JSON.stringify(result.errors||result));
}
async function alerts(){
  const settings=await getNotificationSettings(context.OWNER);
  return runAlertChecksForUser(context.OWNER,{spikeEnabled:settings?.spike_alerts_enabled,budgetEnabled:settings?.budget_alerts_enabled});
}
const dateAfter=(date,days)=>new Date(+new Date(date)+days*scenario.DAY).toISOString();
async function control(actor, action, revision) {
  if(!['reset','day','month','play','pause','spike','delay','failure'].includes(action))throw new Error('Unknown simulation action');
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error('Expected simulation revision is required');
  const environment=await store.rpc('simulation_begin',{expected_revision:revision,reset_scenario:action==='reset'});
  const ctx={actor,environment,operation:environment.operation};
  return context.run(ctx,async()=>{
    try{
      if(action==='reset'){
        await seedCompany();
        for(const month of ['2026-06','2026-07','2026-08','2026-09'])await sync(month);
        // Replay the historical spike through the real detector and deduplication.
        for(let i=6;i>=0;i--){environment.business_now=dateAfter(scenario.INITIAL,-i);await alerts();}
        environment.business_now=scenario.INITIAL;
      }else if(action==='day'||action==='month'){
        const start=new Date(environment.business_now);
        const target=new Date(start);
        if(action==='day')target.setUTCDate(target.getUTCDate()+1);
        else {
          target.setUTCDate(1);target.setUTCMonth(target.getUTCMonth()+1);
          const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
          target.setUTCDate(Math.min(start.getUTCDate(),last));
        }
        const steps=Math.round((+target-+start)/scenario.DAY);
        for(let i=0;i<steps;i++){
          environment.business_now=dateAfter(environment.business_now,1);
          await sync(environment.business_now.slice(0,7));
          // Revisit the closing month while delayed billing settles.
          if(new Date(environment.business_now).getUTCDate()<=5) await sync(dateAfter(environment.business_now,-5).slice(0,7));
          await alerts();
        }
      }else if(action==='play'||action==='pause')environment.playing=action==='play';
      else {
        const type=action;
        const date=environment.business_now.slice(0,10);
        if(!environment.events.some(e=>e.type===type&&e.date===date)) environment.events.push({type,date,until:dateAfter(environment.business_now,3).slice(0,10),provider:action==='delay'?'google':'openai'});
      }
      return await store.rpc('simulation_finish',{expected_revision:environment.revision,operation_id:ctx.operation,new_now:environment.business_now,new_events:environment.events,new_playing:environment.playing,failure:null});
    }catch(error){
      await store.rpc('simulation_finish',{expected_revision:environment.revision,operation_id:ctx.operation,new_now:environment.business_now,new_events:environment.events,new_playing:false,failure:error.message.slice(0,500)}).catch(()=>{});
      throw error;
    }
  });
}
module.exports={control,seedCompany,id};
