/**
 * Table-driven mapping from an observation (one Source entry) to the derived journal tracks.
 *
 * The derived track selection follows GOLDEN-ORDER-TO-CASH.json semantics and is constrained by
 * packages/contracts/events.json (a derived track must be listed for the family). The same table
 * shape is intended for the API replay path (packages/application) so the two can be unified.
 */
import { createRequire } from 'node:module';
import type { Track } from './types.js';

const require = createRequire(import.meta.url);
const events = require('../../contracts/events.json') as {
  families: Record<string, { dataset: string; tracks: Track[] }>;
  internal: Record<string, { tracks: Track[] }>;
};

export const MAPPING_RULE_VERSION = 1;

/**
 * Derived tracks per family. Source is always appended first and is never listed here.
 * A family absent from this table derives nothing beyond its Source entry unless events.json lists
 * 'fact', in which case a fact is derived (an observation is at least a fact about the source).
 */
export const DERIVED_TRACKS: Record<string, Track[]> = {
  'order.accepted': ['fact'],
  'order.revised': ['fact'],
  'order.cancelled': ['fact'],
  'inventory.snapshot': ['fact'],
  'inventory.adjustment_observed': ['fact'],
  'inventory.reserved': ['reservation'],
  'inventory.reservation_released': ['reservation'],
  'allocation.revised': ['fact'],
  // events.json lists payments as source/fact/movement: an authorization or void is a fact about the
  // payment, never a cash movement (and the commitment track is not declared for this family).
  'payment.authorized': ['fact'],
  'payment.captured': ['movement'],
  'payment.failed': ['fact'],
  'payment.voided': ['fact'],
  'payment.fee_booked': ['movement'],
  'invoice.issued': ['commitment'],
  'invoice.payment_marked': ['fact'],
  'invoice.credit_issued': ['fact', 'commitment'],
  'invoice.cancelled': ['commitment'],
  'invoice.revised': ['commitment'],
  'shipment.observed': ['fact'],
  'shipment.dispatched': ['movement', 'reservation'],
  'shipment.delivered': ['fact'],
  'shipment.cancelled': ['fact'],
  'return.approved': ['fact'],
  'return.revised': ['fact'],
  'return.cancelled': ['fact'],
  'return.received': ['movement'],
  'return.restocked': ['movement'],
  'return.disposition_observed': ['fact'],
  'refund.pending': ['reservation'],
  'refund.completed': ['movement', 'reservation'],
  'refund.failed': ['fact'],
  'refund.reversed': ['movement'],
  'payout.announced': ['commitment'],
  'payout.sent': ['movement'],
  'payout.failed': ['fact'],
  'payout.reversed': ['movement'],
  'provider.ledger_posted': ['movement'],
  'provider.balance_observed': ['fact'],
  'provider.hold_recorded': ['reservation'],
  'provider.hold_released': ['reservation'],
  'provider.release_promised': ['commitment'],
  'dispute.opened': ['fact'],
  'dispute.resolved': ['fact'],
  'chargeback.debit_posted': ['movement'],
  'chargeback.reversed': ['movement'],
  'bank.credit_booked': ['movement'],
  'bank.debit_booked': ['movement'],
  'bank.match_recorded': ['fact'],
  'bank.match_revised': ['fact'],
};

/** Payment-family events whose provider test flag must be an explicit payload field (payout objects carry no test flag). */
const TEST_FLAG_REQUIRED = new Set([
  'payment.authorized', 'payment.captured', 'payment.failed', 'payment.voided', 'payment.fee_booked',
  'refund.pending', 'refund.completed', 'refund.failed', 'refund.reversed',
  'provider.ledger_posted', 'chargeback.debit_posted', 'chargeback.reversed',
]);

export function isKnownFamily(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(events.families, kind) || Object.prototype.hasOwnProperty.call(events.internal, kind);
}

export function familyDataset(kind: string): string | null {
  return events.families[kind]?.dataset ?? null;
}

export function allowedTracks(kind: string): Track[] {
  return events.families[kind]?.tracks ?? events.internal[kind]?.tracks ?? [];
}

export function requiresTestFlag(kind: string): boolean {
  return TEST_FLAG_REQUIRED.has(kind);
}

/** Derived tracks for a family, validated against events.json. Throws on an unknown family. */
export function derivedTracks(kind: string): Track[] {
  if (!isKnownFamily(kind)) throw new Error(`unknown event family: ${kind}`);
  const allowed = allowedTracks(kind);
  const wanted = DERIVED_TRACKS[kind] ?? (allowed.includes('fact') ? ['fact'] : []);
  const invalid = wanted.filter((t) => !allowed.includes(t));
  if (invalid.length) throw new Error(`mapping for ${kind} derives ${invalid.join(',')} not allowed by events.json`);
  return wanted.filter((t) => t !== 'source');
}

export function derivationRule(kind: string, track: Track): string {
  return `connectors.mapping.v${MAPPING_RULE_VERSION}:${kind}->${track}`;
}

/** Self-check used by tests: every table entry is a known family with allowed tracks. */
export function validateMappingTable(): string[] {
  const problems: string[] = [];
  for (const kind of Object.keys(DERIVED_TRACKS)) {
    try { derivedTracks(kind); } catch (e) { problems.push((e as Error).message); }
  }
  return problems;
}
