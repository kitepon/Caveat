/** Isolation-only planning boundary. No CLI import, transport, filesystem or delivery integration. */
export function planOptionalEvidence<T>(enabled: boolean, publicBytes: Uint8Array, exitCode: number,
  prepare: () => T): { publicBytes: Uint8Array; exitCode: number; privateCandidate: T | null; privateStatus: string } {
  if (!enabled) return { publicBytes, exitCode, privateCandidate: null, privateStatus: 'off' };
  try { return { publicBytes, exitCode, privateCandidate: prepare(), privateStatus: 'prepared' }; }
  catch { return { publicBytes, exitCode, privateCandidate: null, privateStatus: 'unverified' }; }
}
