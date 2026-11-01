import { ALLOWED_FIELDS, FIELD_TYPES, LIMITS, LOG_LEVELS, LOG_SCOPES, type LogRecord } from "./record.js";

/**
 * Redaction happens BEFORE emission (SYSTEM-AND-DIAGNOSTICS.md): unknown keys are dropped by the
 * allowlist, strings are clipped/escaped, and any string that looks like credential material is
 * replaced even inside allowed fields (defense in depth for `message`/`error_code`).
 */
const SECRET_PATTERNS: RegExp[] = [
  /bbk_[A-Za-z0-9_-]{8,}/g, // owner keys
  /bba_[A-Za-z0-9_-]{8,}/g, // agent keys
  /\$argon2[a-z]*\$[^\s"']+/g, // verifiers
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization headers
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|sig(?:nature)?|x-producer-signature)\s*[=:]\s*\S+/gi,
  /\b(?:cookie|set-cookie)\s*[=:]\s*[^;\s]+/gi,
  /\bbb_session=[^;\s]+/gi,
  /postgres(?:ql)?:\/\/[^\s"']+/gi, // connection strings with passwords
  /https?:\/\/[^\s"'\/]*:[^\s"'@\/]*@[^\s"']+/gi, // URLs with embedded credentials
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email addresses are PII
  /\b(?:sk|pk|rk|shpat|shpca|shppa|ghp|xox[a-z])_[A-Za-z0-9]{8,}/g, // common provider token shapes
  /\b[A-Fa-f0-9]{64}\b/g, // 32-byte hex (hashes/keys) are never needed in logs
  /\/(?:Users|home)\/[^\s"'\/]+/g, // absolute personal paths
];

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;

export function redactString(input: string): { value: string; truncated: boolean } {
  let s = input;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    s = s.replace(re, "[redacted]");
  }
  // Escape control characters and strip HTML-significant brackets so a record can never carry a
  // terminal escape or markup into a viewer; viewers additionally text-escape.
  s = s.replace(CONTROL_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  s = s.replace(/[<>]/g, (c) => (c === "<" ? "\\u003c" : "\\u003e"));
  let truncated = false;
  if (s.length > LIMITS.max_string) {
    s = s.slice(0, LIMITS.max_string - 1) + "…";
    truncated = true;
  }
  return { value: s, truncated };
}

/** Returns true when the string still contains something that looks like a secret (test helper). */
export function looksSensitive(s: string): boolean {
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(s);
  });
}

/**
 * Applies allowlist, typing, clipping and the size cap to a candidate record. Unknown keys are
 * dropped; wrong-typed values are dropped; the result is guaranteed to serialize to at most
 * 16 KiB (message is clipped harder if needed).
 */
export function sanitizeRecord(candidate: Record<string, unknown>): LogRecord {
  const out: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, raw] of Object.entries(candidate)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (raw === undefined || raw === null) continue;
    const type = FIELD_TYPES[key];
    if (type === "string") {
      if (typeof raw !== "string") {
        // Numbers/booleans in string fields are coerced; objects are never serialized.
        if (typeof raw === "number" || typeof raw === "boolean") {
          out[key] = String(raw);
        }
        continue;
      }
      const r = redactString(raw);
      out[key] = r.value;
      if (r.truncated) truncated = true;
    } else if (type === "number") {
      if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
      else if (typeof raw === "bigint") out[key] = Number(raw);
    } else if (type === "boolean") {
      if (typeof raw === "boolean") out[key] = raw;
    }
  }
  if (!LOG_LEVELS.includes(out.level as never)) out.level = "INFO";
  if (!LOG_SCOPES.includes(out.scope as never)) out.scope = out.tenant_id ? "workspace" : "installation";
  if (out.scope === "workspace" && !out.tenant_id) out.scope = "installation";
  if (truncated) out.truncated = true;
  // Size cap: clip message progressively, then drop optional strings.
  let serialized = JSON.stringify(out);
  if (Buffer.byteLength(serialized, "utf8") > LIMITS.max_record_bytes) {
    out.truncated = true;
    out.message = String(out.message ?? "").slice(0, 128);
    serialized = JSON.stringify(out);
    if (Buffer.byteLength(serialized, "utf8") > LIMITS.max_record_bytes) {
      for (const key of Object.keys(out)) {
        if (!["schema_version", "record_id", "occurred_at", "observed_at", "level", "event_name", "message", "component", "service_version", "instance_id", "scope", "truncated"].includes(key)) {
          delete out[key];
        }
      }
    }
  }
  return out as unknown as LogRecord;
}
