import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolve workspace packages to their TypeScript sources so tests never run against stale dist output. */
export const alias = {
  "@blackbox/database": path.join(root, "packages/database/src/index.ts"),
  "@blackbox/logging": path.join(root, "packages/logging/src/index.ts"),
  "@blackbox/auth": path.join(root, "packages/auth/src/index.ts"),
  "@blackbox/connectors": path.join(root, "packages/connectors/src/index.ts"),
  "@blackbox/application": path.join(root, "packages/application/src/index.ts"),
  "@blackbox/api": path.join(root, "apps/api/src/index.ts"),
  "@blackbox/testing": path.join(root, "packages/testing/src/index.ts"),
};
export const repoRoot = root;
