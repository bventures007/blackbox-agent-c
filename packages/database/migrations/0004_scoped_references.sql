-- 0004_scoped_references.sql — composite (tenant_id, id) foreign keys so that a foreign reference
-- can never point into another tenant even though FK lookups bypass row-level security
-- (TENANT-04). Additive only: unique constraints on existing keys plus extra FK constraints.
ALTER TABLE connections          ADD CONSTRAINT connections_tenant_scope_key          UNIQUE (tenant_id, connection_id);
ALTER TABLE journal_entries      ADD CONSTRAINT journal_entries_tenant_scope_key      UNIQUE (tenant_id, entry_id);
ALTER TABLE journal_evidence     ADD CONSTRAINT journal_evidence_tenant_scope_key     UNIQUE (tenant_id, evidence_id);
ALTER TABLE principals           ADD CONSTRAINT principals_tenant_scope_key           UNIQUE (tenant_id, principal_id);
ALTER TABLE producer_credentials ADD CONSTRAINT producer_credentials_tenant_scope_key UNIQUE (tenant_id, producer_id);
ALTER TABLE review_cases         ADD CONSTRAINT review_cases_tenant_scope_key         UNIQUE (tenant_id, case_id);
ALTER TABLE import_plans         ADD CONSTRAINT import_plans_tenant_scope_key         UNIQUE (tenant_id, plan_id);

ALTER TABLE deliveries           ADD CONSTRAINT deliveries_connection_scoped_fk           FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, connection_id);
ALTER TABLE journal_entries      ADD CONSTRAINT journal_entries_connection_scoped_fk      FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, connection_id);
ALTER TABLE journal_entries      ADD CONSTRAINT journal_entries_supersedes_scoped_fk      FOREIGN KEY (tenant_id, supersedes_entry_id) REFERENCES journal_entries(tenant_id, entry_id);
ALTER TABLE journal_evidence     ADD CONSTRAINT journal_evidence_connection_scoped_fk     FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, connection_id);
ALTER TABLE outbox               ADD CONSTRAINT outbox_entry_scoped_fk                    FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries(tenant_id, entry_id);
ALTER TABLE credentials          ADD CONSTRAINT credentials_principal_scoped_fk           FOREIGN KEY (tenant_id, principal_id) REFERENCES principals(tenant_id, principal_id);
ALTER TABLE sessions             ADD CONSTRAINT sessions_principal_scoped_fk              FOREIGN KEY (tenant_id, principal_id) REFERENCES principals(tenant_id, principal_id);
ALTER TABLE producer_credentials ADD CONSTRAINT producer_credentials_connection_scoped_fk FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, connection_id);
ALTER TABLE producer_nonces      ADD CONSTRAINT producer_nonces_producer_scoped_fk        FOREIGN KEY (tenant_id, producer_id) REFERENCES producer_credentials(tenant_id, producer_id);
ALTER TABLE import_plans         ADD CONSTRAINT import_plans_connection_scoped_fk         FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, connection_id);
ALTER TABLE import_runs          ADD CONSTRAINT import_runs_connection_scoped_fk          FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, connection_id);
ALTER TABLE import_runs          ADD CONSTRAINT import_runs_plan_scoped_fk                FOREIGN KEY (tenant_id, plan_id) REFERENCES import_plans(tenant_id, plan_id);
ALTER TABLE capability_health    ADD CONSTRAINT capability_health_connection_scoped_fk    FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, connection_id);
ALTER TABLE review_cases         ADD CONSTRAINT review_cases_connection_scoped_fk         FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, connection_id);
ALTER TABLE review_actions       ADD CONSTRAINT review_actions_case_scoped_fk             FOREIGN KEY (tenant_id, case_id) REFERENCES review_cases(tenant_id, case_id);
ALTER TABLE evidence_redactions  ADD CONSTRAINT evidence_redactions_evidence_scoped_fk    FOREIGN KEY (tenant_id, evidence_id) REFERENCES journal_evidence(tenant_id, evidence_id);
