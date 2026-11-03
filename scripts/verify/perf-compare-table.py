#!/usr/bin/env python3
"""Markdown table of smoke runs (tests/perf/smoke.mjs outputs) for the PILOT-09 evidence READMEs.
Usage: perf-compare-table.py <label>=<dir> [<label>=<dir> ...]   (dir holds run-{api,mcp}-{closed,fixed}.json)"""
import json, sys, os, statistics
def load(d, k):
    p = os.path.join(d, f"run-{k}.json")
    return json.load(open(p)) if os.path.exists(p) else None
def sampler(d, k):
    p = os.path.join(d, f"samples-{k}.jsonl")
    if not os.path.exists(p): return ""
    rows = [json.loads(l) for l in open(p) if l.strip()]
    pg = [float(c['cpu'].rstrip('%') or 0) for r in rows for c in r['containers'] if c['name'].endswith('-postgres')]
    loads = [float(r['load'].split()[0]) for r in rows]
    rss = [r['engine_vmrss_bytes']/1048576 for r in rows if r.get('engine_vmrss_bytes')]
    med = lambda a: statistics.median(a) if a else float('nan')
    return f"{med(pg):.0f} % / {max(pg):.0f} % | {min(loads):.0f} / {med(loads):.0f} / {max(loads):.0f} | {med(rss):.0f} / {max(rss):.0f}"
print("| run | req/s | success | hot p50 / p95 / p99 ms | cold p95 | history p95 | summary p95 | ingestion eps / ack p95 / lag p95 | engine cgroup median / peak MiB | stack peak | PostgreSQL CPU median / max | host 1-min load min / median / max | engine VmRSS median / max |")
print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
for arg in sys.argv[1:]:
    label, d = arg.split("=", 1)
    for k, name in [("api-closed", "API closed 20 clients"), ("api-fixed", "API fixed 40 req/s"), ("mcp-closed", "MCP closed 20 clients"), ("mcp-fixed", "MCP fixed 40 req/s")]:
        r = load(d, k)
        if not r: continue
        c = r['classes']; i = r['ingestion']; m = r['memory']
        f = lambda x: "–" if x is None else f"{x:,.0f}"
        print(f"| {label} {name} | {r['achieved_rps']} | {r['success_fraction']:.4f} | {f(c['hot']['p50_ms'])} / {f(c['hot']['p95_ms'])} / {f(c['hot']['p99_ms'])} | {f(c['cold']['p95_ms'])} | {f(c['history']['p95_ms'])} | {f(c['summary']['p95_ms'])} | {i['entries_per_second']} / {f(i['durable_ack_p95_ms'])} / {f(i['lag_p95_ms'])} | {f(m['engine_mib_steady_median'])} / {f(m['engine_mib_peak'])} | {f(m['total_stack_mib_peak'])} | {sampler(d, k)} |")
