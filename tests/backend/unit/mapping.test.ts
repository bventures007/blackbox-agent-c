/**
 * Mapping unit tests — one case per family in packages/contracts/events.json plus the
 * API-replay vs worker-connector equality proof for the 19 golden kinds.
 * Covers: INGEST-04 (version/effective-time rules are table-driven), PILOT-08 (PII anchors, no
 * tenant/secret keys in canonical payloads), GOLDEN semantics (authorization ≠ capture, invoice
 * paid marker ≠ cash, credit note ≠ refund, payout announced ≠ cash, return intent ≠ receipt) and
 * the ONE-mapping rule: both ingestion paths append identical entry shapes (docs/engine.md).
 */
import { describe, expect, it } from "vitest";
import { GOLDEN_FAMILIES, canonicalJson, contentHash, getMapping, listMappings, loadEventsContract, loadGoldenFixture, mapObservation, linkDerived, sanitizePayload, type Observation } from "@blackbox/application";
import { DERIVED_TRACKS, MemoryEvidenceStore, derivedTracks, ingestObservations, recordIdFor, requiresTestFlag, validateMappingTable, type Observation as WorkerObservation } from "@blackbox/connectors";

const anchor = (field: string, value: string) => `anc_${field}_${value.length}`;
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const opts = { anchor, provider: "test", producer: "replay", runKind: null, connectionId: CONNECTION, accountRef: "acct-1" };

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
      for (const t of derivedTracks(kind)) expect(contract.families[kind]!.tracks).toContain(t);
    }
    expect(listMappings().length).toBe(families.length);
    expect(validateMappingTable()).toEqual([]);
  });

  it("all 19 golden kinds have an explicit golden mapping and a derived-track entry", () => {
    const golden = families.filter((k) => contract.families[k]!.golden_example);
    expect(golden.length).toBe(19);
    for (const kind of golden) {
      expect(GOLDEN_FAMILIES[kind], kind).toBeDefined();
      expect(DERIVED_TRACKS[kind], kind).toBeDefined();
    }
  });

  for (const kind of families) {
    it(`accepts ${kind} as a source observation with its declared tracks`, () => {
      const family = contract.families[kind]!;
      const example = family.golden_example?.example_payload ?? { [getMapping(kind).primary]: "X-1", version: 1, rule: "r1", unit: "piece", physical: 1, quarantined: 0, reserved: 0, sku: "X", status: "booked", amount_minor: 1, currency: "EUR" };
      const mapped = mapObservation(obs(kind, example), opts);
      expect(mapped.source.track).toBe("source");
      expect(mapped.source.event_type).toBe(kind);
      expect(mapped.source.provider_event_id).toBe(`pe-${kind}`);
      expect(mapped.source.correlation_id).toBe(`${CONNECTION}:pe-${kind}`);
      expect(mapped.source.record_id).toBe(mapped.recordId);
      expect(mapped.dataset).toBe(family.dataset);
      expect(mapped.derived.map((d) => d.track)).toEqual(derivedTracks(kind));
      for (const d of mapped.derived) {
        expect(family.tracks).toContain(d.track);
        expect(d.event_type).toBe(kind);
        expect(d.record_id).toBe(mapped.recordId);
        expect(d.correlation_id).toBe(mapped.source.correlation_id);
        expect(d.provider_event_id).toBeNull();
        expect(d.derivation_rule).toBe(`connectors.mapping.v1:${kind}->${d.track}`);
        expect(d.payload).toEqual(mapped.source.payload);
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
    expect(map("G01").recordId).toBe("item:CUP-OLV");
    expect(map("G01").source.payload).toMatchObject({ physical: 120, quarantined: 0, reserved: 0, unit: "piece" });
  });
  it("G02 order accepted creates a customer commitment with quantity and gross amount", () => {
    expect(tracks("G02")).toEqual(["commitment", "fact"]);
    const c = map("G02").derived.find((d) => d.track === "commitment")!;
    expect(c.payload).toMatchObject({ quantity: 10, gross_minor: 11900, currency: "EUR" });
    expect(c.record_id).toBe("order:#1001");
  });
  it("G03 reservation extends the reservation track", () => {
    expect(tracks("G03")).toEqual(["fact", "reservation"]);
    expect(map("G03").derived.find((d) => d.track === "reservation")!.record_id).toBe("reservation:R-1001");
  });
  it("G04 invoice issued records a receivable commitment", () => {
    expect(tracks("G04")).toEqual(["commitment", "fact"]);
    expect(map("G04").recordId).toBe("invoice:INV-1001");
  });
  it("G05 authorization is a fact only (no cash movement)", () => {
    expect(tracks("G05")).toEqual(["fact"]);
  });
  it("G06/G07 capture and fee are cash movements", () => {
    expect(tracks("G06")).toEqual(["fact", "movement"]);
    expect(tracks("G07")).toEqual(["fact", "movement"]);
    expect(map("G06").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ captured_minor: 11900, currency: "EUR" });
  });
  it("G08 invoice payment marker never creates cash", () => {
    expect(tracks("G08")).toEqual(["fact"]);
  });
  it("G09 dispatch moves goods and releases the reservation; G10 delivery is a fact", () => {
    expect(tracks("G09")).toEqual(["fact", "movement", "reservation"]);
    expect(tracks("G10")).toEqual(["fact"]);
  });
  it("G11 return approval is intent only", () => {
    expect(tracks("G11")).toEqual(["fact"]);
  });
  it("G12/G13 receipt and restock are goods movements", () => {
    expect(tracks("G12")).toEqual(["fact", "movement"]);
    expect(tracks("G13")).toEqual(["fact", "movement"]);
    expect(map("G13").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ physical_stock_delta: 0 });
  });
  it("G14 credit note is a commitment, not a refund", () => {
    expect(tracks("G14")).toEqual(["commitment", "fact"]);
    expect(map("G14").source.payload).toMatchObject({ credit_minor: 2380, cash_refund_confirmed: false });
  });
  it("G15 pending refund places a provider hold (reservation), no cash", () => {
    expect(tracks("G15")).toEqual(["fact", "reservation"]);
  });
  it("G16 completed refund moves cash out and releases the hold", () => {
    expect(tracks("G16")).toEqual(["fact", "movement", "reservation"]);
    expect(map("G16").derived.find((d) => d.track === "movement")!.payload).toMatchObject({ amount_minor: 2380 });
  });
  it("G17 payout announced is a commitment only; G18 payout sent moves cash", () => {
    expect(tracks("G17")).toEqual(["commitment", "fact"]);
    expect(tracks("G18")).toEqual(["fact", "movement"]);
  });
  it("G19 bank credit is an independent bank movement linked to the referenced payout", () => {
    expect(tracks("G19")).toEqual(["fact", "movement"]);
    expect(map("G19").entityRefs).toMatchObject({ bank_entry: "BANK-1001", payout: "OUT-1001" });
  });
  it("entity refs carry the payload identifiers (invoice, transaction, payout...) as docs/engine.md expects", () => {
    expect(map("G08").entityRefs).toMatchObject({ order: "#1001", invoice: "INV-1001", transaction: "TX-1001" });
    expect(map("G06").entityRefs).toMatchObject({ order: "#1001", transaction: "TX-1001" });
    expect(map("G01").entityRefs).toMatchObject({ item: "CUP-OLV" });
  });
});

