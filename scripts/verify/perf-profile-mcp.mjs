import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const req = createRequire(path.resolve("package.json"));
const { Client } = await import(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const POOLS = JSON.parse(readFileSync(process.env.HOME + "/blackbox-perf-keys-perf/pools.json", "utf8"));
const N = Number(process.argv[2] ?? 40); const tenantIdx = Number(process.argv[3] ?? 0);
const client = POOLS.clients.find((c) => c.tenant_index === tenantIdx);
const orders = POOLS.pools[client.tenant_id].hot.slice(0, N);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Number(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(1)); };
const summ = (name, arr, extra = {}) => console.log(JSON.stringify({ name, n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95), max: pct(arr, 1), ...extra }));
async function timed(fn) { const t0 = performance.now(); const r = await fn(); return [performance.now() - t0, r]; }
const t0 = performance.now();
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("packages/mcp/dist/server.js")], env: { ...process.env, BLACKBOX_API_URL: POOLS.api, BLACKBOX_AGENT_KEY_FILE: client.key_file }, stderr: "pipe" });
transport.stderr?.on("data", () => {});
const mcp = new Client({ name: "profile", version: "1.0.0" });
await mcp.connect(transport);
console.log(JSON.stringify({ name: "mcp.bridge_startup_ms", ms: Number((performance.now() - t0).toFixed(1)) }));
const ms = [], bytes = [];
for (const o of orders) { const [t, r] = await timed(() => mcp.callTool({ name: "get_business_state", arguments: { entity_type: "order", entity_id: o } })); ms.push(t); bytes.push(r.content?.[0]?.text?.length ?? 0); }
summ("mcp.get_business_state.total_ms", ms, { text_bytes_p50: pct(bytes, 0.5) });
const ms2 = [];
for (const o of orders) { const [t] = await timed(() => mcp.callTool({ name: "answer_question", arguments: { intent: "orders.payment_state", params: { order_id: o } } })); ms2.push(t); }
summ("mcp.answer_question.payment_state.total_ms", ms2);
const ms3 = [];
for (let i = 0; i < 20; i++) { const [t] = await timed(() => mcp.callTool({ name: "describe_business_schema", arguments: {} })); ms3.push(t); }
summ("mcp.describe_business_schema_ms", ms3);
await mcp.close();
