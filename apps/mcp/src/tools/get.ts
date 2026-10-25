import { z } from 'zod';
import { readEntryDocument, createCachedContentKeyProvider, type Source } from '@caveat/core';
import type { McpContext } from '../context.js';

export const getInputShape = {
  id: z.string().optional(),
  path: z.string().optional().describe('Relative entry path from entry diagnostics; permits raw reading of an unindexed entry.'),
  offsetBytes: z.number().int().min(0).optional(),
  limitBytes: z.number().int().min(4).max(65536).optional(),
  source: z.string().optional().describe('own or community/<handle>. Default: own'),
};

export type GetArgs = { id?: string; source?: string; path?: string; offsetBytes?: number; limitBytes?: number };

export function handleGet(ctx: McpContext, args: GetArgs) {
  const source = (args.source ?? 'own') as Source;
  const result = readEntryDocument(ctx.db, ctx.paths, { ...args, source, keyProvider: createCachedContentKeyProvider({ caveatHome: ctx.caveatHome }) });
  if (!result) {
    throw new Error(`caveat not found: id=${args.id} source=${source}`);
  }
  return result;
}
