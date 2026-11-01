# Blackbox local pilot — product overview

Blackbox is a local commerce flight recorder. Source observations (shop, payment provider, bank statement, invoicing, carrier, generic producers) are appended to a five-track journal (Sources, Facts, Commitments, Movements, Reservations). Deterministic Rust reducers compute business state; the browser UI, the HTTP API and a local read-only MCP bridge answer 24 Order-to-Cash questions with evidence, cutoffs, coverage and explicit unknowns.

## What a tester gets

1. Landing page with a versioned Mac (Apple Silicon) archive and an EN/DE installation guide.
2. `./blackbox doctor` → `./blackbox setup` (prints one personal access key once) → `./blackbox up` → http://127.0.0.1:19180.
3. One automatic owner/workspace, remembered revocable sessions, host-only `reset-access`.
4. Sources: run the labeled demo scenario, connect Shopify / Shopify Payments (outbound import, polling, reconciliation), upload bank CSV, push signed generic records, replay fixtures.
5. Recorder, Journal, Questions & Answers (all 24 templates, model-free), Agents & MCP (named read-only keys, stdio bridge), System & Diagnostics (owner-only health, logs, debug, export), Settings (backups, retention, storage, key rotation).
6. `./blackbox backup|restore|upgrade|logs|diagnostics export` on the host.

## What it is not

No SaaS, public host, passkeys, employee management, native app, embedded LLM or telemetry. Deferred scope is listed in delivery-profile.json.

Module map: docs/architecture.md, docs/engine.md, docs/connectors.md, docs/ui.md, docs/operations.md, docs/release.md.
