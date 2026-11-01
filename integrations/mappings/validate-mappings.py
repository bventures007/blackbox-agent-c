#!/usr/bin/env python3
"""Validates every committed mapping artifact with check_mapping from scripts/integration-register.py.
Usage: python3 integrations/mappings/validate-mappings.py   (exit 1 on any failure; prints missing fields per row)"""
import importlib.util, json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('integration_register', ROOT / 'scripts' / 'integration-register.py')
reg = importlib.util.module_from_spec(spec); spec.loader.exec_module(reg)
register = json.loads((ROOT / 'integrations' / 'register.json').read_text())
contract = json.loads((ROOT / 'specs' / 'question-data-contracts.json').read_text())
rows = {r['id']: r for r in register['rows']}
datasets = {d['id']: d for d in contract['datasets']}
profile = json.loads((ROOT / 'delivery-profile.json').read_text())
selected = [r for r in profile['required_integration_rows'] if r.startswith('shopify')]
ok = True
for path in sorted(pathlib.Path(__file__).resolve().parent.glob('*.json')):
    mapping = json.loads(path.read_text())
    row = rows.get(mapping.get('row_id'))
    if not row:
        print(f'FAIL {path.name}: unknown row {mapping.get("row_id")}'); ok = False; continue
    try:
        missing = reg.check_mapping(mapping, row, datasets[row['dataset']])
        unsupported = [e['event'] for e in mapping['event_rules'] if not e['tracks']]
        modes = {m: p['status'] for m, p in mapping['synchronization']['modes'].items()}
        print(f'ok   {path.name}: missing={missing or "-"} unsupported_events={unsupported or "-"} modes={modes}')
    except Exception as err:  # reg.require raises SystemExit/ValueError subclasses
        print(f'FAIL {path.name}: {err}'); ok = False
present = {p.stem for p in pathlib.Path(__file__).resolve().parent.glob('*.json')}
for row_id in selected:
    if row_id not in present:
        print(f'FAIL missing artifact for selected row {row_id}'); ok = False
print('all mapping artifacts valid' if ok else 'mapping validation failed')
sys.exit(0 if ok else 1)
