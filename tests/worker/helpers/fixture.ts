import { createFixture, FIXTURE_TOKEN, FIXTURE_CLIENT } from '../../../fixtures/shopify/server.mjs';

export { FIXTURE_TOKEN, FIXTURE_CLIENT };
export const FIXTURE_CLOCK = Date.parse('2026-11-01T10:00:00Z');

export interface RunningFixture { url: string; control: (c: Record<string, unknown>) => Promise<void>; state: () => Promise<Record<string, unknown>>; close: () => Promise<void>; raw: ReturnType<typeof createFixture> }

export async function startFixture(opts: { seed?: number; orders?: number; port?: number } = {}): Promise<RunningFixture> {
  const fixture = createFixture({ seed: opts.seed ?? 42, orders: opts.orders ?? 40, clock: FIXTURE_CLOCK });
  let url: string;
  try { url = await fixture.listen(opts.port ?? 19182); } catch { url = await fixture.listen(0); }
  return {
    url, raw: fixture,
    control: async (c) => { await fetch(`${url}/__fixture/control`, { method: 'POST', body: JSON.stringify(c) }); },
    state: async () => (await fetch(`${url}/__fixture/state`)).json() as Promise<Record<string, unknown>>,
    close: () => fixture.close(),
  };
}

export const noSleep = async (_ms: number): Promise<void> => undefined;
