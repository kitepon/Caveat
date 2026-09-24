import { existsSync } from 'node:fs';
import { listJevObservations, reviewJevObservation, writeUserConfigPatch, type JevReviewVerdict } from '@caveat/core';
import type { CliContext } from '../context.js';
import { readStdin } from '../hookShared.js';
import { jevKeyPath, writeJevKey } from '../jevCredential.js';
import { callJev } from '../jevStruggle.js';

export async function enableJev(ctx: CliContext): Promise<void> {
  const key = (await readStdin()).trim();
  if (!key) throw new Error('Jev API key was not provided on stdin');
  const response = await callJev(key, { purpose: 'Caveat connection check' }, {
    probe: { type: 'noul', instructions: 'Is this a connection check?' },
  });
  if (response.answers.probe?.type !== 'noul') throw new Error('Jev connection check returned an invalid answer');
  writeJevKey(ctx.caveatHome, key);
  writeUserConfigPatch(ctx.userConfigPath, { jevEnabled: true });
  process.stdout.write('Jevによる苦戦判定を有効にしました。\n');
}

export function disableJev(ctx: CliContext): void {
  writeUserConfigPatch(ctx.userConfigPath, { jevEnabled: false });
  process.stdout.write('Jevによる苦戦判定を無効にしました。\n');
}

export function jevStatus(ctx: CliContext): void {
  process.stdout.write(`${JSON.stringify({
    schema: 'caveat.jev_status.v1',
    enabled: ctx.config.jevEnabled,
    credential: existsSync(jevKeyPath(ctx.caveatHome)) ? 'present' : 'missing',
  })}\n`);
}

export function listJevCases(ctx: CliContext): void {
  process.stdout.write(`${JSON.stringify({ schema: 'caveat.jev_cases.v1', cases: listJevObservations(ctx.caveatHome) })}\n`);
}

export function reviewJevCase(ctx: CliContext, id: string, verdict: JevReviewVerdict, note: string): void {
  const item = reviewJevObservation(ctx.caveatHome, id, verdict, note);
  process.stdout.write(`${JSON.stringify({ id: item.id, review: item.review })}\n`);
}
