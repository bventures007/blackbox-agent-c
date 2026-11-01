# @blackbox/api

Fastify 5 API on `127.0.0.1:19180` implementing `docs/api-contract.md`, serving `apps/web/dist`
(SPA fallback) and `apps/landing/dist` at `/landing` when present. Entry points: `dist/server.js`
(server) and `dist/cli.js` (`setup`, `rotate-key`, `reset-access --yes`, `create-agent-key --name`,
`migrate`, `bootstrap`, `logs`, `doctor`, `diagnostics export`; run `--help`). Environment variables
are listed in `docs/architecture.md`. `HOST` other than `127.0.0.1` is refused.
