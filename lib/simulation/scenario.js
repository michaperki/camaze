// Versioned provider world. Economic assumptions are scenario inputs, not live quotes.
const VERSION = 'mid-size-v1';
const START = '2026-06-16';
const INITIAL = '2026-09-14T12:00:00Z';
const DAY = 86400000;
const prices = {
  anthropic: { 'claude-haiku-4-5-20251001': [1,5], 'claude-sonnet-4-6': [3,15] },
  openai: { 'gpt-4o-mini-2024-07-18': [.15,.6], 'gpt-4o-2024-11-20': [2.5,10] },
  google: { 'gemini-2.5-flash': [.3,2.5] },
};
const departments = [
  { name: 'Product Engineering', headcount: 55, monthly_budget_usd: 21000 },
  { name: 'AI Platform', headcount: 30, monthly_budget_usd: 11000 },
  { name: 'Customer Engineering', headcount: 15, monthly_budget_usd: 5000 },
];
// Only 24 engineers have individual Anthropic keys. Everyone else shares
// team credentials/projects. A person assignment means ownership, not telemetry.
const entities = [
  { provider:'anthropic', scope:'api_key', id:'chatbot-prod', name:'Chatbot production (shared)', dept:0, daily:190, model:'claude-haiku-4-5-20251001', continuous:true },
  { provider:'anthropic', scope:'api_key', id:'platform-shared', name:'Platform experiments (shared)', dept:1, daily:105, model:'claude-sonnet-4-6' },
  { provider:'anthropic', scope:'api_key', id:'legacy-key', name:'Legacy automation — owner unknown', dept:null, daily:32, model:'claude-sonnet-4-6' },
  ...Array.from({length:24}, (_,i)=>({provider:'anthropic',scope:'api_key',id:'engineer-'+(i+1),name:'Engineering key '+String(i+1).padStart(2,'0'),dept:i<16?0:1,person:i<16?i:55+i-16,daily:5+(i%7)*2,model:'claude-sonnet-4-6'})),
  { provider:'openai',scope:'project',id:'chatbot',name:'Customer chatbot — production',dept:0,daily:220,model:'gpt-4o-mini-2024-07-18',continuous:true },
  { provider:'openai',scope:'project',id:'evaluation',name:'Evaluation and batch jobs',dept:1,daily:125,model:'gpt-4o-2024-11-20' },
  { provider:'openai',scope:'project',id:'support',name:'Customer engineering tools',dept:2,daily:80,model:'gpt-4o-mini-2024-07-18' },
  { provider:'openai',scope:'project',id:'sandbox',name:'Shared sandbox — unassigned',dept:null,daily:45,model:'gpt-4o-2024-11-20' },
  { provider:'google',scope:'project',id:'retrieval',name:'Retrieval and enrichment',dept:1,daily:120,model:'gemini-2.5-flash' },
  { provider:'google',scope:'project',id:'customer-tools',name:'Customer solution prototypes',dept:2,daily:60,model:'gemini-2.5-flash' },
  { provider:'google',scope:'project',id:'old-pilot',name:'Old pilot — shared ownership',dept:null,daily:25,model:'gemini-2.5-flash' },
];
function validate(env) {
  if (env.scenario_version !== VERSION || env.seed !== 42) throw new Error('Unsupported simulation scenario version/seed');
}
function connections(env) {
  validate(env);
  const key='camaze-simulation-'+env.revision;
  return { anthropic:key,openai:key,google:{project:'camaze-simulation',dataset:'billing_export',serviceAccountJson:'camaze-simulation'} };
}
function noise(text) { let n=42; for (const c of text) n=(Math.imul(n,31)+c.charCodeAt(0))>>>0; return .85+(n%301)/1000; }
function ledger(env, provider, start, end, usage=false) {
  validate(env);
  const rows=[];
  const today=env.business_now.slice(0,10);
  for(let t=Math.max(Date.parse(START), +new Date(start));t<Math.min(+new Date(end),+new Date(env.business_now));t+=DAY){
    const date=new Date(t).toISOString().slice(0,10);
    // Daily billing arrives after the day closes. Google is one extra day late.
    const age=(Date.parse(today)-Date.parse(date))/DAY;
    if(age<1+(provider==='google'?1:0) && !usage) continue;
    const delayed=(env.events||[]).some(e=>e.type==='delay'&&e.provider===provider&&date>=e.date&&date<e.until&&today<e.until);
    if(delayed&&!usage)continue;
    const weekday=new Date(t).getUTCDay();
    for(const entity of entities.filter(e=>e.provider===provider)){
      const spike=(date==='2026-09-10'||(env.events||[]).some(e=>e.type==='spike'&&e.date===date));
      const multiplier=spike&&entity.id==='chatbot'?24:1;
      const dollars=entity.daily*noise(date+entity.id)*(entity.continuous?1:weekday===0||weekday===6?.28:1)*multiplier;
      const [inputPrice,outputPrice]=prices[provider][entity.model];
      const input=Math.round(dollars*1e6/(inputPrice+outputPrice*.22));
      const output=Math.round(input*.22);
      rows.push({date,entity,input,output,amount:(input*inputPrice+output*outputPrice)/1e6});
    }
  }
  return rows;
}
function group(rows, key, make, add) { const m=new Map(); for(const row of rows){const k=key(row); if(!m.has(k))m.set(k,make(row));add(m.get(k),row);}return [...m.values()]; }
function paginate(data,url,size=7) {
  const offset=Number(url.searchParams.get('page')||0);
  if(!Number.isInteger(offset)||offset<0)throw new Error('Invalid simulation pagination');
  const page=data.slice(offset,offset+size);return {data:page,has_more:offset+size<data.length,next_page:offset+size<data.length?String(offset+size):null};
}
function bucket(rows,provider,makeRows) {
  return group(rows,r=>r.date,r=>({date:r.date,rows:[]}), (b,r)=>b.rows.push(r)).map(b=>provider==='anthropic'?{
    starting_at:b.date+'T00:00:00Z',ending_at:new Date(Date.parse(b.date)+DAY).toISOString(),results:makeRows(b.rows),
  }:{start_time:Date.parse(b.date)/1000,end_time:(Date.parse(b.date)+DAY)/1000,results:makeRows(b.rows)});
}
async function respond(env,rawUrl,options={}) {
  validate(env);
  const url=new URL(String(rawUrl));
  const provider=url.hostname==='api.anthropic.com'?'anthropic':url.hostname==='api.openai.com'?'openai':url.hostname==='bigquery.googleapis.com'?'google':null;
  if(!provider)throw new Error('Unsupported simulation provider request');
  if((env.events||[]).some(e=>e.type==='failure'&&e.provider===provider&&env.business_now.slice(0,10)>=e.date&&env.business_now.slice(0,10)<e.until))return new Response(JSON.stringify({error:{message:'Simulated credential failure'}}),{status:401});
  let body;
  if(provider==='google') {
    if(url.pathname.endsWith('/tables')) body={tables:[{tableReference:{tableId:'gcp_billing_export_v1_SIMULATION'}}]};
    else if(url.pathname.endsWith('/queries')){
      const sql=JSON.parse(options.body).query;
      const dates=[...sql.matchAll(/TIMESTAMP\('([^']+)'\)/g)].map(m=>m[1]);
      if(dates.length!==2||!sql.includes('GROUP BY day, model, project_id, project_name'))throw new Error('Unsupported simulated BigQuery query');
      body={jobComplete:true,rows:ledger(env,provider,...dates).map(r=>({f:[r.date,r.entity.model,r.entity.id,r.entity.name,r.amount,r.input,r.output].map(v=>({v:String(v)}))}))};
    }else throw new Error('Unsupported simulated BigQuery endpoint');
  }else if(url.pathname.endsWith('/projects')||url.pathname.endsWith('/api_keys')||url.pathname.endsWith('/workspaces')){
    const isWorkspace=url.pathname.endsWith('/workspaces');
    const all=isWorkspace?departments.map((d,i)=>({id:'workspace-'+i,name:d.name})):entities.filter(e=>e.provider===provider).map(e=>({id:e.id,name:e.name}));
    const after=url.searchParams.get('after')||url.searchParams.get('after_id')||url.searchParams.get('page');
    const offset=after?all.findIndex(e=>e.id===after)+1:0;
    const data=all.slice(offset,offset+10),has_more=offset+10<all.length;
    body={data,has_more,last_id:data.at(-1)?.id,next_page:has_more?data.at(-1).id:null};
  }else{
    const anth=provider==='anthropic';
    const start=anth?url.searchParams.get('starting_at'):new Date(Number(url.searchParams.get('start_time'))*1000).toISOString();
    const end=anth?url.searchParams.get('ending_at'):new Date(Number(url.searchParams.get('end_time'))*1000).toISOString();
    const usage=url.pathname.endsWith(anth?'/usage_report/messages':'/usage/completions');
    if(!usage&&!url.pathname.endsWith(anth?'/cost_report':'/costs'))throw new Error('Unsupported simulation billing endpoint');
    const groups=url.searchParams.getAll(anth?'group_by[]':'group_by');
    const allowed=usage?(anth?['api_key_id','model','service_tier','context_window']:['model']):(anth?['description','workspace_id']:['line_item','project_id']);
    if(!groups.length||groups.some(g=>!allowed.includes(g)))throw new Error('Unsupported simulated grouping');
    const rows=ledger(env,provider,start,end,usage);
    const data=bucket(rows,provider,rs=>{
      if(usage) {
        const byKey=groups.includes('api_key_id');
        return group(rs,r=>r.entity.model+(byKey?r.entity.id:''),r=>anth?{
          model:r.entity.model,api_key_id:byKey?r.entity.id:null,service_tier:'standard',context_window:'200000',uncached_input_tokens:0,output_tokens:0,cache_read_input_tokens:0,
        }:{model:r.entity.model,input_tokens:0,output_tokens:0},(a,r)=>{a[anth?'uncached_input_tokens':'input_tokens']+=r.input;a.output_tokens+=r.output;});
      }
      if(anth&&groups.includes('workspace_id'))return group(rs,r=>r.entity.dept,r=>({workspace_id:r.entity.dept===null?null:'workspace-'+r.entity.dept,amount:0}),(a,r)=>a.amount+=r.amount*100).map(r=>({...r,amount:String(r.amount)}));
      if(!anth&&groups.includes('project_id'))return group(rs,r=>r.entity.id,r=>({project_id:r.entity.id,amount:{value:0,currency:'usd'}}),(a,r)=>a.amount.value+=r.amount);
      const models=group(rs,r=>r.entity.model,r=>({model:r.entity.model,input:0,output:0}),(a,r)=>{a.input+=r.input;a.output+=r.output;});
      return models.flatMap(m=>['input','output'].map((direction,i)=>anth?{
        model:m.model,token_type:i?'output_tokens':'uncached_input_tokens',service_tier:'standard',context_window:'200000',amount:String(m[direction]*prices[provider][m.model][i]/1e4),
      }:{line_item:m.model+', '+direction,amount:{value:m[direction]*prices[provider][m.model][i]/1e6,currency:'usd'}}));
    });
    body=paginate(data,url);
  }
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
}
module.exports={VERSION,START,INITIAL,DAY,prices,entities,departments,ledger,respond,connections};
