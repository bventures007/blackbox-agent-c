#!/usr/bin/env python3
"""Render the UI-01 per-capture comparison table (reference capture ↔ pilot screenshot ↔ verdict).

    python3 scripts/verify/ui-comparison-table.py reports/evidence/UI-01/verdicts.json > table.md

verdicts.json: {"desktop/08-recorder.png": {"shot": "en/08-recorder.png", "verdict": "match", "note": "..."}, ...}
Every entry of reference/screenshots/capture-manifest.json must have a verdict; missing ones are listed
as "not compared" so the table never silently claims coverage. The script only renders; it decides nothing.
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
manifest = json.loads((ROOT / "reference/screenshots/capture-manifest.json").read_text())
caps = manifest["screenshots"]
verdicts = json.loads(Path(sys.argv[1]).read_text())
rows = []
counts = {}
for c in caps:
    f = c.get("file") or c.get("path") or c.get("name")
    v = verdicts.get(f)
    if v is None:
        verdict, shot, note = "not compared", "—", "no pilot capture reviewed"
    else:
        verdict, shot, note = v["verdict"], v.get("shot", "—"), v.get("note", "")
    counts[verdict] = counts.get(verdict, 0) + 1
    title = c.get("title") or c.get("description") or ""
    rows.append(f"| `{f}` {title} | {shot} | **{verdict}** | {note} |")
print("| Reference capture | Pilot screenshot (reports/evidence/UI-01/screens/) | Verdict | Observed match / deviation and reason |")
print("| --- | --- | --- | --- |")
print("\n".join(rows))
print()
print("Totals: " + ", ".join(f"{k}: {n}" for k, n in sorted(counts.items())) + f" (of {len(caps)} reference captures)")
