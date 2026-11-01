/**
 * Mapping unit tests — one case per family in packages/contracts/events.json.
 * Covers: INGEST-04 (version/effective-time rules are table-driven), PILOT-08 (PII anchors, no
 * tenant/secret keys in canonical payloads), GOLDEN semantics (authorization ≠ capture, invoice
 * paid marker ≠ cash, credit note ≠ refund, payout announced ≠ cash, return intent ≠ receipt).
 */
import { describe, expect, it } from "vitest";
import { GOLDEN_FAMILIES, canonicalJson, contentHash, getMapping, listMappings, loadEventsContract, loadGoldenFixture, mapObservation, sanitizePayload, type Observation } from "@blackbox/application";

const anchor = (field: string, value: string) => `anc_${field}_${value.length}`;
const opts = { anchor, provider: "test", producer: "replay", runKind: null };

function obs(kind: string, payload: Record<string, unknown>, entity: Record<string, string> = { order: "#1001", customer: "C-1", item: "CUP-OLV" }): Observation {
  return { provider_event_id: `pe-${kind}`, kind, occurred_at: "2026-10-31T09:00:00Z", entity, payload, evidence_refs: [] };
}

describe("event vocabulary coverage", () => {
  const contract = loadEventsContract();
  const families = Object.keys(contract.families);

  it("every family has a mapping whose tracks are a subset of the declared tracks", () => {
    expect(families.length).toBeGreaterThan(60);
    for (const kind of families) {
      const m = getMapping(kind);
      for (const t of m.tracks) expect(contract.families[kind]!.tracks).toContain(t);
      expect(m.tracks).toContain("source");
      expect(m.tracks).toContain("fact");
    }
    expect(listMappings().length).toBe(families.length);
  });

  it("all 19 golden kinds have an explicit golden mapping", () => {
    const golden = families.filter((k) => contract.families[k]!.golden_example);
    expect(golden.length).toBe(19);
    for (const kind of golden) expect(GOLDEN_FAMILIES[kind], kind).toBeDefined();
  });

  for (const kind of families) {
    it(`accepts ${kind} as a source observation with its declared tracks`, () => {
      const family = contract.families[kind]!;
      const example = family.golden_example?.example_payload ?? { [getMapping(kind).primary]: "X-1", version: 1, rule: "r1", unit: "piece", physical: 1, quarantined: 0, reserved: 0, sku: "X", status: "booked", amount_minor: 1, currency: "EUR" };
      const mapped = mapObservation(obs(kind, example), opts);
      expect(mapped.source.track).toBe("source");
      expect(mapped.source.event_type).toBe(kind);
      expect(mapped.source.record_id).toBe(`source:test:pe-${kind}`);
      expect(mapped.dataset).toBe(family.dataset);
      for (const d of mapped.derived) {
        expect(family.tracks).toContain(d.track);
        expect(d.derivation_rule).toBe(`mapping.${kind}`);
      }
      if (family.golden_example) expect(mapped.derived.some((d) => d.track === "fact")).toBe(true);
    });
  }
});

