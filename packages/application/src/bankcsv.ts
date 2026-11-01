import { createHash } from "node:crypto";
import type { Pool } from "@blackbox/database";
import { withTenant } from "@blackbox/database";
import type { Observation } from "./mapping/index.js";

export const BANK_CSV_COLUMNS = ["date", "amount", "currency", "reference", "counterparty", "booking_text"] as const;
export const BANK_CSV_MAX_BYTES = 5 * 1024 * 1024;
export const BANK_CSV_MAX_ROWS = 5000;

export interface BankCsvRow {
  line: number;
  date: string; // YYYY-MM-DD
  amount_minor: number;
  currency: string;
  reference: string;
  counterparty: string;
  booking_text: string;
}

export interface BankCsvParsed {
  row: BankCsvRow;
  /** The booked row itself: pure row content, so a re-import of the same row is always a duplicate. */
  observation: Observation;
  /** Derived link assertion (bank.match_recorded) appended as its own observation when matched. */
  match_observation: Observation | null;
  match: { status: "matched"; payout: string; basis: "reference" | "amount" } | { status: "ambiguous"; candidates: string[] } | { status: "unmatched" };
}

export interface BankCsvPreview {
  rows: number;
  parsed: BankCsvParsed[];
  ambiguous: number;
  errors: Array<{ line: number; message: string }>;
}

function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "");
  if (!s) return null;
  // Accept 1.234,56 / 1,234.56 / 1234.56 / 1234,56 / -12,5
  let normalized = s;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) normalized = s.replace(/\./g, "").replace(",", ".");
  else normalized = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const neg = normalized.startsWith("-");
  const [int, frac = ""] = normalized.replace("-", "").split(".") as [string, string?];
  const minor = Number(int) * 100 + Number((frac ?? "").padEnd(2, "0"));
  return neg ? -minor : minor;
}

function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/** Minimal RFC4180-ish line splitter for ';' with optional double quotes. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseBankCsv(csv: string, timezone = "Europe/Berlin"): { rows: BankCsvRow[]; errors: Array<{ line: number; message: string }> } {
  if (Buffer.byteLength(csv, "utf8") > BANK_CSV_MAX_BYTES) throw new Error(`csv exceeds ${BANK_CSV_MAX_BYTES} bytes`);
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  const errors: Array<{ line: number; message: string }> = [];
  const rows: BankCsvRow[] = [];
  const headerLine = lines.findIndex((l) => l.trim() !== "");
  if (headerLine < 0) return { rows, errors: [{ line: 0, message: "empty file" }] };
  const header = splitLine(lines[headerLine]!).map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const col of BANK_CSV_COLUMNS) {
    const i = header.indexOf(col);
    if (i < 0) errors.push({ line: headerLine + 1, message: `missing column '${col}' (expected header: ${BANK_CSV_COLUMNS.join(";")})` });
    idx[col] = i;
  }
  if (errors.length > 0) return { rows, errors };
  void timezone;
  for (let i = headerLine + 1; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    if (rows.length >= BANK_CSV_MAX_ROWS) {
      errors.push({ line: i + 1, message: `more than ${BANK_CSV_MAX_ROWS} rows; split the file` });
      break;
    }
    const cells = splitLine(raw);
    const get = (col: string) => (cells[idx[col]!] ?? "").trim();
    const date = parseDate(get("date"));
    const amount = parseAmount(get("amount"));
    const currency = get("currency").toUpperCase();
    if (!date) errors.push({ line: i + 1, message: "invalid date (YYYY-MM-DD or DD.MM.YYYY)" });
    if (amount === null) errors.push({ line: i + 1, message: "invalid amount" });
    if (!/^[A-Z]{3}$/.test(currency)) errors.push({ line: i + 1, message: "invalid currency" });
    if (!date || amount === null || !/^[A-Z]{3}$/.test(currency)) continue;
    rows.push({ line: i + 1, date, amount_minor: amount, currency, reference: get("reference"), counterparty: get("counterparty"), booking_text: get("booking_text") });
  }
  return { rows, errors };
}

/** Deterministic provider event identity: the booked row content (same row re-imported = duplicate). */
export function bankRowIdentity(row: BankCsvRow): string {
  return "csv:" + createHash("sha256").update(`${row.date}|${row.amount_minor}|${row.currency}|${row.reference}|${row.counterparty}|${row.booking_text}`).digest("hex").slice(0, 32);
}

