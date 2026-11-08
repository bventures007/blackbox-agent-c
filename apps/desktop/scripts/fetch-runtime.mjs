#!/usr/bin/env node
// Downloads the third-party runtimes the desktop app ships next to its own code, for one target:
//   - PostgreSQL 16 portable binaries (theseus-rs/postgresql-binaries, PostgreSQL licence)
//   - the Node.js runtime that executes the bundled API, worker and MCP bridge (MIT)
// Every archive is checked against the publisher's SHA-256 before extraction.
//
//   node scripts/fetch-runtime.mjs [--target darwin-arm64|win32-x64]   (default: this machine)
//
// Output: apps/desktop/runtime/<target>/{postgres,node}/ (gitignored). Re-running skips finished parts.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POSTGRES_VERSION = "16.15.1";
export const NODE_VERSION = "22.23.3";

export const TARGETS = {
  "darwin-arm64": { pgTriple: "aarch64-apple-darwin", pgExt: "tar.gz", node: `node-v${NODE_VERSION}-darwin-arm64`, nodeExt: "tar.gz", nodeBin: "bin/node", exe: "" },
  "win32-x64": { pgTriple: "x86_64-pc-windows-msvc", pgExt: "zip", node: `node-v${NODE_VERSION}-win-x64`, nodeExt: "zip", nodeBin: "node.exe", exe: ".exe" },
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopDir = path.resolve(here, "..");

export function hostTarget() {
  const t = `${process.platform}-${process.arch}`;
  if (!TARGETS[t]) throw new Error(`unsupported host ${t}; supported targets: ${Object.keys(TARGETS).join(", ")}`);
  return t;
}

export function parseTarget(argv) {
  const i = argv.indexOf("--target");
  const t = i >= 0 ? argv[i + 1] : hostTarget();
  if (!TARGETS[t]) throw new Error(`unknown target ${t}; supported: ${Object.keys(TARGETS).join(", ")}`);
  return t;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(url, dest, ghFallback) {
  if (existsSync(dest)) return;
  process.stdout.write(`  download ${url}\n`);
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dest + ".part", Buffer.from(await res.arrayBuffer()));
    renameSync(dest + ".part", dest);
  } catch (e) {
    if (!ghFallback) throw new Error(`download failed for ${url}: ${e.message}`);
    // GitHub release assets: fall back to the GitHub CLI when direct downloads are blocked.
    process.stdout.write(`  direct download failed (${e.message}); trying gh release download\n`);
    const r = spawnSync("gh", ["release", "download", ghFallback.tag, "-R", ghFallback.repo, "-p", path.basename(dest), "-D", path.dirname(dest), "--clobber"], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`download failed for ${url}`);
  }
}

function extract(archive, into) {
  mkdirSync(into, { recursive: true });
  // bsdtar (macOS, Windows 10+) reads both .tar.gz and .zip.
  execFileSync("tar", ["-xf", archive, "-C", into], { stdio: "inherit" });
}

function only(dir) {
  const entries = readdirSync(dir);
  return entries.length === 1 ? path.join(dir, entries[0]) : dir;
}

// Parts of the portable distribution Blackbox never loads: headers/docs, the LLVM JIT (the app runs
// PostgreSQL with jit=off) and the embedded Python for PL/Python. None of the server binaries link them.
const PG_PRUNE = ["include", "doc", "share/doc", "share/man", "lib/bitcode", "lib/Python", "lib/python3.13"];
const PG_PRUNE_LIB = /^(libLLVM.*|LLVM-C.*|llvmjit.*|.*plpython3.*|python3.*\.dll)$/;

// Some licence files ship read-only; Tauri copies resources on every build and cannot overwrite them.
function makeWritable(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    const mode = statSync(p).mode;
    if (!(mode & 0o200)) chmodSync(p, mode | 0o200);
    if (entry.isDirectory()) makeWritable(p);
  }
}

