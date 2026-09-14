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
      if (environment.status !== 'ready') throw new Error(environment.status === 'empty' ? 'Load Scenario 1 using the simulation panel above.' : 'Simulation ' + environment.status + '. Use the panel to refresh or reset.');
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
    if(document.getElementById('simulation-panel'))return;
    const panel=document.createElement('aside');panel.id='simulation-panel';
    panel.innerHTML=`<div class="sim-strip"><strong>SIMULATION ENVIRONMENT</strong><span id="sim-date">Checking access…</span><a href="/dashboard.html" data-exit-sim>Exit simulation</a></div>
      <details id="sim-details"><summary>Company simulator · Scenario 1</summary><div class="sim-panel-body">
      <p><strong>Mid-size AI SaaS company</strong> · 100 developers · 3 departments · chatbot + engineering tools</p>
      <p>90 days of history. Shared projects, individual keys, unassigned spend, and delayed Google billing. Key ownership does not identify every person who used it.</p>
      <div class="sim-actions"><button data-action="reset">Load / reset Scenario 1</button><button data-action="day">Advance one day</button><button data-action="month">Advance one month</button><button data-action="play">Autoplay</button><button data-action="pause">Pause</button><button data-action="spike">Trigger spending spike</button><button data-action="refresh">Refresh state</button></div>
      <p id="sim-status" role="status" aria-live="polite"></p><p class="sim-hint">Autoplay advances one day per completed step while this page is open. A triggered spike affects today’s OpenAI chatbot usage; advance a day to see it billed. Reset restores the same dates and company.</p>
      <details><summary>Captured alerts and digests <span id="sim-message-count"></span></summary><div id="sim-messages"></div></details>
      </div></details>`;
    document.body.prepend(panel);
    document.getElementById('sim-details').open = sessionStorage.getItem('camaze-sim-panel') !== 'closed';
    document.getElementById('sim-details').addEventListener('toggle', e => sessionStorage.setItem('camaze-sim-panel',e.target.open?'open':'closed'));
    panel.addEventListener('click',e=>{const action=e.target.closest('[data-action]')?.dataset.action;if(action)act(action);});
  }
  function render(messages=[]) {
    document.getElementById('sim-date').textContent=new Date(environment.business_now).toLocaleDateString('en-US',{dateStyle:'long',timeZone:'UTC'})+' · '+(environment.playing?'Playing':environment.status==='ready'?'Paused':environment.status);
    status(environment.error || (environment.status==='empty'?'Ready to load Scenario 1.':'Scenario '+environment.scenario_version+' · revision '+environment.revision));
    const box=document.getElementById('sim-messages');box.replaceChildren();
    document.getElementById('sim-message-count').textContent='('+messages.length+')';
    if(!messages.length)box.textContent='No messages captured yet.';
    for(const m of messages){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent=m.business_date.slice(0,10)+' — '+m.subject;const pre=document.createElement('pre');pre.textContent=m.body;details.append(summary,pre);box.append(details);}
  }
  function schedule(){clearTimeout(timer);if(environment?.playing && environment.status==='ready')timer=setTimeout(()=>act('day'),5000);}
  async function act(action) {
    if(busy)return;
    clearTimeout(timer);busy=true;
    document.querySelectorAll('#simulation-panel button').forEach(b=>b.disabled=true);
    status(action==='month'?'Advancing each day and checking alerts. This may take a minute…':action==='reset'?'Loading provider history and company assignments…':'Updating simulation…');
    try{
      if(action==='refresh'){location.reload();return;}
      if(!environment)throw new Error('Simulator access or setup is unavailable.');
      await request('control',{action,revision:environment.revision});
      location.reload();
    }catch(error){status(error.message);busy=false;document.querySelectorAll('#simulation-panel button').forEach(b=>b.disabled=false);}
  }
  if(active){
    // Keep generated product links within the simulator; Exit is explicit.
    document.addEventListener('click',e=>{const a=e.target.closest('a');if(!a||a.hasAttribute('data-exit-sim'))return;const u=new URL(a.href,location.href);if(u.origin===location.origin&&/^\/(dashboard|assignments|integrations|notifications|insights)\.html$/.test(u.pathname)){a.href='/sim'+u.pathname+u.search+u.hash;}});
  }
})();
