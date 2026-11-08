#!/usr/bin/env node
// Stages Blackbox's own code into apps/desktop/runtime/<target>/ so Tauri can ship it as app resources:
//
//   app/services/{api-server,api-cli,worker,mcp}.mjs   esbuild bundles of the built workspace (one file each)
//   app/node_modules/{argon2,node-gyp-build,@phc/format} the only native addon, with the target's prebuild only
//   app/web, app/landing                               built browser UI and landing page
//   app/migrations                                     PostgreSQL migrations (0000_roles.sql included)
//   app/packages/contracts, app/specs, GOLDEN-...json   contracts read at run time (BLACKBOX_REPO_ROOT=app)
//   engine/blackbox-engine[.exe]                       the Rust engine, release build
//
//   node scripts/stage-app.mjs [--target darwin-arm64|win32-x64] [--skip-build] [--engine <prebuilt binary>]
//
// The workspace must be installed (pnpm install). Unless --skip-build is given, this runs the backend, web
// and landing builds first. The engine is compiled for the host; for another target pass --engine with a
// binary built on that platform (the Rust engine is not cross-compiled from macOS to Windows).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { TARGETS, desktopDir, hostTarget, parseTarget } from "./fetch-runtime.mjs";

const repo = path.resolve(desktopDir, "..", "..");
const argv = process.argv.slice(2);
const target = parseTarget(argv);
const t = TARGETS[target];
const out = path.join(desktopDir, "runtime", target);
const app = path.join(out, "app");

function run(cmd, args, opts = {}) {
  process.stdout.write(`  $ ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: repo, shell: process.platform === "win32", ...opts });
}

function must(p) {
  if (!existsSync(p)) throw new Error(`missing ${path.relative(repo, p)} — build the workspace first (or drop --skip-build)`);
  return p;
}

process.stdout.write(`stage-app: ${target}\n`);
if (!argv.includes("--skip-build")) {
  run("pnpm", ["run", "build:backend"]);
  run("pnpm", ["run", "build:worker"]);
  run("pnpm", ["run", "build:web"]);
  run("pnpm", ["run", "build:landing"]);
}

rmSync(app, { recursive: true, force: true });
mkdirSync(path.join(app, "services"), { recursive: true });

// 1. JavaScript services: one ESM bundle per entry point. argon2 stays external (native addon);
//    pg-native is pg's optional native driver and is never used.
const entries = {
  "api-server": "apps/api/dist/server.js",
  "api-cli": "apps/api/dist/cli.js",
  worker: "apps/worker/dist/index.js",
  mcp: "packages/mcp/dist/server.js",
};
for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [must(path.join(repo, entry))],
    outfile: path.join(app, "services", `${name}.mjs`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["argon2", "pg-native"],
    // CommonJS dependencies inside an ESM bundle still call require() for Node built-ins.
    banner: { js: "import { createRequire as __bbCreateRequire } from 'node:module'; const require = __bbCreateRequire(import.meta.url);" },
    legalComments: "linked",
    logLevel: "warning",
  });
  process.stdout.write(`  bundled ${entry} → services/${name}.mjs\n`);
}

// 2. Native addon: argon2 plus its two runtime dependencies, with only the target's prebuild.
const pnpmStore = path.join(repo, "node_modules", ".pnpm");
function storePackage(prefix, name) {
  const dir = readdirSync(pnpmStore).find((d) => d.startsWith(prefix));
  if (!dir) throw new Error(`${name} not found in node_modules/.pnpm (run pnpm install)`);
  return path.join(pnpmStore, dir, "node_modules", name);
}
const argon2 = storePackage("argon2@", "argon2");
const argon2Out = path.join(app, "node_modules", "argon2");
mkdirSync(argon2Out, { recursive: true });
for (const f of ["argon2.cjs", "package.json", "LICENSE"]) cpSync(path.join(argon2, f), path.join(argon2Out, f));
cpSync(must(path.join(argon2, "prebuilds", target)), path.join(argon2Out, "prebuilds", target), { recursive: true });
cpSync(storePackage("node-gyp-build@", "node-gyp-build"), path.join(app, "node_modules", "node-gyp-build"), { recursive: true, dereference: true });
cpSync(storePackage("@phc+format@", "@phc/format"), path.join(app, "node_modules", "@phc", "format"), { recursive: true, dereference: true });

// 3. Static assets, migrations and the contracts the services read at run time.
cpSync(must(path.join(repo, "apps/web/dist")), path.join(app, "web"), { recursive: true });
cpSync(must(path.join(repo, "apps/landing/dist")), path.join(app, "landing"), { recursive: true });
cpSync(path.join(repo, "packages/database/migrations"), path.join(app, "migrations"), { recursive: true });
cpSync(path.join(repo, "packages/contracts"), path.join(app, "packages/contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
mkdirSync(path.join(app, "specs"), { recursive: true });
cpSync(path.join(repo, "specs/question-data-contracts.json"), path.join(app, "specs/question-data-contracts.json"));
cpSync(path.join(repo, "GOLDEN-ORDER-TO-CASH.json"), path.join(app, "GOLDEN-ORDER-TO-CASH.json"));

// 4. Rust engine.
const engineOut = path.join(out, "engine", `blackbox-engine${t.exe}`);
mkdirSync(path.dirname(engineOut), { recursive: true });
const prebuilt = argv.includes("--engine") ? argv[argv.indexOf("--engine") + 1] : null;
if (prebuilt) {
  cpSync(must(path.resolve(prebuilt)), engineOut);
} else {
  if (target !== hostTarget()) throw new Error(`the engine for ${target} must be built on that platform; pass --engine <binary>`);
  run("cargo", ["build", "--release", "-p", "blackbox-engine"]);
  cpSync(must(path.join(repo, "target", "release", `blackbox-engine${t.exe}`)), engineOut);
}

const version = JSON.parse((await import("node:fs")).readFileSync(path.join(repo, "package.json"), "utf8")).version ?? "0.0.0";
writeFileSync(path.join(app, "app.json"), JSON.stringify({ version, target, staged_at: new Date().toISOString() }, null, 2) + "\n");
process.stdout.write(`stage-app: done → ${path.relative(repo, out)}\n`);
