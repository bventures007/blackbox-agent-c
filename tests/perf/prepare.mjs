#!/usr/bin/env node
// PILOT-09 / OPS-05 preparation: turns the corpus manifest (apps/engine corpus binary) into the
// driver's principal/order pools. Agent keys are issued by the host CLI (`create-tenant-agent-key`,
// test-only) and stored as 0600 files under a scratch directory that is never committed; the
// emitted pools file references those files by path only.
//
//   node tests/perf/prepare.mjs --manifest reports/evidence/PILOT-09/corpus-manifest.json \
//     --keys-dir /path/outside/repo --out /path/outside/repo/pools.json --api http://127.0.0.1:19185
//
// Environment for the host CLI (apps/api/dist/cli.js): DATABASE_URL (bb_api), SECRETS_DIR,
// EVIDENCE_DIR, LOGS_DIR (any writable dir), ENGINE_URL=stub.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : [])).filter((e) => e.length));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
const api = args.api ?? "http://127.0.0.1:19185";
const keysDir = args["keys-dir"];
const out = args.out;
const tenant0Keys = Number(args["tenant0-keys"] ?? 5);
const otherTenants = Number(args["other-tenants"] ?? 10);
if (!keysDir || !out) throw new Error("--keys-dir and --out are required");
mkdirSync(keysDir, { recursive: true, mode: 0o700 });

function issueKey(tenantId, name) {
  const file = path.join(keysDir, `${name}.key`);
  if (existsSync(file)) return file;
  const raw = execFileSync(process.execPath, [path.join(repo, "apps/api/dist/cli.js"), "create-tenant-agent-key", "--tenant", tenantId, "--name", name, "--json"], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  const line = raw.trim().split("\n").find((l) => l.startsWith("{"));
  const r = JSON.parse(line);
  writeFileSync(file, r.key + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

async function agentGet(keyFile, url) {
  const key = readFileSync(keyFile, "utf8").trim();
  const res = await fetch(api + url, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function orderIds(keyFile, limit) {
  // Source order.accepted entries carry the order id in entity_refs; page until `limit` ids.
  const ids = [];
  let cursor;
  while (ids.length < limit) {
    const page = await agentGet(keyFile, `/api/journal?track=source&event_type=order.accepted&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const e of page.entries ?? []) {
      const id = e.entity_refs?.order;
      if (id && !ids.includes(id)) ids.push(id);
    }
    cursor = page.page?.next_cursor;
    if (!cursor || !(page.entries ?? []).length) break;
  }
  return ids.slice(0, limit);
}

const tenants = manifest.tenants;
const t0 = tenants[0].tenant_id;
const principals = [];
for (let i = 0; i < tenant0Keys; i++) principals.push({ tenant_id: t0, tenant_index: 0, name: `perf-t0-${i}`, key_file: issueKey(t0, `perf-t0-${i}`) });
for (let k = 1; k <= otherTenants; k++) principals.push({ tenant_id: tenants[k].tenant_id, tenant_index: k, name: `perf-t${k}`, key_file: issueKey(tenants[k].tenant_id, `perf-t${k}`) });

const pools = {};
pools[t0] = {
  hot: manifest.hot_set.filter((h) => h.tenant_id === t0).map((h) => h.order_id),
  cold: manifest.cold_sample.filter((c) => c.tenant_id === t0).map((c) => c.order_id),
};
for (let k = 1; k <= otherTenants; k++) {
  const tid = tenants[k].tenant_id;
  const keyFile = principals.find((p) => p.tenant_id === tid).key_file;
  const ids = await orderIds(keyFile, 200);
  const manifestCold = manifest.cold_sample.filter((c) => c.tenant_id === tid).map((c) => c.order_id);
  const hot = ids.filter((id) => !manifestCold.includes(id)).slice(0, 40);
  const cold = [...manifestCold, ...ids.filter((id) => !hot.includes(id) && !manifestCold.includes(id))].slice(0, 100);
  pools[tid] = { hot, cold };
}
const clients = [];
for (let c = 0; c < 20; c++) {
  const p = c < 10 ? principals[c % tenant0Keys] : principals[tenant0Keys + ((c - 10) % otherTenants)];
  clients.push({ client: c, tenant_id: p.tenant_id, tenant_index: p.tenant_index, principal: p.name, key_file: p.key_file });
}
const summaryWindow = { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" };
writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), api, manifest: args.manifest, corpus_generated_at: manifest.generated_at, principals: principals.map((p) => ({ ...p })), clients, pools, summary_window: summaryWindow }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ principals: principals.length, clients: clients.length, pools: Object.fromEntries(Object.entries(pools).map(([t, p]) => [t.slice(0, 8), { hot: p.hot.length, cold: p.cold.length }])) }));