describe("one mapping: API replay path and worker connector path append identical shapes", () => {
  const golden = loadGoldenFixture();
  const goldenKinds = [...new Set(golden.events.map((e) => e.kind))];

  /** Fake pg client capturing append_journal_entries payloads; deliveries/evidence answered minimally. */
  function capturingClient(sourceId: string) {
    const appended: Array<Record<string, unknown>[]> = [];
    let n = 0;
    return {
      appended,
      client: {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes("append_journal_entries")) {
            const entries = JSON.parse(String(params![0])) as Record<string, unknown>[];
            appended.push(entries);
            return { rows: [{ append_journal_entries: entries.map((e) => ({ entry_id: appended.length === 1 ? sourceId : `derived-${n++}`, journal_sequence: ++n, track: e.track, record_id: e.record_id })) }], rowCount: 1 };
          }
          if (sql.includes("FROM deliveries")) return { rows: [], rowCount: 0 };
          if (sql.includes("INSERT INTO journal_evidence")) return { rows: [{ evidence_id: "ev-1" }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
      },
    };
  }

  it("covers exactly the 19 golden kinds", () => {
    expect(goldenKinds.length).toBe(19);
  });

  for (const kind of goldenKinds) {
    it(`${kind}: worker ingestObservations appends what the API mapObservation produces`, async () => {
      const ev = golden.events.find((e) => e.kind === kind)!;
      const sourceId = "00000000-0000-4000-8000-00000000aaaa";
      // Payment-family observations carry the explicit provider test flag on both paths (worker validation requires it).
      const payload = requiresTestFlag(kind) ? { ...ev.payload, test: false } : ev.payload;
      // API path: producer observation (entity + payload), sanitized, record id derived.
      const api = mapObservation({ provider_event_id: ev.provider_event_id, kind: ev.kind, occurred_at: ev.occurred_at, entity: ev.entity, payload, evidence_refs: [], correlation_id: `golden:${ev.id}` }, { anchor, provider: "shopify", producer: "replay", runKind: "backfill", connectionId: CONNECTION, accountRef: "acct-1" });
      const apiSource = { ...api.source, evidence_refs: ["ev-1"] };
      const apiDerived = linkDerived(api.derived.map((d) => ({ ...d, evidence_refs: ["ev-1"] })), sourceId);
      // Worker path: adapter observation (record_id + dataset + evidence blob) through the real ingest client.
      const worker: WorkerObservation = { provider_event_id: ev.provider_event_id, kind: ev.kind, record_id: recordIdFor(ev.kind, payload, ev.entity), dataset: getMapping(ev.kind).dataset, occurred_at: ev.occurred_at, source_time: null, entity: ev.entity, payload: { ...payload }, evidence: { kind: `observation.${ev.kind}`, media_type: "application/json", content: payload }, correlation_id: `golden:${ev.id}`, test: requiresTestFlag(kind) ? false : null };
      const cap = capturingClient(sourceId);
      const outcome = await ingestObservations(cap.client as never, { tenant_id: "22222222-2222-4222-8222-222222222222", connection_id: CONNECTION, provider: "shopify", account_ref: "acct-1", run_id: null, observation_mode: "backfill", evidence: new MemoryEvidenceStore() }, [worker]);
      expect(outcome.accepted).toBe(1);
      const [workerSource] = cap.appended[0]!;
      const workerDerived = cap.appended[1] ?? [];
      expect(workerSource).toEqual(apiSource);
      expect(workerDerived).toEqual(apiDerived);
      expect(api.contentHash).toHaveLength(64);
    });
  }
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
    const mapped = mapObservation(obs("order.accepted", { order: "#1", quantity: 1, unit_gross_minor: 100, gross_minor: 100, currency: "EUR", email: "anna@example.com", tenant_id: "other" }), opts);
    expect(JSON.stringify(mapped.source.payload)).not.toMatch(/example\.com|other/);
    expect(mapped.source.payload.email_anchor).toBe("anc_email_16");
  });

  it("content hash is stable under key order and ignores stripped keys", () => {
    const a = mapObservation(obs("order.accepted", { order: "#1", quantity: 1, unit_gross_minor: 100, gross_minor: 100, currency: "EUR" }), opts);
    const b = mapObservation(obs("order.accepted", { currency: "EUR", gross_minor: 100, unit_gross_minor: 100, quantity: 1, order: "#1", tenant_id: "ignored" }), opts);
    const c = mapObservation(obs("order.accepted", { order: "#1", quantity: 2, unit_gross_minor: 100, gross_minor: 200, currency: "EUR" }), opts);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(contentHash({ kind: "order.accepted", occurred_at: "2026-10-31T09:00:00Z", entity: {}, payload: {} })).toHaveLength(64);
  });

  it("labels the observation mode on every entry without altering business fields", () => {
    const m = mapObservation(obs("payment.captured", { transaction: "T", captured_minor: 1, currency: "EUR" }), { ...opts, runKind: "backfill" });
    expect(m.source.payload).toMatchObject({ transaction: "T", captured_minor: 1, currency: "EUR", observation_mode: "backfill" });
    for (const d of m.derived) expect(d.payload.observation_mode).toBe("backfill");
    expect(mapObservation(obs("payment.captured", { transaction: "T", captured_minor: 1, currency: "EUR" }), { ...opts, producer: "generic" }).source.payload.observation_mode).toBe("live");
  });
});