/**
 * Builds bank observations and detects payout matches: a credit matches a payout when exactly one
 * unmatched `payout.sent` entry has the same amount/currency or its id appears in the reference.
 * Multiple candidates → ambiguous (review case; no payout link is asserted).
 */
export class BankCsvService {
  constructor(private readonly pool: Pool) {}

  async preview(tenantId: string, csv: string): Promise<BankCsvPreview> {
    const { rows, errors } = parseBankCsv(csv);
    const payouts = await this.openPayouts(tenantId);
    const parsed: BankCsvParsed[] = rows.map((row) => {
      const id = bankRowIdentity(row);
      const bankEntry = `BANK-${id.slice(4, 16)}`;
      const credit = row.amount_minor >= 0;
      const match = credit ? matchPayout(row, payouts) : ({ status: "unmatched" } as const);
      const payload: Record<string, unknown> = {
        bank_entry: bankEntry,
        amount_minor: Math.abs(row.amount_minor),
        currency: row.currency,
        status: "booked",
        reference: row.reference.slice(0, 140),
        counterparty: row.counterparty, // PII → anchored by the mapping sanitizer
        booking_text: row.booking_text, // free text → anchored by the mapping sanitizer
        booking_date: row.date,
      };
      const observation: Observation = { provider_event_id: id, kind: credit ? "bank.credit_booked" : "bank.debit_booked", occurred_at: `${row.date}T00:00:00.000Z`, entity: { bank_entry: bankEntry }, payload, evidence_refs: [] };
      const match_observation: Observation | null =
        match.status === "matched"
          ? { provider_event_id: `match:${id}:${match.payout}`, kind: "bank.match_recorded", occurred_at: `${row.date}T00:00:00.000Z`, entity: { bank_entry: bankEntry, payout: match.payout }, payload: { bank_entry: bankEntry, payout: match.payout, amount_minor: Math.abs(row.amount_minor), currency: row.currency, basis: match.basis, provenance: "matcher" }, evidence_refs: [id] }
          : null;
      return { row, observation, match_observation, match };
    });
    return { rows: rows.length, parsed, ambiguous: parsed.filter((p) => p.match.status === "ambiguous").length, errors };
  }

  private async openPayouts(tenantId: string): Promise<Array<{ payout: string; amount_minor: number; currency: string; matched: boolean }>> {
    return withTenant(this.pool, tenantId, async (c) => {
      const sent = await c.query<{ record_id: string; payload: Record<string, unknown> }>("SELECT record_id, payload FROM journal_entries WHERE track = 'fact' AND event_type = 'payout.sent'");
      const bank = await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM journal_entries WHERE track = 'fact' AND event_type IN ('bank.credit_booked', 'bank.match_recorded') AND payload ? 'payout'");
      const matched = new Set(bank.rows.map((b) => String(b.payload.payout)));
      return sent.rows.map((r) => ({ payout: String(r.payload.payout ?? r.record_id.replace(/^payout:/, "")), amount_minor: Number(r.payload.amount_minor), currency: String(r.payload.currency), matched: matched.has(String(r.payload.payout)) }));
    });
  }
}

function matchPayout(row: BankCsvRow, payouts: Array<{ payout: string; amount_minor: number; currency: string; matched: boolean }>): BankCsvParsed["match"] {
  const open = payouts.filter((p) => !p.matched && p.currency === row.currency);
  const byRef = open.filter((p) => row.reference.includes(p.payout) || row.booking_text.includes(p.payout));
  if (byRef.length === 1) return { status: "matched", payout: byRef[0]!.payout, basis: "reference" };
  if (byRef.length > 1) return { status: "ambiguous", candidates: byRef.map((p) => p.payout) };
  const byAmount = open.filter((p) => p.amount_minor === row.amount_minor);
  if (byAmount.length === 1) return { status: "matched", payout: byAmount[0]!.payout, basis: "amount" };
  if (byAmount.length > 1) return { status: "ambiguous", candidates: byAmount.map((p) => p.payout) };
  return { status: "unmatched" };
}