describe("golden semantics", () => {
  const golden = loadGoldenFixture();
  const byId = Object.fromEntries(golden.events.map((e) => [e.id, e]));
  const map = (id: string) => mapObservation({ provider_event_id: byId[id]!.provider_event_id, kind: byId[id]!.kind, occurred_at: byId[id]!.occurred_at, entity: byId[id]!.entity, payload: byId[id]!.payload, evidence_refs: [] }, opts);
  const tracks = (id: string) => map(id).derived.map((d) => d.track).sort();

  it("G01 inventory snapshot is a fact, never a movement", () => {
    expect(tracks("G01")).toEqual(["fact"]);
    expect(map("G01").derived[0]!.payload.is_new_movement).toBe(false);
  });
  it("G02 order accepted creates a customer commitment with quantity and gross amount", () => {
    expect(tracks("G02")).toEqual(["commitment", "fact"]);
    const c = map("G02").derived.find((d) => d.track === "commitment")!;
    expect(c.payload).toMatchObject({ kind: "customer_order", quantity: "10", unit: "piece", amount_minor: 11900, currency: "EUR" });
    expect(c.record_id).toBe("order:#1001");
  });
  it("G03 reservation extends the reservation track", () => {
    expect(tracks("G03")).toEqual(["fact", "reservation"]);
    expect(map("G03").derived.find((d) => d.track === "reservation")!.record_id).toBe("reservation:R-1001");
  });
  it("G04 invoice issued records a receivable commitment", () => {
    expect(map("G04").derived.find((d) => d.track === "commitment")!.payload).toMatchObject({ kind: "receivable", amount_minor: 11900 });
  });
  it("G05 authorization is not a capture: no movement", () => {
    expect(tracks("G05")).toEqual(["fact"]);
  });
  it("G06 capture is a cash movement into the provider balance", () => {
    const m = map("G06").derived.find((d) => d.track === "movement")!;
    expect(m.payload).toMatchObject({ kind: "cash", direction: "in", ledger: "provider_balance", amount_minor: 11900 });
  });
  it("G07 fee is a cash movement out of the provider balance", () => {
    expect(map("G07").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ direction: "out", amount_minor: 350 });
  });
  it("G08 invoice payment marker never adds cash (the family has no movement track)", () => {
    expect(tracks("G08")).toEqual(["fact"]);
    expect(map("G08").derived[0]!.payload.requires_payment_evidence).toBe(false);
    const withCash = mapObservation(obs("invoice.payment_marked", { ...byId.G08!.payload, is_new_cash_movement: true }), opts);
    expect(withCash.derived.map((d) => d.track)).toEqual(["fact"]);
    expect(withCash.derived[0]!.payload.requires_payment_evidence).toBe(true);
  });
  it("G09 dispatch moves goods out and releases the reservation", () => {
    expect(tracks("G09")).toEqual(["fact", "movement", "reservation"]);
    const mv = map("G09").derived.find((d) => d.track === "movement")!;
    expect(mv.payload).toMatchObject({ kind: "goods", direction: "out", quantity: "10", unit: "piece", physical_stock_delta: "-10" });
    expect(map("G09").derived.find((d) => d.track === "reservation")!.payload).toMatchObject({ state: "released", quantity: "10" });
  });
  it("G10 delivery scan is a fact only", () => {
    expect(tracks("G10")).toEqual(["fact"]);
  });
  it("G11 return approval is intent, not receipt or refund", () => {
    expect(tracks("G11")).toEqual(["fact"]);
  });
  it("G12/G13 receipt and restock are goods movements (in / quarantine transfer)", () => {
    expect(map("G12").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ direction: "in", to_state: "quarantined", quantity: "2" });
    expect(map("G13").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ direction: "transfer", from_state: "quarantined", to_state: "available", physical_stock_delta: "0" });
  });
  it("G14 credit note is a commitment, not a refund", () => {
    expect(tracks("G14")).toEqual(["commitment", "fact"]);
    expect(map("G14").derived.find((d) => d.track === "commitment")!.payload).toMatchObject({ kind: "credit_note", amount_minor: 2380, cash_refund_confirmed: false });
  });
  it("G15 pending refund places a provider hold (reservation), no cash", () => {
    expect(tracks("G15")).toEqual(["fact", "reservation"]);
    expect(map("G15").derived.find((d) => d.track === "reservation")!.payload).toMatchObject({ kind: "provider_hold", state: "active", amount_minor: 2380 });
  });
  it("G16 completed refund moves cash out and releases the hold", () => {
    expect(tracks("G16")).toEqual(["fact", "movement", "reservation"]);
    expect(map("G16").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ direction: "out", amount_minor: 2380 });
  });
  it("G17 payout announced is a commitment only", () => {
    expect(tracks("G17")).toEqual(["commitment", "fact"]);
  });
  it("G18 payout sent moves provider balance into transit", () => {
    expect(map("G18").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ direction: "out", to_ledger: "in_transit", amount_minor: 9170 });
  });
  it("G19 bank credit is an independent bank movement linked to the referenced payout", () => {
    expect(map("G19").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ ledger: "bank", direction: "in", payout: "OUT-1001", amount_minor: 9170 });
  });
  it("entity refs carry the payload identifiers (invoice, transaction, payout...)", () => {
    expect(map("G08").entityRefs).toMatchObject({ order: "#1001", invoice: "INV-1001", transaction: "TX-1001" });
    expect(map("G19").entityRefs).toMatchObject({ bank_entry: "BANK-1001", payout: "OUT-1001" });
  });
});

describe("validation and sanitization", () => {
  it("rejects unknown kinds and missing/mistyped required fields", () => {
    expect(() => mapObservation(obs("order.teleported", {}), opts)).toThrow(/not in the canonical event vocabulary/);
    expect(() => mapObservation(obs("order.accepted", { order: "#1", quantity: "10", unit_gross_minor: 1, gross_minor: 1, currency: "EUR" }), opts)).toThrow(/quantity/);
    expect(() => mapObservation(obs("payment.captured", { transaction: "T", captured_minor: 11.9, currency: "EUR" }), opts)).toThrow(/captured_minor/);
    expect(() => mapObservation(obs("payment.captured", { transaction: "T", captured_minor: 1190, currency: "eur" }), opts)).toThrow(/ISO 4217/);
    expect(() => mapObservation({ ...obs("order.accepted", {}), occurred_at: "yesterday" }, opts)).toThrow(/occurred_at/);
  });

  it("replaces PII with keyed anchors and drops authority-like keys (PILOT-08, INGEST-01)", () => {
    const out = sanitizePayload({ email: "anna@example.com", name: "Anna Example", address: { street: "Main 1", city: "Berlin" }, tenant_id: "other-tenant", api_key: "x", order: "#1", nested: { phone: "+49", keep: 1 } }, anchor);
    expect(out).toEqual({ email_anchor: "anc_email_16", name_anchor: "anc_name_12", order: "#1", nested: { phone_anchor: "anc_phone_3", keep: 1 } });
    expect(JSON.stringify(out)).not.toMatch(/example\.com|Anna|Berlin|other-tenant/);
  });

  it("content hash is stable under key order and ignores stripped keys", () => {
    const a = mapObservation(obs("order.accepted", { order: "#1", quantity: 1, unit_gross_minor: 100, gross_minor: 100, currency: "EUR" }), opts);
    const b = mapObservation(obs("order.accepted", { currency: "EUR", gross_minor: 100, unit_gross_minor: 100, quantity: 1, order: "#1", tenant_id: "ignored" }), opts);
    const c = mapObservation(obs("order.accepted", { order: "#1", quantity: 2, unit_gross_minor: 100, gross_minor: 200, currency: "EUR" }), opts);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(contentHash({ kind: "k", occurred_at: "t", entity: {}, payload: {} })).toHaveLength(64);
  });

  it("labels backfilled ingestion in the source payload without altering business fields", () => {
    const m = mapObservation(obs("payment.captured", { transaction: "T", captured_minor: 1, currency: "EUR" }), { ...opts, runKind: "backfill" });
    expect(m.source.payload).toMatchObject({ dataset: "payments", ingest: { producer: "replay", run_kind: "backfill", backfill: true } });
  });
});
