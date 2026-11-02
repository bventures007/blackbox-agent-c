#!/usr/bin/env python3
"""Generate register events for the 14 selected Shopify / Shopify Payments rows on a given commit.

    python3 scripts/verify/register-rerun-events.py --commit <sha> --run-id 20261101-p4-rerun \
        --params reports/integrations/<run-id>/params.json --previous reports/integrations/20261101-ops-verifier-p1/events.json \
        --out reports/integrations/<run-id>/events.json

What it does (and does not do): it re-records an implementation event per row on <commit> (the six work
explanations and the code artifact list are carried over from the previous implementation events; every
digest is recomputed with `git show <commit>:<path>` so the event binds the actual revision), one test event
per kind (contract, pipeline, recovery, tenant_isolation) with the command/environment/observed text given in
params.json for that kind, a per-row-per-kind artifact JSON under reports/integrations/<run-id>/ (sanitized
summary of the actual run: counts and run ids only), and a blocked(live) event. It never claims a review and
it never invents results: every observed string must come from params.json, which the verifier fills from the
saved suite outputs. Append with `scripts/integration-register.py append --event <out>`.
"""
import argparse, hashlib, json, subprocess, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROWS = ["shopify.orders", "shopify.stock", "shopify.allocations", "shopify.fulfillments", "shopify.payments", "shopify.returns", "shopify.receipts", "shopify.refunds",
        "shopify_payments.provider_ledger", "shopify_payments.positions", "shopify_payments.payouts", "shopify_payments.holds", "shopify_payments.refunds", "shopify_payments.disputes"]
KINDS = ["contract", "pipeline", "recovery", "tenant_isolation"]
ACTOR = {"id": "claude-fable-5-1/p4-rerun-verifier", "name": "Claude Fable 5.1 (P4 re-run verifier)", "kind": "agent"}


def git_show(commit, path):
    return subprocess.check_output(["git", "-C", str(ROOT), "show", f"{commit}:{path}"])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--params", required=True)
    ap.add_argument("--previous", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    params = json.loads(Path(a.params).read_text())
    prev = json.loads(Path(a.previous).read_text())
    prev_impl = {e["row"]: e for e in prev if e["action"] == "implementation"}
    prev_blocked = {e["row"]: e for e in prev if e["action"] == "blocked"}
    outdir = ROOT / "reports/integrations" / a.run_id
    outdir.mkdir(parents=True, exist_ok=True)
    t0 = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    tick = [0]

    def at():
        tick[0] += 1
        return (t0 + datetime.timedelta(seconds=tick[0])).strftime("%Y-%m-%dT%H:%M:%SZ")

    events = []
    for row in ROWS:
        p = prev_impl[row]
        code = []
        for ref in p["code"]:
            code.append({"path": ref["path"], "sha256": sha(git_show(a.commit, ref["path"]))})
        mapping_path = p["mapping"]["path"]
        mapping = next(c for c in code if c["path"] == mapping_path)
        impl_id = f"impl-{a.run_id}-{row}"
        events.append({
            "id": impl_id, "row": row, "at": at(), "actor": ACTOR, "action": "implementation", "commit": a.commit,
            "contributors": sorted(set(p["contributors"]) | {ACTOR["id"]}),
            "note": params["implementation_note"].replace("{row}", row).replace("{commit}", a.commit) + " Known limitations unchanged: " + p["note"].split("Known limitations:")[-1].strip(),
            "work": p["work"], "code": code, "mapping": mapping,
        })
        for kind in KINDS:
            k = params["tests"][kind]
            artifact = {
                "row": row, "kind": kind, "tested_commit": a.commit, "recorded_at": at(), "command": k["command"], "environment": params["environment"],
                "case_ids": k["case_ids"], "modes": k["modes"], "observed": k["observed"].replace("{row}", row), "result": k["result"],
                "outputs": k["outputs"],
                "note": "Sanitized summary of the actual suite outputs named in outputs (counts, run ids, timings); no keys, cookies, payloads or personal data. Synthetic provider-shaped fixture, not live provider evidence.",
            }
            apath = outdir / f"{row}.{kind}.json"
            apath.write_text(json.dumps(artifact, indent=2) + "\n")
            events.append({
                "id": f"test-{a.run_id}-{row}-{kind}", "row": row, "at": at(), "actor": ACTOR, "action": "test", "revision": impl_id, "tested_commit": a.commit,
                "kind": kind, "result": k["result"], "command": k["command"], "environment": params["environment"], "case_ids": k["case_ids"], "modes": k["modes"],
                "observed": artifact["observed"], "artifact": {"path": str(apath.relative_to(ROOT)), "sha256": sha(apath.read_bytes())},
                "note": k["note"],
            })
        b = prev_blocked[row]
        events.append({"id": f"blocked-{a.run_id}-{row}-live", "row": row, "at": at(), "actor": ACTOR, "action": "blocked", "note": b["note"], "next_action": b["next_action"]})
    Path(a.out).write_text(json.dumps(events, indent=2) + "\n")
    print(f"{len(events)} events -> {a.out}; artifacts under {outdir}")


if __name__ == "__main__":
    main()
