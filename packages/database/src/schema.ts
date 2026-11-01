/**
 * Drizzle schema for the mutable tables added by migrations 0002/0003. The canonical journal
 * tables (0001) are deliberately not modelled here: the only write path is the SQL function
 * append_journal_entries(jsonb). Plain SQL migrations remain the source of truth; this schema is a
 * typed mirror used by application code and tests (`InferSelectModel`).
 */
import { pgTable, uuid, text, timestamp, boolean, integer, bigint, jsonb, bigserial, primaryKey } from "drizzle-orm/pg-core";

export const principals = pgTable("principals", {
  principalId: uuid("principal_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind").$type<"owner" | "agent" | "producer">().notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").$type<"active" | "revoked">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const credentials = pgTable("credentials", {
  credentialId: uuid("credential_id").primaryKey().defaultRandom(),
  principalId: uuid("principal_id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  purpose: text("purpose").$type<"owner_key" | "agent_key">().notNull(),
  prefix: text("prefix").notNull(),
  verifier: text("verifier").notNull(),
  status: text("status").$type<"active" | "revoked">().notNull().default("active"),
  displayName: text("display_name"),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
});

export const sessions = pgTable("sessions", {
  sessionHash: text("session_hash").primaryKey(),
  principalId: uuid("principal_id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  csrfToken: text("csrf_token").notNull(),
  remembered: boolean("remembered").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
});

export const loginThrottle = pgTable("login_throttle", {
  clientKey: text("client_key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  failures: integer("failures").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

export const securityAudit = pgTable("security_audit", {
  auditId: bigserial("audit_id", { mode: "number" }).primaryKey(),
  tenantId: uuid("tenant_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  event: text("event").notNull(),
  actorKind: text("actor_kind").notNull(),
  actorId: uuid("actor_id"),
  channel: text("channel").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

export const producerCredentials = pgTable("producer_credentials", {
  producerId: uuid("producer_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  displayName: text("display_name").notNull(),
  secretKeyVersion: integer("secret_key_version").notNull(),
  status: text("status").$type<"active" | "revoked">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const importPlans = pgTable("import_plans", {
  planId: uuid("plan_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  planRevision: integer("plan_revision").notNull().default(1),
  preset: text("preset").$type<"last_30_days" | "this_year" | "last_12_months" | "custom" | "from_now">().notNull(),
  timezone: text("timezone").notNull(),
  requestedFrom: timestamp("requested_from", { withTimezone: true }),
  initialCutoff: timestamp("initial_cutoff", { withTimezone: true }).notNull(),
  includeOpenContext: boolean("include_open_context").notNull().default(true),
  includeOpeningState: boolean("include_opening_state").notNull().default(true),
  strictFromNow: boolean("strict_from_now").notNull().default(false),
  localFromLabel: text("local_from_label"),
  localCutoffLabel: text("local_cutoff_label"),
  restrictions: jsonb("restrictions").$type<string[]>().notNull().default([]),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
});

export const importRuns = pgTable("import_runs", {
  runId: uuid("run_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  planId: uuid("plan_id"),
  kind: text("kind").notNull(),
  phase: text("phase").notNull().default("check_connection"),
  state: text("state").notNull().default("queued"),
  requested: bigint("requested", { mode: "number" }).notNull().default(0),
  loaded: bigint("loaded", { mode: "number" }).notNull().default(0),
  committed: bigint("committed", { mode: "number" }).notNull().default(0),
  applied: bigint("applied", { mode: "number" }).notNull().default(0),
  failed: bigint("failed", { mode: "number" }).notNull().default(0),
  duplicates: bigint("duplicates", { mode: "number" }).notNull().default(0),
  totalsKnown: boolean("totals_known").notNull().default(false),
  checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>().notNull().default({}),
  attempt: integer("attempt").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: text("outcome"),
  errorCode: text("error_code"),
  nextAction: text("next_action"),
  committedCursor: bigint("committed_cursor", { mode: "number" }),
});

export const capabilityHealth = pgTable(
  "capability_health",
  {
    tenantId: uuid("tenant_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("unknown"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessfulCheckAt: timestamp("last_successful_check_at", { withTimezone: true }),
    lastNewEventAt: timestamp("last_new_event_at", { withTimezone: true }),
    lastJournalCommitAt: timestamp("last_journal_commit_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    nextCheckReason: text("next_check_reason"),
    coverageFrom: timestamp("coverage_from", { withTimezone: true }),
    coverageTo: timestamp("coverage_to", { withTimezone: true }),
    historyKind: text("history_kind").notNull().default("unknown"),
    coverageState: text("coverage_state").notNull().default("unknown"),
    limitations: jsonb("limitations").$type<string[]>().notNull().default([]),
    scheduleSeconds: integer("schedule_seconds"),
    pendingCount: integer("pending_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.capabilityId] })],
);

export const reviewCases = pgTable("review_cases", {
  caseId: uuid("case_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  connectionId: uuid("connection_id"),
  runId: uuid("run_id"),
  type: text("type").notNull(),
  state: text("state").$type<"open" | "in_progress" | "resolved">().notNull().default("open"),
  revision: integer("revision").notNull().default(1),
  reason: text("reason").notNull(),
  refs: jsonb("refs").$type<Record<string, unknown>>().notNull().default({}),
  history: jsonb("history").$type<unknown[]>().notNull().default([]),
  resolutionEntryId: uuid("resolution_entry_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const reviewActions = pgTable("review_actions", {
  actionId: uuid("action_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  caseId: uuid("case_id").notNull(),
  action: text("action").notNull(),
  fromRevision: integer("from_revision").notNull(),
  actorId: uuid("actor_id"),
  reason: text("reason").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  entryId: uuid("entry_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const debugSessions = pgTable("debug_sessions", {
  debugId: uuid("debug_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  component: text("component").notNull(),
  connectionId: uuid("connection_id"),
  runId: uuid("run_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  stopReason: text("stop_reason"),
  actorId: uuid("actor_id"),
});

export const backupStatus = pgTable("backup_status", {
  tenantId: uuid("tenant_id").primaryKey(),
  status: text("status").notNull().default("not_configured"),
  destinationLabel: text("destination_label"),
  sameDevice: boolean("same_device"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
  lastCutoff: timestamp("last_cutoff", { withTimezone: true }),
  nextDueAt: timestamp("next_due_at", { withTimezone: true }),
  retentionDaily: integer("retention_daily").notNull().default(7),
  retentionWeekly: integer("retention_weekly").notNull().default(4),
  lastRestoreTestAt: timestamp("last_restore_test_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    tenantId: uuid("tenant_id").notNull(),
    evidenceClass: text("evidence_class").notNull(),
    days: integer("days").notNull(),
    source: text("source").notNull().default("default"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.evidenceClass] })],
);

export const storageThresholds = pgTable("storage_thresholds", {
  tenantId: uuid("tenant_id").primaryKey(),
  warnPercent: integer("warn_percent").notNull().default(10),
  warnMinBytes: bigint("warn_min_bytes", { mode: "number" }).notNull().default(5368709120),
  criticalPercent: integer("critical_percent").notNull().default(2),
  criticalMinBytes: bigint("critical_min_bytes", { mode: "number" }).notNull().default(1073741824),
  logCapBytes: bigint("log_cap_bytes", { mode: "number" }).notNull().default(104857600),
  logRetentionDays: integer("log_retention_days").notNull().default(7),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evidenceRedactions = pgTable("evidence_redactions", {
  redactionId: uuid("redaction_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  evidenceId: uuid("evidence_id").notNull(),
  action: text("action").$type<"redacted" | "expired" | "restricted">().notNull(),
  reason: text("reason").notNull(),
  actorId: uuid("actor_id"),
  policyRef: text("policy_ref"),
  auditEntryId: uuid("audit_entry_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
