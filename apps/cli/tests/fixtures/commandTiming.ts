import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const sequence = new Map<string, number>();
/** Fixture-only progress: fixed labels/metrics, never args, paths or output text. */
export function timedFixtureStep<T>(file: string | undefined, step: string, action: () => T,
  summarize: (value: T) => Record<string, number | string | null> = () => ({})): T {
  if (!file) return action();
  const index = (sequence.get(file) ?? 0) + 1; sequence.set(file, index);
  const started = performance.now();
  const emit = (values: Record<string, unknown>) => {
    const line = `${JSON.stringify({ schema: 'caveat.fixture_timing.v1', index, step, ...values })}\n`;
    try { appendFileSync(file, line); } catch { /* Measurement must not alter the test result. */ }
    try { process.stderr.write(`[caveat_fixture_timing] ${line}`); } catch { /* Preserve action/exception semantics. */ }
  };
  emit({ phase: 'begin' });
  try {
    const value = action();
    emit({ phase: 'end', outcome: 'completed', elapsed_ms: Math.round(performance.now() - started), ...summarize(value) });
    return value;
  } catch (error) {
    emit({ phase: 'end', outcome: 'failed', elapsed_ms: Math.round(performance.now() - started) });
    throw error;
  }
}
