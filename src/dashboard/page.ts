// The operator dashboard: one self-contained vanilla-JS page served from the
// same Express server as the API. It polls the API every 1.5s and renders the
// approved catalog, run history and live status, per-run detail (redacted
// inputs, outputs, business codes, failure class/disposition, step timings,
// stability, events, evidence), and the integrated intervention queue. It reads
// only through the API, so it can show nothing the API would not already serve.
export const dashboardHtml = `<!doctype html><html><head><meta charset="utf-8"><title>MERIDIAN Automation Dashboard</title><style>
:root{--ink:#17202a;--line:#c3ccd6;--head:#173b5f;--muted:#5b6b7b;--ok:#0a7d33;--warn:#a35b00;--bad:#a01515;--wait:#7a4fd0}
*{box-sizing:border-box}body{font:13px/1.5 system-ui,Segoe UI,sans-serif;margin:0;background:#eef1f4;color:var(--ink)}
header{background:var(--head);color:#fff;padding:14px 22px}header h1{margin:0;font-size:16px}
main{display:grid;grid-template-columns:340px 1fr;gap:16px;padding:16px 22px;max-width:1280px;margin:auto}
.col{min-width:0}h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 8px}
.card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px;margin-bottom:8px}
.cap{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.name{font-weight:600}.ref{color:var(--muted);font-size:11px}
.tag{font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:10px;border:1px solid currentColor;white-space:nowrap}
.read_only{color:var(--ok)}.mutating{color:var(--warn)}.irreversible{color:var(--bad)}
.run{cursor:pointer}.run:hover{border-color:#8aa}.run.sel{border-color:var(--head);box-shadow:0 0 0 1px var(--head)}
.st{font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:10px;color:#fff;white-space:nowrap}
.st.success{background:var(--ok)}.st.failed{background:var(--bad)}.st.business_outcome{background:var(--warn)}
.st.running,.st.queued{background:#4a6fa5}.st.waiting_for_human,.st.escalated{background:var(--wait)}
.kv{display:grid;grid-template-columns:130px 1fr;gap:2px 10px}.kv div:nth-child(odd){color:var(--muted)}
pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border:1px solid var(--line);border-radius:4px;padding:8px;margin:0;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid var(--line);padding:3px 6px;text-align:left}
.ev{font-family:ui-monospace,monospace;font-size:11px;border-bottom:1px dashed var(--line);padding:2px 0}
.notice{background:#fff6e6;border:1px solid #e3c37a;border-radius:4px;padding:8px;color:var(--warn)}
button{font:inherit;padding:6px 10px;border:1px solid var(--head);background:var(--head);color:#fff;border-radius:4px;cursor:pointer}
input{font:inherit;padding:5px 7px;border:1px solid var(--line);border-radius:4px}
a{color:#0645ad}.muted{color:var(--muted)}
</style></head><body>
<header><h1>MERIDIAN Automation Dashboard</h1><div class="muted" style="color:#cdd8e6">record once · replay deterministically · humans hold the irreversible boundary</div></header>
<main>
  <section class="col">
    <h2>Interventions</h2><div id="interventions"><div class="card muted">None waiting.</div></div>
    <h2>Capabilities</h2><div id="catalog"></div>
  </section>
  <section class="col">
    <h2>Chatbot</h2>
    <div class="card">
      <div id="chatlog" style="max-height:280px;overflow:auto"><div class="muted">Ask about members, balances, shares. Data-changing requests ask to confirm; transfers and holds pause for a human.</div></div>
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
let selected=null, lastRunSig='', lastCapSig='', lastIntSig='';
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const stateLabel=s=>({queued:'Queued',running:'Running',waiting_for_human:'Escalated — waiting for human',escalated:'Escalated — waiting for human',success:'Success',business_outcome:'Business outcome',failed:'Failed'}[s]||s);
async function j(u){const r=await fetch(u);if(!r.ok)throw new Error(u+' '+r.status);return r.json();}

async function poll(){
  try{
    const [caps,runs,ints]=await Promise.all([j('/api/capabilities'),j('/api/runs'),j('/api/interventions')]);
    renderCatalog(caps.capabilities||[]);
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
    return \`<div class="card"><div class="cap"><span class="name">\${esc(i.capability)} · \${esc(i.step)}</span><span class="st waiting_for_human">\${esc(i.status)}</span></div><div class="ref">\${esc(i.reason||i.intent||'')}</div><div style="margin-top:6px">\${controls}</div></div>\`;
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
  else if(res.status==='failure'&&res.failure) outcome=\`<div class="notice">Failure — class <b>\${esc(res.failure.class)}</b>, disposition <b>\${esc(res.failure.disposition)}</b>. \${esc(res.failure.observed||'')}</div>\`;
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
    if(m.role==='user')return \`<div style="margin:6px 0"><b>You:</b> \${esc(m.text)}</div>\`;
    const tag=m.action?\`<span class="tag" style="color:\${actionTag(m.action)}">\${esc(m.action)}</span> \`:'';
    const isLast=i===chatlog.length-1;
    const confirm=(m.action==='confirmation_required'&&isLast&&pendingMessage)?\` <button onclick="confirmChat()">Confirm &amp; run</button>\`:'';
    return \`<div style="margin:6px 0"><b>Bot:</b> \${tag}\${esc(m.text)}\${confirm}</div>\`;
  }).join('');
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
