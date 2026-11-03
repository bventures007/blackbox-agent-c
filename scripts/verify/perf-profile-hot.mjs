// PILOT-09 profile (ADR-0009): idle-install timing of one hot order-state request and one question through the API and
// engine-direct (from inside the api container with the engine token), plus RPC/auth floors.
//   node scripts/verify/perf-profile-hot.mjs [N=40] [tenant_index=0]   (env P = compose project)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
const POOLS = JSON.parse(readFileSync(process.env.HOME + "/blackbox-perf-keys-perf/pools.json", "utf8"));
const P = process.env.P ?? "blackbox-agent-c-perf";
const API = POOLS.api;
const N = Number(process.argv[2] ?? 40);
const tenantIdx = Number(process.argv[3] ?? 0);
const client = POOLS.clients.find((c) => c.tenant_index === tenantIdx);
const key = readFileSync(client.key_file, "utf8").trim();
const pool = POOLS.pools[client.tenant_id];
const orders = pool.hot.slice(0, N);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Number(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(1)); };
const summ = (name, arr, extra = {}) => console.log(JSON.stringify({ name, n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95), max: pct(arr, 1), ...extra }));

async function timed(fn) { const t0 = performance.now(); const r = await fn(); return [performance.now() - t0, r]; }

// 1. API hot state
{
  const ms = [], eng = [], bytes = [], missing = {};
  for (const o of orders) {
    const [t, r] = await timed(async () => { const res = await fetch(`${API}/api/entities/order/${encodeURIComponent(o)}/state`, { headers: { authorization: `Bearer ${key}` } }); const text = await res.text(); return { status: res.status, json: JSON.parse(text), len: text.length }; });
    ms.push(t); eng.push(r.json.duration_ms ?? -1); bytes.push(r.len);
    for (const m of r.json.missing_inputs ?? []) missing[m] = (missing[m] ?? 0) + 1;
    if (r.status !== 200 || r.json.consistency?.status !== "current") console.log("unexpected", r.status, r.json.consistency?.status);
  }
  summ("api.hot_state.total_ms", ms, { engine_duration_ms_p50: pct(eng, 0.5), engine_duration_ms_p95: pct(eng, 0.95), response_bytes_p50: pct(bytes, 0.5), response_bytes_max: pct(bytes, 1), missing_inputs: missing });
}
// 2. engine direct (from inside the api container)
{
  const script = `const fs=require('fs');const tok=fs.readFileSync('/run/secrets/engine_token','utf8').trim();const orders=${JSON.stringify(orders)};const tenant=${JSON.stringify(client.tenant_id)};(async()=>{const out=[];for(const o of orders){const t0=process.hrtime.bigint();const r=await fetch('http://engine:7070/v1/state',{method:'POST',headers:{'content-type':'application/json','x-engine-token':tok},body:JSON.stringify({tenant_id:tenant,entity_type:'order',entity_id:o,consistency:{mode:'latest_committed',deadline_ms:5000}})});const text=await r.text();const j=JSON.parse(text);out.push({ms:Number(process.hrtime.bigint()-t0)/1e6,eng:j.duration_ms,len:text.length,status:r.status,cons:j.consistency&&j.consistency.status,missing:j.missing_inputs})}console.log(JSON.stringify(out))})()`;
  const out = JSON.parse(execFileSync("docker", ["exec", `${P}-api`, "node", "-e", script], { encoding: "utf8" }));
  const missing = {}; for (const x of out) for (const m of x.missing ?? []) missing[m] = (missing[m] ?? 0) + 1;
  summ("engine.direct.v1_state.total_ms", out.map((x) => x.ms), { engine_duration_ms_p50: pct(out.map((x) => x.eng), 0.5), engine_duration_ms_p95: pct(out.map((x) => x.eng), 0.95), response_bytes_p50: pct(out.map((x) => x.len), 0.5), statuses: [...new Set(out.map((x) => x.status + "/" + x.cons))], missing_inputs: missing });
}
// 3. API question orders.payment_state
{
  const ms = [], eng = [], bytes = [];
  for (const o of orders) {
    const [t, r] = await timed(async () => { const res = await fetch(`${API}/api/questions/orders.payment_state`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ params: { order_id: o } }) }); const text = await res.text(); return { status: res.status, json: JSON.parse(text), len: text.length }; });
    ms.push(t); bytes.push(r.len);
    if (r.status !== 200) console.log("unexpected", r.status, JSON.stringify(r.json).slice(0, 200));
  }
  summ("api.question.payment_state.total_ms", ms, { response_bytes_p50: pct(bytes, 0.5) });
}
// 4. engine direct /v1/query
{
  const script = `const fs=require('fs');const tok=fs.readFileSync('/run/secrets/engine_token','utf8').trim();const orders=${JSON.stringify(orders)};const tenant=${JSON.stringify(client.tenant_id)};(async()=>{const out=[];for(const o of orders){const t0=process.hrtime.bigint();const r=await fetch('http://engine:7070/v1/query',{method:'POST',headers:{'content-type':'application/json','x-engine-token':tok},body:JSON.stringify({tenant_id:tenant,intent:'orders.payment_state',params:{order_id:o},consistency:{mode:'latest_committed',deadline_ms:5000},page:{limit:100}})});const text=await r.text();const j=JSON.parse(text);out.push({ms:Number(process.hrtime.bigint()-t0)/1e6,eng:j.duration_ms,len:text.length,status:r.status})}console.log(JSON.stringify(out))})()`;
  const out = JSON.parse(execFileSync("docker", ["exec", `${P}-api`, "node", "-e", script], { encoding: "utf8" }));
  summ("engine.direct.v1_query.total_ms", out.map((x) => x.ms), { engine_duration_ms_p50: pct(out.map((x) => x.eng), 0.5), response_bytes_p50: pct(out.map((x) => x.len), 0.5), statuses: [...new Set(out.map((x) => x.status))] });
}
// 5. engine /health timing (token check + db ping + json) as RPC floor, and api /api/health
{
  const script = `const fs=require('fs');const tok=fs.readFileSync('/run/secrets/engine_token','utf8').trim();(async()=>{const out=[];for(let i=0;i<20;i++){const t0=process.hrtime.bigint();const r=await fetch('http://engine:7070/v1/schema',{headers:{'x-engine-token':tok}});await r.text();out.push(Number(process.hrtime.bigint()-t0)/1e6)}console.log(JSON.stringify(out))})()`;
  const out = JSON.parse(execFileSync("docker", ["exec", `${P}-api`, "node", "-e", script], { encoding: "utf8" }));
  summ("engine.direct.v1_schema_rpc_floor_ms", out);
  const ms = [];
  for (let i = 0; i < 20; i++) { const [t] = await timed(async () => (await fetch(`${API}/api/health`)).text()); ms.push(t); }
  summ("api.health_unauthenticated_ms", ms);
  const ms2 = [];
  for (let i = 0; i < 20; i++) { const [t] = await timed(async () => (await fetch(`${API}/api/questions/search?q=payment`, { headers: { authorization: `Bearer ${key}` } })).text()); ms2.push(t); }
  summ("api.questions_search_auth_only_no_engine_ms", ms2);
}
// MCP bridge: scripts/verify/perf-profile-mcp.mjs (official SDK client over the stdio bridge).
