#!/usr/bin/env node
// SLICE-01 helper: normalizes an entity-state envelope (API route or MCP tool text) for comparison.
// Keeps business values, status, evidence/entry ids (sorted) and coverage; drops ephemeral timing/
// consistency/readiness fields that legitimately differ between calls (recorded_cutoff "now",
// applied cursor after a restart, observed_at, readiness timestamps).
//   node tests/slice/normalize.mjs <file.json>   -> canonical JSON on stdout
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: normalize.mjs <file.json>\n");
  process.exit(2);
}
let doc = JSON.parse(readFileSync(file, "utf8"));
// MCP tool text may wrap the same envelope; an error envelope is kept verbatim so a denial shows.
if (doc && doc.error) {
  process.stdout.write(JSON.stringify({ error: { status: doc.error.status ?? null, code: doc.error.code ?? null } }) + "\n");
  process.exit(0);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}
const tracks = {};
for (const [name, view] of Object.entries(doc.tracks ?? {})) {
  // Track views: keep totals and the set of entry ids/event types, not the per-call ordering.
  const summaries = Array.isArray(view?.entries) ? view.entries : [];
  tracks[name] = {
    total: view?.total ?? summaries.length,
    truncated: view?.truncated ?? false,
    entries: summaries.map((s) => ({ entry_id: s.entry_id, event_type: s.event_type, record_id: s.record_id, track: s.track, effect: s.effect ?? null })).sort((a, b) => String(a.entry_id).localeCompare(String(b.entry_id))),
  };
}
const normalized = canonical({
  entity: doc.entity ?? null,
  state: doc.state ?? null,
  status: doc.status ?? null,
  missing_inputs: [...(doc.missing_inputs ?? [])].sort(),
  conflicts: (doc.conflicts ?? []).map((c) => ({ reason: c.reason ?? null, entry_id: c.entry_id ?? null })).sort((a, b) => String(a.entry_id).localeCompare(String(b.entry_id))),
  coverage: doc.coverage ?? null,
  entry_ids: [...(doc.entry_ids ?? [])].sort(),
  evidence_refs: [...(doc.evidence_refs ?? [])].sort(),
  tracks,
  reducer_version: doc.consistency?.reducer_version ?? null,
});
process.stdout.write(JSON.stringify(normalized, null, 2) + "\n");
