import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { RunController } from "./controller.js";

const html = `<!doctype html><html><head><meta charset="utf-8"><title>CorePoint Operator Console</title><style>
body{font:14px system-ui;margin:0;background:#eef1f4;color:#17202a}header{padding:16px 24px;background:#173b5f;color:white}main{padding:24px;max-width:1000px;margin:auto}.card{background:white;border:1px solid #b8c1c9;padding:18px;margin:12px 0}button{padding:8px 12px;margin-right:8px}pre{white-space:pre-wrap}img{max-width:100%;border:1px solid #aaa}.badge{font-weight:bold;text-transform:uppercase}</style></head><body><header><h1>Computer-Use Intervention Queue</h1></header><main id="queue">Loading…</main><script>
const queue=document.getElementById('queue');
async function post(url,body){await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});await refresh()}
async function refresh(){const items=await (await fetch('/api/interventions')).json();queue.innerHTML=items.length?'':'<div class="card">No interventions waiting.</div>';for(const item of items){const el=document.createElement('section');el.className='card';el.innerHTML='<span class="badge">'+item.status+'</span><h2>'+item.capability+' · '+item.step+'</h2><p><strong>Intent:</strong> '+item.intent+'</p><p><strong>Why paused:</strong> '+item.reason+'</p><p><strong>Requested:</strong> '+item.requestedAction+'</p><pre>'+JSON.stringify(item,null,2)+'</pre>';if(item.screenshot)el.innerHTML+='<img src="'+item.screenshot+'">';if(item.status==='waiting'){const b=document.createElement('button');b.textContent='Take control';b.onclick=()=>{const operator=prompt('Operator identity');if(operator)post('/api/interventions/'+item.id+'/take',{operator})};el.appendChild(b)}if(item.status==='human_control'){const b=document.createElement('button');b.textContent='Hand back';b.onclick=()=>post('/api/interventions/'+item.id+'/hand-back',{});el.appendChild(b)}queue.appendChild(el)}}
refresh();setInterval(refresh,1500);
</script></body></html>`;

export function createConsoleApp(controller: RunController) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.get("/", (_request, response) => response.type("html").send(html));
  app.get("/api/interventions", (_request, response) => response.json(controller.list()));
  app.post("/api/interventions/:id/take", async (request, response, next) => {
    try { response.json(await controller.takeControl(String(request.params.id), String(request.body.operator ?? ""))); } catch (error) { next(error); }
  });
  app.post("/api/interventions/:id/hand-back", async (request, response, next) => {
    try { response.json(await controller.handBack(String(request.params.id))); } catch (error) { next(error); }
  });
  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => response.status(409).json({ error: error.message }));
  return app;
}

export async function startConsole(controller: RunController, port = 4590): Promise<Server> {
  const server = createConsoleApp(controller).listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  return server;
}
