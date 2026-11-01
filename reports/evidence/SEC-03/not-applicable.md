# SEC-03 — not applicable (no AI/e-mail extraction feature exists)

Recorded by the ops verifier on 2026-11-01 against commit 482bdf592a599102a5ddcc18cf4e48f176241177.

SEC-03 gates an optional extraction feature (source content such as e-mails being turned into
business facts by a model). The pilot does not implement such a feature:

- `packages/application/src/questions.ts`: free text is never forwarded anywhere; `GET /api/questions/search`
  only matches template titles/entities and `POST /api/questions/:intent` accepts typed, zod-validated parameters.
- `packages/mcp/src/server.ts`: the bridge exposes read-only tools; its instructions label content returned
  from sources as data, not instructions.
- No `communication.extraction_reviewed` producer exists; generic/replay `communication.observed`
  records only carry allowlisted typed fields (`packages/connectors/src/mapping.ts`, `sanitizePayload`).
- Automated check: `tests/backend/integration/journal.test.ts` → `describe("SEC-03")` asserts that no
  extraction module is wired and that free text never becomes a business fact
  (`reports/evidence/CI-01/test-backend-integration.txt`, 49/49 passed).
- specs/PILOT-OPERATIONS-AND-RECOVERY.md §7: "An embedded LLM/chat service and automatic email extraction are
  not required to complete this pilot." The conditional gate stays applicable if such a feature is ever added.

Status: `not_applicable` (feature absent). PILOT-10 (model-free answer path, agent hand-off) is verified
separately by the UI verifier.
