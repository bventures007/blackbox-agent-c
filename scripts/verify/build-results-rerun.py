#!/usr/bin/env python3
"""Compose reports/evidence/results-rerun.json for scripts/acceptance/record.py.

    python3 scripts/verify/build-results-rerun.py <new-results.json> [more.json ...]

Starts from the active cases in reports/acceptance.json (carry-forward: a case keeps its recorded status,
command, environment, observed_result, evidence_paths, blocker and tested_commit exactly as recorded), then
overrides with the entries of the given results files (re-run cases). Writes every active ID. Never changes a
status on its own; it only merges what the given files say. Prints the per-status counts.
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
profile = json.loads((ROOT / "delivery-profile.json").read_text())
active = profile["required_acceptance_ids"]
acc = {c["id"]: c for c in json.loads((ROOT / "reports/acceptance.json").read_text())["cases"]}
out = {}
for cid in active:
    c = acc[cid]
    out[cid] = {k: c.get(k) for k in ("id", "status", "command", "environment", "observed_result", "evidence_paths", "blocker")}
    if c.get("tested_commit"):
        out[cid]["tested_commit"] = c["tested_commit"]
for f in sys.argv[1:]:
    loaded = json.loads(Path(f).read_text())
    entries = loaded if isinstance(loaded, list) else loaded.get("results") or loaded.get("cases") or []
    if isinstance(entries, dict):
        entries = [dict(v, id=k) for k, v in entries.items()]
    for r in entries:
        assert r["id"] in out, f"{r['id']} is not an active case"
        out[r["id"]] = {k: r.get(k) for k in ("id", "status", "command", "environment", "observed_result", "evidence_paths", "blocker", "tested_commit") if k in r or k != "tested_commit"}
rows = [out[cid] for cid in active]
for r in rows:
    for p in r.get("evidence_paths") or []:
        assert (ROOT / p).exists(), f"missing evidence for {r['id']}: {p}"
(ROOT / "reports/evidence/results-rerun.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n")
counts = {}
for r in rows:
    counts[r["status"]] = counts.get(r["status"], 0) + 1
print(json.dumps(counts, indent=1))
