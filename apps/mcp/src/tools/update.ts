import { assertEntryArguments } from '@caveat/core';
import { z } from 'zod';
import { updateEntry, type Source } from '@caveat/core';
import type { McpContext } from '../context.js';

const confidenceSchema = z.enum(['confirmed', 'reproduced', 'tentative']);
const outcomeSchema = z.enum(['resolved', 'impossible']);
const visibilitySchema = z.enum(['public', 'private']);

const patchFrontmatterSchema = z.object({
  title: z.string().optional(),
  confidence: confidenceSchema.optional(),
  outcome: outcomeSchema.optional(),
  visibility: visibilitySchema
    .optional()
    .describe(
      [
        "Change the publish tier. Use the same binary criterion as caveat_record:",
        "'public' if third-party reproducible, 'private' if repo-specific/your-workflow-specific.",
        "When unclear, prefer 'private'. Explicit user instruction overrides auto-classification.",
      ].join(' '),
    ),
  tags: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  last_verified: z.string().optional(),
});

export const updateInputShape = {
  id: z.string(),
  source: z.string()
    .optional()
    .describe('Only own entries may be updated. community entries are subscriptions; edit them upstream.'),
  patch: z.object({
    frontmatter: patchFrontmatterSchema.optional(),
    sections: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Patch H2 sections by heading. When changing the Symptom section, preserve raw errors and exact error strings verbatim; when a stable translation is known, also include the main symptom keywords in Japanese and English to improve retrieval. Do not force a full translation or guess at uncertain wording.',
      ),
  }),
};

export type UpdateArgs = {
  id: string;
  source?: string;
  patch: {
    frontmatter?: z.infer<typeof patchFrontmatterSchema>;
    sections?: Record<string, string>;
  };
};

export function handleUpdate(ctx: McpContext, args: UpdateArgs) {
  assertEntryArguments(args);
  const source = (args.source ?? 'own') as Source;
  if (source !== 'own') {
    throw new Error('community エントリは購読物です; 編集は上流で行ってください');
  }
  const result = updateEntry(args.id, args.patch, {
    db: ctx.db,
    entriesRoot: ctx.paths.entriesDir,
    source,
  });
  ctx.onEntryWritten();
  return result;
}
