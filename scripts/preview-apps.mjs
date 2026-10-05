// Local MCP Apps host for manual visual QA. Uses the built server and real tools.
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
process.env.AMIRA_LIVE_REFRESH = "0";
process.env.AMIRA_TOOL_PROFILE = "full";
const { createAmiraServer } = await import("../server/lib.js");
const server = createAmiraServer({ openai: true });
const client = new Client({ name: "app-preview", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);
const apps = {
  graph: { tool: "get_entity_graph", args: null }, map: { tool: "list_locations", args: { limit: 100 } },
  bibliography: { tool: "search_publications", args: { limit: 20 } }, timeline: { tool: "list_years", args: { bucket: "decade" } },
  related: { tool: "find_related", args: { entity_type: "subject", value: "decoloniality" } },
  overview: { tool: "get_collection_overview", args: {} }, sections: { tool: "list_research_sections", args: {} },
};
const resolved = await client.callTool({ name: "resolve_entity", arguments: { query: "Katharina Greven", type: "person" } });
apps.graph.args = { seed: resolved.structuredContent.results[0]?.id ?? "person:1" };
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AMIRA app preview</title>
<style>body{font:14px system-ui;background:#eceae4;margin:20px;color:#33291f}nav{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}iframe{display:block;border:1px solid #aaa;background:#fdfcfa;max-width:100%;min-height:800px}select,button{font:inherit;padding:6px}#state{margin:12px 0}</style></head><body>
<nav><label>App <select id="app">${Object.keys(apps).map((key) => `<option>${key}</option>`).join("")}</select></label><label>Width <select id="width"><option value="960">Desktop</option><option value="375">Mobile</option></select></label><label>Theme <select id="theme"><option>light</option><option>dark</option></select></label></nav><p id="state" role="status"></p><iframe id="frame" title="AMIRA research app"></iframe>
<script>
const configurations=${JSON.stringify(apps)}, frame=document.getElementById('frame');
const initial=new URL(location.href).searchParams;
document.getElementById('app').value=initial.get('app')||'graph';
document.getElementById('width').value=initial.get('width')||'960';
document.getElementById('theme').value=initial.get('theme')||'light';
function send(message){frame.contentWindow.postMessage(Object.assign({jsonrpc:'2.0'},message),location.origin);}
async function call(name,args){const r=await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});return r.json();}
function theme(){const value=document.getElementById('theme').value;frame.style.background=value==='dark'?'#1b211e':'#fdfcfa';return value;}
function load(){frame.style.width=document.getElementById('width').value+'px';frame.src='/frame?app='+document.getElementById('app').value;theme();}
document.getElementById('app').onchange=load;document.getElementById('width').onchange=load;document.getElementById('theme').onchange=()=>send({method:'ui/notifications/host-context-changed',params:{theme:theme()}});
window.addEventListener('message',async(event)=>{
 if(event.source!==frame.contentWindow||event.origin!==location.origin)return;const m=event.data;
 if(m.method==='ui/initialize')send({id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'AMIRA preview',version:'1'},hostCapabilities:{serverTools:{},openLinks:{},downloadFile:{}},hostContext:{theme:theme(),displayMode:'inline',containerDimensions:{maxWidth:Number(document.getElementById('width').value)}}}});
 else if(m.method==='ui/notifications/initialized'){const c=configurations[document.getElementById('app').value];send({method:'ui/notifications/tool-input',params:{arguments:c.args}});send({method:'ui/notifications/tool-result',params:await call(c.tool,c.args)});}
 else if(m.method==='tools/call')send({id:m.id,result:await call(m.params.name,m.params.arguments)});
 else if(m.method==='ui/notifications/size-changed')frame.style.height=Math.min(6000,m.params.height||800)+'px';
 else if(m.id!==undefined){document.getElementById('state').textContent=m.method==='ui/download-file'?'Download requested':m.method;window.lastHostRequest=m;send({id:m.id,result:{}});}
});load();
</script></body></html>`;
const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); }
    else if (req.method === "GET" && url.pathname === "/frame") {
      const name = url.searchParams.get("app");
      if (!Object.hasOwn(apps, name)) { res.writeHead(404).end(); return; }
      const result = await client.readResource({ uri: `ui://amira/${name}` });
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(result.contents[0].text);
    } else if (req.method === "POST" && url.pathname === "/call") {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 20_000) throw new Error("Request too large"); }
      const result = await client.callTool(JSON.parse(body));
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
    } else res.writeHead(404).end();
  } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message })); }
});
http.listen(Number(process.env.AMIRA_PREVIEW_PORT ?? 8790), "127.0.0.1", () => console.log(`AMIRA preview: http://127.0.0.1:${http.address().port}`));
process.once("SIGINT", async () => { http.closeAllConnections(); http.close(); await client.close(); await server.close(); });
