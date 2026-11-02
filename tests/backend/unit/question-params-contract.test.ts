import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_PARAMS, buildIntents } from "@blackbox/application";

/** Parses crates/query/src/intents.rs (`param_specs`) so the API's mirrored contract cannot drift from the engine. */
function engineSpecsFromSource(): Record<string, Array<{ name: string; type: string; required: boolean }>> {
  const src = readFileSync(new URL("../../../crates/query/src/intents.rs", import.meta.url), "utf8");
  const consts: Record<string, { name: string; type: string; required: boolean }> = {};
  for (const m of src.matchAll(/const (\w+): ParamSpec = p\("(\w+)", ParamType::(\w+), (true|false), /g)) consts[m[1]] = { name: m[2], type: m[3], required: m[4] === "true" };
  const specs: Record<string, Array<{ name: string; type: string; required: boolean }>> = {};
  for (const m of src.matchAll(/const (SPEC_\d+): &\[ParamSpec\] = &\[([\s\S]*?)\];/g)) {
    const items: Array<{ name: string; type: string; required: boolean }> = [];
    for (const e of m[2].matchAll(/p\("(\w+)", ParamType::(\w+), (true|false), |(\b[A-Z_]+\b)(?=\s*(?:,|\]|$))/g)) {
      if (e[1]) items.push({ name: e[1], type: e[2], required: e[3] === "true" });
      else if (e[4] && consts[e[4]]) items.push(consts[e[4]]);
    }
    specs[m[1]] = items;
  }
  const out: Record<string, Array<{ name: string; type: string; required: boolean }>> = {};
  for (const m of src.matchAll(/"([\w.]+)" => (SPEC_\d+),/g)) out[m[1]] = specs[m[2]];
  return out;
}
const TYPE: Record<string, string> = { Str: "str", Int: "int", Decimal: "decimal", Bool: "bool", Time: "time", StrList: "str_list" };

describe("question parameter contract (API mirror of the engine)", () => {
  it("mirrors crates/query/src/intents.rs exactly for all 24 intents", () => {
    const engine = engineSpecsFromSource();
    expect(Object.keys(engine).sort()).toEqual(Object.keys(ENGINE_PARAMS).sort());
    expect(Object.keys(engine)).toHaveLength(24);
    for (const [intent, spec] of Object.entries(engine)) {
      const mirrored = ENGINE_PARAMS[intent].map((p) => ({ name: p.name, type: p.type, required: p.required }));
      expect(mirrored, intent).toEqual(spec.map((p) => ({ name: p.name, type: TYPE[p.type], required: p.required })));
    }
  });
  it("advertises only engine parameters plus the API's own as_of/limit/cursor and rejects everything else", () => {
    const intents = buildIntents();
    const outstanding = intents.get("invoices.outstanding")!;
    expect(Object.keys(outstanding.template.params_schema.properties).sort()).toEqual(["as_of", "currency", "cursor", "customer_id", "due_before", "limit", "now"]);
    expect(outstanding.schema.safeParse({ from: "2026-09-01T00:00:00Z" }).success).toBe(false);
    expect(outstanding.schema.safeParse({ now: "2026-10-31T10:00:00Z", due_before: "2026-10-01T00:00:00Z" }).success).toBe(true);
    expect(intents.get("receivables.review_queue")!.schema.safeParse({ now: "2026-10-31T10:00:00Z" }).success).toBe(true);
    expect(intents.get("orders.missing_invoice")!.schema.safeParse({ rule: "after_confirmed_dispatch" }).success).toBe(true);
    expect(intents.get("inventory.available_to_sell")!.template.params_schema.required).toEqual(["item_id", "requested_quantity"]);
    expect(intents.get("cancellations.outstanding_steps")!.template.params_schema.required).toEqual(["order_id"]);
  });
});
