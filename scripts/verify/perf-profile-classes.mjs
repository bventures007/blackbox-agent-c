// PILOT-09 profile: idle timing of the history (API → PostgreSQL) and summary (invoices.outstanding, engine) classes.
//   node scripts/verify/perf-profile-classes.mjs [N=30] [tenant_index=0]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const POOLS = JSON.parse(readFileSync(process.env.HOME + "/blackbox-perf-keys-perf/pools.json", "utf8"));
const P = process.env.P ?? "blackbox-agent-c-perf";
const N = Number(process.argv[2] ?? 30); const tenantIdx = Number(process.argv[3] ?? 0);
const client = POOLS.clients.find((c) => c.tenant_index === tenantIdx);
const key = readFileSync(client.key_file, "utf8").trim();
const pool = POOLS.pools[client.tenant_id]; const orders = pool.hot.slice(0, N);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Number(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(1)); };
const summ = (name, arr, extra = {}) => console.log(JSON.stringify({ name, n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95), max: pct(arr, 1), ...extra }));
async function timed(fn) { const t0 = performance.now(); const r = await fn(); return [performance.now() - t0, r]; }
{
  const ms = [], bytes = [];
  for (const o of orders) { const [t, r] = await timed(async () => { const res = await fetch(`${POOLS.api}/api/entities/order/${encodeURIComponent(o)}/history?limit=100`, { headers: { authorization: `Bearer ${key}` } }); const text = await res.text(); return { status: res.status, len: text.length, n: JSON.parse(text).entries?.length }; }); ms.push(t); bytes.push(r.len); }
  summ("api.history_100.total_ms (API -> PostgreSQL, full entries)", ms, { response_bytes_p50: pct(bytes, 0.5) });
}
{
  const ms = [], bytes = [], st = {};
  for (let i = 0; i < Math.min(N, 15); i++) { const [t, r] = await timed(async () => { const res = await fetch(`${POOLS.api}/api/questions/invoices.outstanding`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ params: { now: POOLS.summary_window.to, due_before: POOLS.summary_window.to } }) }); const text = await res.text(); const j = JSON.parse(text); return { len: text.length, status: j.status, cov: j.coverage }; }); ms.push(t); bytes.push(r.len); st[r.status] = (st[r.status] ?? 0) + 1; if (i === 0) console.log(JSON.stringify({ coverage: r.cov })); }
  summ("api.summary.invoices_outstanding.total_ms", ms, { response_bytes_p50: pct(bytes, 0.5), statuses: st });
  const script = `const fs=require('fs');const tok=fs.readFileSync('/run/secrets/engine_token','utf8').trim();const tenant=${JSON.stringify(client.tenant_id)};(async()=>{const out=[];for(let i=0;i<${Math.min(N, 15)};i++){const t0=process.hrtime.bigint();const r=await fetch('http://engine:7070/v1/query',{method:'POST',headers:{'content-type':'application/json','x-engine-token':tok},body:JSON.stringify({tenant_id:tenant,intent:'invoices.outstanding',params:{now:${JSON.stringify(POOLS.summary_window.to)},due_before:${JSON.stringify(POOLS.summary_window.to)}},consistency:{mode:'latest_committed',deadline_ms:5000},page:{limit:100}})});const text=await r.text();const j=JSON.parse(text);out.push({ms:Number(process.hrtime.bigint()-t0)/1e6,eng:j.duration_ms,len:text.length})}console.log(JSON.stringify(out))})()`;
  const out = JSON.parse(execFileSync("docker", ["exec", `${P}-api`, "node", "-e", script], { encoding: "utf8" }));
  summ("engine.direct.invoices_outstanding.total_ms", out.map((x) => x.ms), { engine_duration_ms_p50: pct(out.map((x) => x.eng), 0.5), engine_duration_ms_max: pct(out.map((x) => x.eng), 1) });
}
