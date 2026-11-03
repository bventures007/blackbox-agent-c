#!/usr/bin/env bash
# Verdict + performance report for a smoke protocol run directory (tests/perf/verdict.mjs, tests/perf/report.mjs).
# Usage: scripts/verify/ops2-smoke-verdict.sh <runs-dir (relative to repo)> <commit> "<environment>" <limitations-file> <commands-file> [--write-performance-json]
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; cd "$REPO"
DIR="${1:?runs dir}"; COMMIT="${2:?commit}"; ENV="${3:?environment}"; LIM="${4:?limitations}"; CMDS="${5:?commands}"; WRITE="${6:-}"
MANIFEST=reports/evidence/PILOT-09-rerun/corpus-manifest.json
args=(--manifest "$MANIFEST")
for r in api-closed api-fixed mcp-closed mcp-fixed; do [ -f "$DIR/run-$r.json" ] && args+=(--$r "$DIR/run-$r.json"); done
for f in restart rebuild restore; do [ -f "$DIR/$f.json" ] && args+=(--$f "$DIR/$f.json"); done
node tests/perf/verdict.mjs "${args[@]}" > "$DIR/verdict.json" && node -e "const v=require('$REPO/$DIR/verdict.json');console.log('verdict',v.status,'failing:',v.verdicts.filter(x=>!x.holds).map(x=>x.target+'='+x.observed+' (limit '+x.limit+')').join('; '))"
# tests/perf/report.mjs rewrites reports/performance.json in place (its stdout is a summary line only).
if [ "$WRITE" = "--write-performance-json" ]; then
  node tests/perf/report.mjs --runs-dir "$DIR" --verdict "$DIR/verdict.json" --manifest "$MANIFEST" --commit "$COMMIT" --environment "$ENV" --limitations-file "$LIM" --commands-file "$CMDS" && cp reports/performance.json "$DIR/performance.json" && echo "reports/performance.json updated from $DIR"
else
  cp reports/performance.json "$DIR/.performance.before.json"
  node tests/perf/report.mjs --runs-dir "$DIR" --verdict "$DIR/verdict.json" --manifest "$MANIFEST" --commit "$COMMIT" --environment "$ENV" --limitations-file "$LIM" --commands-file "$CMDS" && cp reports/performance.json "$DIR/performance.json" && cp "$DIR/.performance.before.json" reports/performance.json && rm -f "$DIR/.performance.before.json" && echo "report written to $DIR/performance.json (reports/performance.json restored)"
fi
