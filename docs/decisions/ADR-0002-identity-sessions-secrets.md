# ADR-0002 Personal key, sessions, agent keys and secrets

Status: accepted (P0)

- Owner key: `bbk_` + 43 base64url chars (256 random bits from `crypto.randomBytes(32)`). Shown once by `./blackbox setup` on the terminal (protected host channel). Only an argon2id verifier (maintained `argon2` package) is stored.
- Agent keys: `bba_` + 43 base64url chars, same verifier scheme, separate `principals`/`credentials` rows, read-only grant `workspace.read_business`.
- Sessions: opaque 256-bit session id in an HttpOnly, SameSite=Lax cookie; server-side `sessions` row with absolute/idle expiry (remembered: 30 d / 7 d idle; ordinary: 8 h, session cookie). Login throttled per source with a fixed-window counter in PostgreSQL. CSRF: double-submit header `X-Blackbox-CSRF` plus exact `Origin`/`Host` allowlist (`http://127.0.0.1:19180`, `http://localhost:19180`).
- Installation data key: 32 random bytes in `secrets/data.key` (0600, dir 0700) on the host, mounted read-only into api/worker. Provider credentials are encrypted with AES-256-GCM (Node `crypto`), unique 12-byte nonce, AAD = `tenant_id|purpose|key_version`. Backup recovery: `age` X25519 recipient public key stored, private identity shown once; backups are `age`-encrypted tar streams.
- Host-only reset: `./blackbox reset-access` runs inside the host wrapper, requires filesystem access to the secrets directory, rotates the owner key, revokes sessions and agent keys, appends a redacted audit row.

Alternatives: passkeys/OIDC (deferred by owner decision); custom HMAC scheme (rejected: no custom crypto protocol).
