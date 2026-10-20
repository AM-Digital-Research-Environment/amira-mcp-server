// Local MCP Apps host for manual visual QA. Uses the built server and real tools
// against the bundled data/ snapshot: the environment is made hermetic before
// the bundle loads (no AMIRA_* from the shell, live refresh off, a throwaway
// cache dir), so the preview never reads or writes ~/.amira-mcp/cache.
import { createServer } from "node:http";
import { hermeticEnv } from "../test/helpers/env.mjs";
import { connectInMemory } from "../test/helpers/mcp.mjs";
const previewPort = Number(process.env.AMIRA_PREVIEW_PORT ?? 8790); // read before hermeticEnv() clears it
hermeticEnv();
process.env.AMIRA_TOOL_PROFILE = "full";
const lib = await import("../server/lib.js");
const { client, server } = await connectInMemory(lib, { openai: true }, { name: "app-preview" });
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
async function call(name,args){const r=await fetch('/call'+(initial.has('pseudonymise')?'?pseudonymise':''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});return r.json();}
// ?seed= (a typed id or a name to resolve) and ?types= (comma-separated) set the graph's first call.
async function argsFor(app){const a=Object.assign({},configurations[app].args);if(app!=='graph')return a;const s=initial.get('seed');
 const first=async(args)=>((await call('resolve_entity',Object.assign({query:s,limit:1},args))).structuredContent||{}).results?.[0]?.id;
 if(s){if(/^[a-z_]+:\d+$/.test(s))a.seed=s;else{const id=(await first({type:'person'}))||(await first({}));if(id)a.seed=id;}}
 const t=initial.get('types');if(t)a.types=t.split(',');return a;}
function theme(){const value=document.getElementById('theme').value;frame.style.background=value==='dark'?'#1b211e':'#fdfcfa';return value;}
function load(){frame.style.width=document.getElementById('width').value+'px';frame.src='/frame?app='+document.getElementById('app').value;theme();}
document.getElementById('app').onchange=load;document.getElementById('width').onchange=load;document.getElementById('theme').onchange=()=>send({method:'ui/notifications/host-context-changed',params:{theme:theme()}});
window.addEventListener('message',async(event)=>{
 if(event.source!==frame.contentWindow||event.origin!==location.origin)return;const m=event.data;
 if(m.method==='ui/initialize')send({id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'AMIRA preview',version:'1'},hostCapabilities:{serverTools:{},openLinks:{},downloadFile:{}},hostContext:{theme:theme(),displayMode:'inline',containerDimensions:{maxWidth:Number(document.getElementById('width').value)}}}});
 else if(m.method==='ui/notifications/initialized'){const app=document.getElementById('app').value,c=configurations[app],args=await argsFor(app);send({method:'ui/notifications/tool-input',params:{arguments:args}});send({method:'ui/notifications/tool-result',params:await call(c.tool,args)});}
 else if(m.method==='tools/call')send({id:m.id,result:await call(m.params.name,m.params.arguments)});
 else if(m.method==='ui/notifications/size-changed')frame.style.height=Math.min(6000,m.params.height||800)+'px';
 else if(m.id!==undefined){document.getElementById('state').textContent=m.method==='ui/download-file'?'Download requested':m.method;window.lastHostRequest=m;send({id:m.id,result:{}});}
});load();
</script></body></html>`;
// ?pseudonymise replaces every person's name with R1, R2, … in order of first
// appearance, for figures in anonymised manuscripts. Display only: amira_url
// links still identify the records, so check a capture before sharing it.
const aliases = new Map();
function pseudonymise(result) {
  const walk = (value, visit) => Array.isArray(value) ? value.map((v) => walk(v, visit))
    : value && typeof value === "object" ? visit(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, visit)])))
    : value;
  const named = (o) => { if (o.type === "person" && typeof o.label === "string" && !aliases.has(o.label)) aliases.set(o.label, `R${aliases.size + 1}`); return o; };
  const swap = (s) => {
    for (const [name, alias] of aliases) {
      const [surname, forename] = name.split(/,\s*/);
      s = s.replaceAll(name, alias);
      if (forename) s = s.replaceAll(`${forename} ${surname}`, alias);
    }
    return s;
  };
  const rename = (value) => typeof value === "string" ? swap(value) : Array.isArray(value) ? value.map(rename)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "amira_url" || k === "id" ? v : rename(v)])) : value;
  if (!result.structuredContent) return;
  walk(result.structuredContent, named);
  result.structuredContent = rename(result.structuredContent);
  result.content = [{ type: "text", text: JSON.stringify(result.structuredContent) }];
}
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
      if (url.searchParams.has("pseudonymise")) pseudonymise(result);
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
    } else res.writeHead(404).end();
  } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message })); }
});
http.listen(previewPort, "127.0.0.1", () => console.log(`AMIRA preview: http://127.0.0.1:${http.address().port}`));
process.once("SIGINT", async () => { http.closeAllConnections(); http.close(); await client.close(); await server.close(); });
