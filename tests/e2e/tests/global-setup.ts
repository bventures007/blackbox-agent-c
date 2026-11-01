// Resets the mock API to a known baseline before a run (mock-only endpoint; no-op against a real backend).
export default async function globalSetup(): Promise<void> {
  const mock = process.env.MOCK_API_URL ?? 'http://127.0.0.1:19189';
  try {
    await fetch(`${mock}/api/_mock/reset`, { method: 'POST' });
  } catch {
    // Not running against the mock: nothing to reset.
  }
}
