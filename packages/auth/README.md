# @blackbox/auth

Owner/agent key generation (`bbk_`/`bba_` + 43 base64url chars from 32 random bytes), argon2id
verifiers, sessions with absolute/idle expiry, login throttling, CSRF/Origin/Host allowlist helpers,
agent key lifecycle (create/list/revoke, read-only grant), authenticated owner key rotation,
host-only `resetAccess` (requires the secrets directory), redacted `security_audit` rows, and the
installation data key (`SECRETS_DIR/data.key`, AES-256-GCM with tenant|purpose|key_version AAD,
HKDF-derived PII anchors). Keys are returned once to the caller and never logged.
