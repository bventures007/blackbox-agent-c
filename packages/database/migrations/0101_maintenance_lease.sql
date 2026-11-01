-- 0101_maintenance_lease.sql — installation-scoped maintenance lease held by the host wrapper
-- (`./blackbox upgrade` through `api cli maintenance-lease acquire|release`). One row; mutable;
-- never a business track. Visible to the api role only.
CREATE TABLE IF NOT EXISTS maintenance_lease (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner       text NOT NULL,
  reason      text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON maintenance_lease TO bb_api;