function prunePostgres(pgDir) {
  makeWritable(pgDir);
  for (const drop of PG_PRUNE) rmSync(path.join(pgDir, drop), { recursive: true, force: true });
  for (const dir of ["lib", "bin"]) {
    const d = path.join(pgDir, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (PG_PRUNE_LIB.test(f)) rmSync(path.join(d, f), { recursive: true, force: true });
  }
}

export async function fetchRuntime(target) {
  const t = TARGETS[target];
  const out = path.join(desktopDir, "runtime", target);
  const cache = path.join(desktopDir, "runtime", ".downloads");
  mkdirSync(cache, { recursive: true });

  // PostgreSQL
  const pgDir = path.join(out, "postgres");
  if (!existsSync(path.join(pgDir, "bin", `postgres${t.exe}`))) {
    const name = `postgresql-${POSTGRES_VERSION}-${t.pgTriple}.${t.pgExt}`;
    const base = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${POSTGRES_VERSION}`;
    const gh = { repo: "theseus-rs/postgresql-binaries", tag: POSTGRES_VERSION };
    await download(`${base}/${name}`, path.join(cache, name), gh);
    await download(`${base}/${name}.sha256`, path.join(cache, `${name}.sha256`), gh);
    const expected = readFileSync(path.join(cache, `${name}.sha256`), "utf8").trim().split(/\s+/)[0];
    const actual = sha256(path.join(cache, name));
    if (expected !== actual) throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
    const tmp = path.join(out, ".pg-extract");
    rmSync(tmp, { recursive: true, force: true });
    extract(path.join(cache, name), tmp);
    rmSync(pgDir, { recursive: true, force: true });
    renameSync(only(tmp), pgDir);
    rmSync(tmp, { recursive: true, force: true });
    process.stdout.write(`  PostgreSQL ${POSTGRES_VERSION} → ${pgDir}\n`);
  }
  prunePostgres(pgDir);

  // Node.js
  const nodeDir = path.join(out, "node");
  const nodeExe = path.join(nodeDir, `node${t.exe}`);
  if (!existsSync(nodeExe)) {
    const name = `${t.node}.${t.nodeExt}`;
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
    await download(`${base}/${name}`, path.join(cache, name));
    await download(`${base}/SHASUMS256.txt`, path.join(cache, `SHASUMS256-${NODE_VERSION}.txt`));
    const line = readFileSync(path.join(cache, `SHASUMS256-${NODE_VERSION}.txt`), "utf8").split("\n").find((l) => l.endsWith(`  ${name}`));
    if (!line) throw new Error(`${name} not listed in SHASUMS256.txt`);
    const actual = sha256(path.join(cache, name));
    if (line.split(/\s+/)[0] !== actual) throw new Error(`checksum mismatch for ${name}`);
    const tmp = path.join(out, ".node-extract");
    rmSync(tmp, { recursive: true, force: true });
    extract(path.join(cache, name), tmp);
    mkdirSync(nodeDir, { recursive: true });
    // Only the runtime binary and its licence are shipped; npm/corepack are not needed at run time.
    renameSync(path.join(tmp, t.node, t.nodeBin), nodeExe);
    renameSync(path.join(tmp, t.node, "LICENSE"), path.join(nodeDir, "LICENSE"));
    rmSync(tmp, { recursive: true, force: true });
    process.stdout.write(`  Node.js ${NODE_VERSION} → ${nodeExe}\n`);
  }
  writeFileSync(path.join(out, "runtime.json"), JSON.stringify({ target, postgres: POSTGRES_VERSION, node: NODE_VERSION }, null, 2) + "\n");
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = parseTarget(process.argv.slice(2));
  process.stdout.write(`fetch-runtime: ${target}\n`);
  fetchRuntime(target).catch((e) => {
    process.stderr.write(`fetch-runtime: ${e.message}\n`);
    process.exit(1);
  });
}
