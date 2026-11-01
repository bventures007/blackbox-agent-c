#!/usr/bin/env python3
"""Record actual acceptance evidence into reports/acceptance.json.

Usage: python3 scripts/acceptance/record.py results.json
results.json: [{"id":"INSTALL-01","status":"passed|failed|blocked_external|implemented_unverified|not_applicable",
  "command":"...","environment":"...","observed_result":"...","evidence_paths":["reports/evidence/..."],
  "blocker":null}]
tested_commit is taken from HEAD unless given. Deferred cases are never touched (they stay not_started).
Only writes what the results file says; it does not execute or certify anything.
"""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def main():
    results = json.loads(Path(sys.argv[1]).read_text())
    head = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']).decode().strip()
    profile = json.loads((ROOT / 'delivery-profile.json').read_text())
    active = set(profile['required_acceptance_ids'])
    report_path = ROOT / 'reports/acceptance.json'
    report = json.loads(report_path.read_text())
    by_id = {c['id']: c for c in report['cases']}
    for r in results:
        case = by_id[r['id']]
        if r['id'] not in active:
            raise SystemExit(f"{r['id']} is deferred; evidence is not recorded for deferred cases")
        for p in r.get('evidence_paths', []):
            if not (ROOT / p).is_file() or (ROOT / p).stat().st_size == 0:
                raise SystemExit(f"missing/empty evidence for {r['id']}: {p}")
        case.update({
            'status': r['status'],
            'tested_commit': r.get('tested_commit', head),
            'command': r.get('command'),
            'environment': r.get('environment'),
            'observed_result': r.get('observed_result'),
            'evidence_paths': r.get('evidence_paths', []),
            'blocker': r.get('blocker'),
        })
    report['note'] = ('Results recorded from actual runs by scripts/acceptance/record.py. delivery_scope distinguishes '
                      'active pilot proof from deferred platform references; deferred work stays not_started.')
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    counts = {}
    for c in report['cases']:
        if c['id'] in active:
            counts[c['status']] = counts.get(c['status'], 0) + 1
    print('active case status counts:', json.dumps(counts))

if __name__ == '__main__':
    main()
