export { createPool, describeConnection } from "./pool.js";
export type { Pool, PoolClient } from "./pool.js";
export { withTenant, withAuthenticator, withInstallation, assertUuid, TenantScopeError } from "./tenant.js";
export type { TenantClient } from "./tenant.js";
export { runMigrations, pendingMigrations, MIGRATIONS_DIR } from "./migrate.js";
export type { MigrationResult } from "./migrate.js";
export { bootstrapRoles, passwordsFromEnv } from "./bootstrap.js";
export type { BootstrapOptions } from "./bootstrap.js";
export * as schema from "./schema.js";
