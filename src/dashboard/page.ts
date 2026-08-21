// The operator dashboard: one self-contained vanilla-JS page served from the
// same Express server as the API. It polls the API every 1.5s and renders the
// approved catalog, run history and live status, per-run detail (redacted
// inputs, outputs, business codes, failure class/disposition, step timings,
// stability, events, evidence), and the integrated intervention queue. It reads
// only through the API, so it can show nothing the API would not already serve.
export const dashboardHtml = `<!doctype html><html><head><meta charset="utf-8"><title>MERIDIAN Automation Dashboard</title><style>
:root{
  --bg:#eaeef3;--panel:#fff;--ink:#1e293b;--muted:#647387;--line:#e4e9f0;--soft:#f2f5f9;
  --head1:#0e2033;--head2:#1c3a5b;--accent:#2456a6;--accent-d:#1c4585;
  --ok:#15803d;--ok-bg:#dcfce7;--warn:#b45309;--warn-bg:#fbedcf;--bad:#b91c1c;--bad-bg:#fbe0e0;
  --wait:#6d28d9;--wait-bg:#ebe6fc;--info:#1d4ed8;--info-bg:#dbe6fb}
*{box-sizing:border-box}
body{font:13.5px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
header{background:linear-gradient(120deg,var(--head1),var(--head2));color:#fff;padding:15px 26px;position:sticky;top:0;z-index:10;box-shadow:0 1px 10px rgba(14,32,51,.2)}
header .wrap{max-width:1300px;margin:auto;display:flex;align-items:center;gap:14px}
header h1{margin:0;font-size:16px;font-weight:650;letter-spacing:.01em}
header .sub{color:#b6c5d8;font-size:11.5px;margin-top:3px}
header .live{margin-left:auto;font-size:11px;color:#cfe0f0;text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:7px}
header .live::before{content:"";width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.25);animation:pulse 1.6s infinite}
main{display:grid;grid-template-columns:356px 1fr;gap:20px;padding:20px 26px;max-width:1300px;margin:auto}
@media(max-width:860px){main{grid-template-columns:1fr}}
.col{min-width:0}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:700;margin:20px 0 9px}
h2:first-child{margin-top:2px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 14px;margin-bottom:9px;box-shadow:0 1px 2px rgba(16,24,40,.05)}
.card.draft{border-left:3px solid var(--wait)}
.card.attention{border-left:3px solid var(--wait);background:linear-gradient(90deg,rgba(109,40,217,.05),var(--panel) 40%)}
.pill{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--wait);margin-top:5px}
.cap{display:flex;justify-content:space-between;gap:10px;align-items:center}
.name{font-weight:600;color:var(--ink)}
.ref{color:var(--muted);font-size:11px;margin-top:3px;word-break:break-word}
.tag{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 8px;border-radius:999px;border:1px solid currentColor;background:color-mix(in srgb,currentColor 12%,#fff);white-space:nowrap}
.read_only{color:var(--ok)}.mutating{color:var(--warn)}.irreversible{color:var(--bad)}
.run{cursor:pointer;transition:border-color .12s,box-shadow .12s}
.run:hover{border-color:#b6c6db;box-shadow:0 2px 9px rgba(16,24,40,.09)}
.run.sel{border-color:var(--accent);box-shadow:0 0 0 2px rgba(36,86,166,.18)}
.st{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:3px 9px;border-radius:999px;white-space:nowrap;display:inline-flex;align-items:center}
.st.success{background:var(--ok-bg);color:var(--ok)}
.st.failed{background:var(--bad-bg);color:var(--bad)}
.st.business_outcome{background:var(--warn-bg);color:var(--warn)}
.st.running,.st.queued{background:var(--info-bg);color:var(--info)}
.st.waiting_for_human,.st.escalated{background:var(--wait-bg);color:var(--wait)}
.st.running::before,.st.queued::before,.st.waiting_for_human::before,.st.escalated::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:6px;animation:pulse 1.3s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.kv{display:grid;grid-template-columns:140px 1fr;gap:4px 12px}.kv div:nth-child(odd){color:var(--muted)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);border:1px solid var(--line);border-radius:7px;padding:10px;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
table{border-collapse:collapse;width:100%;font-size:12px;margin-top:4px}
th{background:var(--soft);font-weight:600}td,th{border:1px solid var(--line);padding:5px 8px;text-align:left}
tr:nth-child(even) td{background:#fafbfc}
.ev{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#4a5a6d;border-bottom:1px solid var(--soft);padding:3px 0}
.ev:last-child{border-bottom:0}
.notice{background:var(--warn-bg);border:1px solid #eccf93;color:#7c4a06;border-radius:8px;padding:10px 12px;margin-top:4px}
.notice.bad{background:var(--bad-bg);border-color:#f0b4b4;color:#8a1414}
button{font:inherit;font-weight:550;padding:7px 13px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:7px;cursor:pointer;transition:background .12s,transform .05s}
button:hover{background:var(--accent-d)}button:active{transform:translateY(1px)}
input{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:#fff;transition:border-color .12s,box-shadow .12s}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(36,86,166,.14)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.muted{color:var(--muted)}
.chatlog{max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:9px;padding:2px}
.msg{max-width:86%;padding:8px 11px;border-radius:13px;font-size:12.5px;line-height:1.45;word-wrap:break-word}
.msg.user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}
.msg.bot{align-self:flex-start;background:var(--soft);border:1px solid var(--line);border-bottom-left-radius:4px}
.msg .who{font-size:9px;text-transform:uppercase;letter-spacing:.04em;opacity:.75;font-weight:700;margin-bottom:3px}
.msg.user .who{color:#dce7f6}
</style></head><body>
<header><div class="wrap"><div><h1>MERIDIAN Automation Dashboard</h1><div class="sub">record once · replay deterministically · humans hold the irreversible boundary</div></div><div class="live">Live</div></div></header>
<main>
  <section class="col">
    <h2>Interventions</h2><div id="interventions"><div class="card muted">None waiting.</div></div>
    <h2>Capabilities</h2><div id="catalog"></div>
    <h2>Proposed repairs</h2><div id="drafts"><div class="card muted">None.</div></div>
  </section>
  <section class="col">
    <h2>Chatbot</h2>
    <div class="card">
      <div id="chatlog" class="chatlog"><div class="muted">Ask about members, balances, shares. Data-changing requests ask to confirm; transfers and holds pause for a human.</div></div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <input id="chatinput" style="flex:1" placeholder="e.g. find members named Turing" onkeydown="if(event.key==='Enter')sendChat()">
        <button onclick="sendChat()">Send</button>
      </div>
    </div>
    <h2>Runs</h2><div id="runs" style="max-height:34vh;overflow-y:auto"></div>
    <h2>Run detail</h2><div id="detail"><div class="card muted">Select a run.</div></div>
  </section>
</main>
<script>
const $=id=>document.getElementById(id);
let selected=null, lastRunSig='', lastCapSig='', lastIntSig='', lastDraftSig='';
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const stateLabel=s=>({queued:'Queued',running:'Running',waiting_for_human:'Escalated — waiting for human',escalated:'Escalated — waiting for human',success:'Success',business_outcome:'Business outcome',failed:'Failed'}[s]||s);
async function j(u){const r=await fetch(u);if(!r.ok)throw new Error(u+' '+r.status);return r.json();}

async function poll(){
  try{
    const [caps,runs,ints,drafts]=await Promise.all([j('/api/capabilities'),j('/api/runs'),j('/api/interventions'),j('/api/drafts')]);
    renderCatalog(caps.capabilities||[]);
    renderDrafts(drafts.drafts||[]);
    // A run with a pending intervention is paused for a human right now, even if
    // its stored state has not been rewritten - show that plainly.
    const waiting=new Set((ints||[]).filter(i=>i.status==='waiting'||i.status==='human_control').map(i=>i.runId));
    renderRuns(runs.runs||[], waiting);
    renderInterventions(ints||[]);
    if(selected) await renderDetail(selected);
  }catch(e){/* transient during a run; next tick recovers */}
}

function renderCatalog(list){
  const sig=JSON.stringify(list.map(c=>[c.reference,c.risk]));if(sig===lastCapSig)return;lastCapSig=sig;
  $('catalog').innerHTML=list.map(c=>\`<div class="card"><div class="cap"><span class="name">\${esc(c.tool.name)}</span><span class="tag \${c.risk}">\${c.risk.replace('_',' ')}</span></div><div class="ref">\${esc(c.reference)}\${c.requires_human?' · needs human':''}</div></div>\`).join('')||'<div class="card muted">No approved capabilities.</div>';
}

function renderDrafts(list){
  const sig=JSON.stringify(list.map(d=>[d.reference,!!d.repair]));if(sig===lastDraftSig)return;lastDraftSig=sig;
  $('drafts').innerHTML=list.map(d=>{
    const r=d.repair;
    const head=r?'Proposed repair — awaiting approval':'Draft — awaiting approval';
    const detail=r?\`from \${esc(r.from_version)} · step \${esc(r.step)} · ladder \${esc(r.strategies_before)}→\${esc(r.strategies_after)}\`:'';
    return \`<div class="card draft"><div class="cap"><span class="name">\${esc(d.id)}</span><span class="tag \${esc(d.risk)}">\${esc(d.risk.replace('_',' '))}</span></div><div class="ref">\${esc(d.reference)}</div><div class="pill">\${head}</div>\${detail?\`<div class="ref">\${detail}</div>\`:''}</div>\`;
  }).join('')||'<div class="card muted">None.</div>';
}

function renderRuns(list,waiting){
  waiting=waiting||new Set();
  const sig=JSON.stringify(list.map(r=>[r.runId,r.state,waiting.has(r.runId)]));if(sig===lastRunSig&&!selected)return;lastRunSig=sig;
  $('runs').innerHTML=list.map(r=>{const state=waiting.has(r.runId)?'waiting_for_human':r.state;return \`<div class="card run \${r.runId===selected?'sel':''}" onclick="select('\${esc(r.runId)}')"><div class="cap"><span class="name">\${esc(r.capability||r.runId)}</span><span class="st \${state}">\${stateLabel(state)}</span></div><div class="ref">\${esc(r.type)} · \${esc(r.runId)}</div></div>\`;}).join('')||'<div class="card muted">No runs yet.</div>';
}

function renderInterventions(list){
  const sig=JSON.stringify(list.map(i=>[i.id,i.status]));if(sig===lastIntSig)return;lastIntSig=sig;
  if(!list.length){$('interventions').innerHTML='<div class="card muted">None waiting.</div>';return;}
  $('interventions').innerHTML=list.map(i=>{
    const controls=i.status==='waiting'
      ?\`<input id="op_\${esc(i.id)}" value="operator@interface.test"> <button onclick="take('\${esc(i.id)}')">Take control</button>\`
      :i.status==='human_control'?\`<button onclick="handBack('\${esc(i.id)}')">Hand back</button>\`:'';
    return \`<div class="card attention"><div class="cap"><span class="name">\${esc(i.capability)} · \${esc(i.step)}</span><span class="st waiting_for_human">\${esc(i.status)}</span></div><div class="ref">\${esc(i.reason||i.intent||'')}</div><div style="margin-top:8px">\${controls}</div></div>\`;
  }).join('');
}

async function take(id){const op=($('op_'+id)||{}).value||'operator';await fetch('/api/interventions/'+id+'/take',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operator:op})});lastIntSig='';poll();}
async function handBack(id){await fetch('/api/interventions/'+id+'/hand-back',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});lastIntSig='';poll();}
function select(id){selected=id;lastRunSig='';poll().then(()=>{const d=$('detail');if(d)d.scrollIntoView({behavior:'smooth',block:'start'});});}

async function renderDetail(id){
  let run;try{run=await j('/api/runs/'+id);}catch{ $('detail').innerHTML='<div class="card muted">Run not found.</div>';return;}
  let events=[],files=[];
  try{events=(await j('/api/runs/'+id+'/events')).events||[];}catch{}
  try{files=(await j('/api/runs/'+id+'/evidence')).files||[];}catch{}
  const res=run.result||{};
  const timings=events.filter(e=>e.type==='step_completed').map(e=>\`step \${e.step} (\${esc(e.stepId)}): \${e.durationMs} ms\`);
  const withheld=events.some(e=>e.type==='screenshots_withheld');
  const notable=events.filter(e=>['policy_check','action','detector_hit','recovery_applied','intervention_requested','human_step_recorded','fault_injected','step_completed','screenshots_withheld','result'].includes(e.type));
  const inputsEvent=events.find(e=>e.type==='run_inputs');
  const inputs=inputsEvent?\`<h2>Inputs</h2><pre>\${esc(JSON.stringify(inputsEvent.inputs,null,2))}</pre>\`:'';
  let outcome='';
  if(res.status==='success') outcome=\`<h2>Outputs</h2><pre>\${esc(JSON.stringify(res.outputs,null,2))}</pre>\`;
  else if(res.status==='business_outcome') outcome=\`<div class="notice">Business outcome: <b>\${esc(res.code)}</b> — a legitimate answer from the application, not an automation error.</div>\`;
  else if(res.status==='failure'&&res.failure) outcome=\`<div class="notice bad">Failure — class <b>\${esc(res.failure.class)}</b>, disposition <b>\${esc(res.failure.disposition)}</b>. \${esc(res.failure.observed||'')}</div>\`;
  const stability=res.stability?\`<h2>Stability</h2><div class="kv"><div>Resolutions</div><div>\${res.stability.resolutions}</div><div>Matched strategies</div><div>\${esc(JSON.stringify(res.stability.matched_strategies))}</div></div>\`:'';
  const shots=files.filter(f=>/\\.png$/.test(f));
  const evidence=files.length?\`<h2>Evidence</h2>\${withheld?'<div class="notice">Screenshots were withheld from this run because a sensitive value was on screen; they cannot be redacted, so they are not saved.</div>':''}<div>\${files.map(f=>\`<a href="/api/runs/\${esc(id)}/evidence/\${esc(f)}" target="_blank">\${esc(f)}</a>\`).join(' · ')}</div>\${shots.map(f=>\`<div><img style="max-width:100%;border:1px solid #ccc;margin-top:6px" src="/api/runs/\${esc(id)}/evidence/\${esc(f)}"></div>\`).join('')}\`:'';
  $('detail').innerHTML=\`<div class="card">
    <div class="cap"><span class="name">\${esc(run.capability||run.runId)}</span><span class="st \${run.state}">\${stateLabel(run.state)}</span></div>
    <div class="ref">\${esc(run.type)} · \${esc(run.runId)} · requested \${esc(run.requestedAt||'')}</div>
    \${run.error?\`<div class="notice" style="margin-top:8px">\${esc(run.error)}</div>\`:''}
    \${inputs}
    \${outcome}
    \${timings.length?\`<h2>Step timings</h2><pre>\${esc(timings.join('\\n'))}</pre>\`:''}
    \${stability}
    <h2>Events</h2><div>\${notable.map(e=>\`<div class="ev">\${esc(e.at||'')} \${esc(e.type)} \${esc(summ(e))}</div>\`).join('')||'<span class="muted">No events recorded.</span>'}</div>
    \${evidence}
  </div>\`;
}
function summ(e){
  if(e.type==='policy_check')return (e.verdict&&e.verdict.allowed?'allowed':'BLOCKED '+(e.verdict&&e.verdict.detail||''));
  if(e.type==='action')return (e.action&&e.action.kind||'')+' → '+(e.resultUrl||'');
  if(e.type==='detector_hit')return e.detector+' ('+e.classification+')';
  if(e.type==='recovery_applied')return e.rule;
  if(e.type==='fault_injected')return e.kind;
  if(e.type==='step_completed')return 'step '+e.step+' '+e.durationMs+'ms';
  if(e.type==='result')return e.status||(e.detail&&e.detail.status)||'';
  if(e.type==='screenshots_withheld')return e.reason||'';
  if(e.type==='human_step_recorded')return (e.action&&e.action.kind||'');
  if(e.type==='intervention_requested')return 'paused for human';
  return '';
}
// Chat panel: posts to /api/chat, shows the reply and its action, and offers a
// Confirm button for a data-changing request. The reply text comes straight
// from the API's deterministic formatter - the page never phrases anything.
let chatlog=[], pendingMessage=null, chatBusy=false;
const actionTag=a=>({answered:'#0a7d33',clarification:'#4a6fa5',unsupported:'#5b6b7b',confirmation_required:'#a35b00',human_required:'#a01515',error:'#a01515'}[a]||'#5b6b7b');
function renderChat(){
  $('chatlog').innerHTML=chatlog.map((m,i)=>{
    if(m.role==='user')return \`<div class="msg user"><div class="who">You</div>\${esc(m.text)}</div>\`;
    const tag=m.action?\` <span class="tag" style="color:\${actionTag(m.action)}">\${esc(m.action)}</span>\`:'';
    const isLast=i===chatlog.length-1;
    const confirm=(m.action==='confirmation_required'&&isLast&&pendingMessage)?\`<div style="margin-top:8px"><button onclick="confirmChat()">Confirm &amp; run</button></div>\`:'';
    return \`<div class="msg bot"><div class="who">Assistant\${tag}</div>\${esc(m.text)}\${confirm}</div>\`;
  }).join('')||'<div class="muted">Ask about members, balances, shares. Data-changing requests ask to confirm; transfers and holds pause for a human.</div>';
  $('chatlog').scrollTop=$('chatlog').scrollHeight;
}
async function sendChat(message,confirm){
  if(chatBusy)return;
  const text=message!==undefined?message:$('chatinput').value.trim();if(!text)return;
  // Prior turns as the model sees them, captured BEFORE this message is added,
  // so a follow-up ("1234") is understood against the question it answers.
  const history=chatlog.filter(m=>m.text&&m.text!=='… working'&&m.action!=='error').slice(-12).map(m=>({role:m.role==='user'?'user':'assistant',content:String(m.text)}));
  if(message===undefined){chatlog.push({role:'user',text});$('chatinput').value='';}
  chatBusy=true;chatlog.push({role:'bot',text:'… working',action:''});renderChat();
  try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:text,history,...(confirm?{confirm:true}:{})})});
    const b=await r.json();chatlog.pop();
    chatlog.push({role:'bot',text:b.reply||b.error||'(no reply)',action:b.action||(b.error?'error':'')});
    pendingMessage=(b.action==='confirmation_required')?text:null;
  }catch(e){chatlog.pop();chatlog.push({role:'bot',text:'Error: '+e.message,action:'error'});}
  chatBusy=false;renderChat();poll();
}
function confirmChat(){if(pendingMessage){const m=pendingMessage;pendingMessage=null;sendChat(m,true);}}

poll();setInterval(poll,1500);
</script></body></html>`;
