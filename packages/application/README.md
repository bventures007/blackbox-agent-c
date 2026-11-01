# @blackbox/application

Domain services shared by the API and the MCP bridge: table-driven observation→journal mapping
(`src/mapping/families.ts`), the single ingestion path (`IngestionService`: validation, PII
anchors, delivery dedupe, conflict review cases, evidence storage, transactional append +
post-commit `journal.batch_committed`), snapshot-paginated journal reads, per-question readiness,
import plan resolution (presets → UTC with timezone), the typed engine client with a labelled test
stub (`ENGINE_URL=stub`, no reducers in TypeScript), question parameter schemas generated from the
24 contract intents, bank CSV parsing/matching, HMAC signed input, and the review workflow.
