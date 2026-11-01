import { MemoryEvidenceStore } from '@blackbox/connectors';
import { SyncEngine, type SyncDeps } from '../../../apps/worker/src/sync.ts';
import { createLogger, type Logger } from '../../../apps/worker/src/logger.ts';
import { FakeClock, systemClock, type Clock } from '../../../apps/worker/src/clock.ts';
import { DEFAULT_THRESHOLDS, type StorageState } from '../../../apps/worker/src/storage.ts';
import { createAdapter, type SourceAdapter } from '@blackbox/connectors';
import type { TestDb } from './db.ts';
import { KEYRING } from './db.ts';
import { Writable } from 'node:stream';

export function collectingLogger(): { logger: Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const sink = new Writable({ write(chunk, _enc, cb) { for (const line of String(chunk).split('\n')) if (line.trim()) records.push(JSON.parse(line)); cb(); } });
  return { logger: createLogger({ component: 'worker', service_version: 'test', instance_id: 'test-worker', level: 'debug', destination: sink }), records };
}

export function storageState(state: StorageState['state'] = 'ok'): StorageState {
  return { state, observed_at: new Date().toISOString(), volumes: [{ path: '/test', total_bytes: 100, free_bytes: state === 'critical' ? 1 : 50, state, reason: null }], thresholds: DEFAULT_THRESHOLDS };
}

export function makeEngine(db: TestDb, opts: { clock?: Clock; storage?: () => Promise<StorageState>; adapterFactory?: SyncDeps['adapterFactory']; max_pages_per_job?: number; sleep?: (ms: number) => Promise<void> } = {}): { engine: SyncEngine; records: Record<string, unknown>[]; evidence: MemoryEvidenceStore; logger: Logger } {
  const { logger, records } = collectingLogger();
  const evidence = new MemoryEvidenceStore();
  const sleep = opts.sleep ?? (async () => undefined);
  const adapterFactory: SyncDeps['adapterFactory'] = opts.adapterFactory ?? ((provider, config, secret, account_ref): SourceAdapter => createAdapter(provider, config, secret, account_ref, { sleep }));
  const engine = new SyncEngine({ pool: db.pool, logger, clock: opts.clock ?? systemClock, evidence, keyring: KEYRING, storage: opts.storage ?? (async () => storageState('ok')), lease_seconds: 300, max_pages_per_job: opts.max_pages_per_job ?? 500, instance_id: 'test-worker', adapterFactory });
  return { engine, records, evidence, logger };
}

export { FakeClock };
