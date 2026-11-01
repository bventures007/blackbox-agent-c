#!/usr/bin/env node
// SLICE-01 helper: real MCP protocol path. Spawns the stdio bridge (packages/mcp/dist/server.js)
// with the official SDK client and calls one tool, printing the tool's JSON text to stdout.
//   node tests/slice/mcp-state.mjs <tool> '<json arguments>'
// Env: BLACKBOX_AGENT_KEY_FILE (agent key file, never argv), BLACKBOX_API_URL, BLACKBOX_MCP_SERVER (path).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [tool, rawArgs] = process.argv.slice(2);
if (!tool) {
  process.stderr.write("usage: mcp-state.mjs <tool> '<json arguments>'\n");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.env.BLACKBOX_MCP_SERVER ?? path.resolve(here, "..", "..", "packages", "mcp", "dist", "server.js");
const env = { ...process.env };
const transport = new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: "pipe" });
const stderrChunks = [];
transport.stderr?.on("data", (d) => stderrChunks.push(String(d)));
const client = new Client({ name: "slice-01-client", version: "1.0.0" });
let exitCode = 0;
try {
  await client.connect(transport);
  const result = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) exitCode = 3;
  process.stdout.write(text + "\n");
} catch (err) {
  exitCode = 4;
  process.stdout.write(JSON.stringify({ error: { code: "bridge_unavailable", message: String(err?.message ?? err), stderr: stderrChunks.join("").slice(0, 800) } }) + "\n");
} finally {
  await client.close().catch(() => {});
}
process.exit(exitCode);
