// Same product pages and login; explicit request namespace, never a global tenant cookie.
(() => {
  const active = /^\/sim(?:\/|$)/.test(location.pathname);
  window.camazeSimulation = active;
  let environment, token, timer, busy = false;
  window.camazeNow = () => environment ? new Date(environment.business_now) : new Date();
  window.camazeFetch = (url, options) => {
    if (active && typeof url === 'string' && url.startsWith('/api/') && url !== '/api/config' && !url.startsWith('/api/sim')) url = '/api/sim/' + url.slice(5);
    return fetch(url, options);
  };
  window.initializeSimulation = async session => {
    if (!active) return;
    token = session.access_token;
    mount();
    try {
      const data = await request('state');
      environment = data.environment;
      render(data.messages);
      if (environment.status !== 'ready') throw new Error(environment.status === 'empty' ? 'Load Scenario 1 using the simulation control.' : 'Simulation ' + environment.status + '. Open the simulation control to refresh or reset.');
      schedule();
    } catch (error) { status(error.message); throw error; }
  };
  async function request(route,body) {
    const response = await fetch('/api/sim/' + route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Simulation request failed');
    return data;
  }
  function status(message) { const el=document.getElementById('sim-status'); if(el)el.textContent=message; }

  function mount() {
    if(document.getElementById('sim-trigger'))return;

    const trigger=document.createElement('button');
    trigger.id='sim-trigger';trigger.type='button';
    trigger.setAttribute('aria-haspopup','dialog');
    trigger.setAttribute('aria-expanded','false');
    trigger.innerHTML='<span class="sim-dot" aria-hidden="true"></span><span id="sim-trigger-date">Sim</span>';
    trigger.addEventListener('click',toggleDrawer);

    const drawer=document.createElement('aside');
    drawer.id='sim-drawer';
    drawer.setAttribute('role','dialog');
    drawer.setAttribute('aria-label','Company simulator');
    drawer.setAttribute('aria-hidden','true');
    drawer.innerHTML=`<div class="sim-drawer-header"><strong>Company simulator</strong>
      <a href="/dashboard.html" data-exit-sim class="sim-exit-link">Exit simulation</a>
      <button type="button" class="sim-close-btn" aria-label="Close">&times;</button></div>
      <div class="sim-drawer-body">
      <p><strong>Scenario 1</strong> · Mid-size AI SaaS company · 100 developers · 3 departments · chatbot + engineering tools</p>
      <p>90 days of history. Shared projects, individual keys, unassigned spend, and delayed Google billing. Key ownership does not identify every person who used it.</p>
      <div class="sim-actions"><button class="btn btn-sm" data-action="reset">Load / reset Scenario 1</button><button class="btn btn-sm" data-action="day">Advance one day</button><button class="btn btn-sm" data-action="month">Advance one month</button><button class="btn btn-sm" data-action="play">Autoplay</button><button class="btn btn-sm" data-action="pause">Pause</button><button class="btn btn-sm" data-action="spike">Trigger spending spike</button><button class="btn btn-sm" data-action="refresh">Refresh state</button></div>
      <p id="sim-status" role="status" aria-live="polite"></p><p class="sim-hint">Autoplay advances one day per completed step while this page is open, updating in place. A triggered spike affects today's OpenAI chatbot usage; advance a day to see it billed. Reset restores the same dates and company.</p>
      <details><summary>Captured alerts and digests <span id="sim-message-count"></span></summary><div id="sim-messages"></div></details>
      </div>`;

    document.body.append(trigger,drawer);
    drawer.addEventListener('click',e=>{
      if(e.target.closest('.sim-close-btn')){setDrawerOpen(false);return;}
      const action=e.target.closest('[data-action]')?.dataset.action;if(action)act(action);
    });
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&drawer.classList.contains('open'))setDrawerOpen(false);});
    setDrawerOpen(sessionStorage.getItem('camaze-sim-drawer')==='open');
  }

  function setDrawerOpen(open) {
    const drawer=document.getElementById('sim-drawer');
    const trigger=document.getElementById('sim-trigger');
    drawer.classList.toggle('open',open);
    drawer.setAttribute('aria-hidden',String(!open));
    trigger.setAttribute('aria-expanded',String(open));
    try{sessionStorage.setItem('camaze-sim-drawer',open?'open':'closed');}catch(e){}
    if(open){const first=drawer.querySelector('.sim-actions button');first?.focus();}
  }
  function toggleDrawer(){setDrawerOpen(!document.getElementById('sim-drawer').classList.contains('open'));}

  function render(messages=[]) {
    const dateStr=new Date(environment.business_now).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
    const trigger=document.getElementById('sim-trigger');
    document.getElementById('sim-trigger-date').textContent=dateStr;
    trigger.classList.toggle('is-playing',!!environment.playing);
    trigger.classList.toggle('is-error',!!environment.error);
    trigger.title='Simulated date: '+new Date(environment.business_now).toLocaleDateString('en-US',{dateStyle:'long',timeZone:'UTC'})+' · '+(environment.playing?'Playing':environment.status==='ready'?'Paused':environment.status);
    status(environment.error || (environment.status==='empty'?'Ready to load Scenario 1.':'Scenario '+environment.scenario_version+' · revision '+environment.revision));
    const box=document.getElementById('sim-messages');box.replaceChildren();
    document.getElementById('sim-message-count').textContent='('+messages.length+')';
    if(!messages.length)box.textContent='No messages captured yet.';
    for(const m of messages){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent=m.business_date.slice(0,10)+' — '+m.subject;const pre=document.createElement('pre');pre.textContent=m.body;details.append(summary,pre);box.append(details);}
  }
  function schedule(){clearTimeout(timer);if(environment?.playing && environment.status==='ready')timer=setTimeout(()=>act('day'),5000);}

  // Re-fetches environment + messages and re-renders the drawer/trigger in
  // place, then hands off to whichever page registered a refresh hook (see
  // window.camazeSimRefresh) so its own view picks up the new data — no
  // navigation, no full reload.
  async function refreshState() {
    const data=await request('state');
    environment=data.environment;
    render(data.messages);
    try{window.camazeSimRefresh && window.camazeSimRefresh();}catch(e){}
  }

  async function act(action) {
    if(busy)return;
    clearTimeout(timer);busy=true;
    document.querySelectorAll('#sim-drawer .sim-actions button').forEach(b=>b.disabled=true);
    status(action==='month'?'Advancing each day and checking alerts. This may take a minute…':action==='reset'?'Loading provider history and company assignments…':'Updating simulation…');
    try{
      if(action==='refresh'){await refreshState();return;}
      if(!environment)throw new Error('Simulator access or setup is unavailable.');
      await request('control',{action,revision:environment.revision});
      // Reset swaps the entire company/dataset out from under every open
      // page — a full reload is the right call there. Every other action
      // (day/month/play/pause/spike) only changes numbers this page's own
      // fetch+render can pick up, so it updates in place instead.
      if(action==='reset'){location.reload();return;}
      await refreshState();
    }catch(error){status(error.message);}
    finally{busy=false;document.querySelectorAll('#sim-drawer .sim-actions button').forEach(b=>b.disabled=false);schedule();}
  }

  if(active){
    // Keep generated product links within the simulator; Exit is explicit.
    document.addEventListener('click',e=>{const a=e.target.closest('a');if(!a||a.hasAttribute('data-exit-sim'))return;const u=new URL(a.href,location.href);if(u.origin===location.origin&&/^\/(dashboard|assignments|integrations|notifications|insights)\.html$/.test(u.pathname)){a.href='/sim'+u.pathname+u.search+u.hash;}});
  }
})();
