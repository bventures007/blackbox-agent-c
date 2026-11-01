#!/usr/bin/env node
import { buildApp, startServer } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`{"level":"ERROR","event_name":"api.config_invalid","message":${JSON.stringify(err.message)}}\n`);
      process.exit(2);
    }
    throw err;
  }
  const built = await buildApp({ config });
  await startServer(built);
  const shutdown = (signal: string) => {
    built.ctx.logger.info("api.stopping", "API stopping", { action_code: signal, termination: "graceful" });
    built
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    built.ctx.logger.error("api.crashed", "Uncaught exception; process terminating", { error_code: "uncaught_exception", termination: "fatal", retryable: false });
    void err;
    built.ctx.collector.close();
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`{"level":"ERROR","event_name":"api.start_failed","message":${JSON.stringify(String((err as Error).message))}}\n`);
  process.exit(1);
});
