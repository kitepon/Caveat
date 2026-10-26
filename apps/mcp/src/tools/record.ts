import { assertEntryArguments } from '@caveat/core';
import { z } from 'zod';
import { recordEntry } from '@caveat/core';
import type { McpContext } from '../context.js';

const confidenceSchema = z.enum(['confirmed', 'reproduced', 'tentative']);
const outcomeSchema = z.enum(['resolved', 'impossible']);
const visibilitySchema = z.enum(['public', 'private']);

export const recordInputShape = {
  title: z.string().min(1),
  symptom: z.string().min(1).describe(
    'Describe the observed failure. Preserve raw errors and exact error strings verbatim; when a stable translation is known, also include the main symptom keywords in Japanese and English to improve retrieval. Do not force a full translation or guess at uncertain wording.',
  ),
  cause: z.string().optional(),
  resolution: z.string().optional(),
  evidence: z.string().optional(),
  context: z.string().optional(),
  confidence: confidenceSchema.optional(),
  outcome: outcomeSchema.optional(),
  visibility: visibilitySchema.describe(
    [
      'REQUIRED. Classify using this binary criterion:',
      "- 'public' if a third party running the same external tool/spec could reproduce this gotcha (external-spec trap, e.g. PyInstaller/Stripe/Podman/Claude Code hook behavior).",
      "- 'private' if it is specific to your repo, your workflow, an intentional non-standard design, or context that only exists in this project.",
      "- When unclear, prefer 'private' (leak-safety).",
      'Exception: if the user explicitly asks to record it as private/public (e.g. "save this as private", "これは自分用にメモして"), follow the user\'s instruction regardless of the criterion — explicit user intent overrides auto-classification.',
      "When recording with visibility: 'private', always include repo-specific identifiers (function names, file paths, class names, custom terminology) in the body so the entry can be retrieved later by co-occurrence FTS when you touch that area again.",
    ].join(' '),
  ),
  tags: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  category: z.string().optional().describe('Directory under entries/ (e.g., gpu, claude-code). Default: misc'),
};

export type RecordArgs = {
  title: string;
  symptom: string;
  cause?: string;
  resolution?: string;
  evidence?: string;
  context?: string;
  confidence?: 'confirmed' | 'reproduced' | 'tentative';
  outcome?: 'resolved' | 'impossible';
  visibility: 'public' | 'private';
  tags?: string[];
  environment?: Record<string, string>;
  category?: string;
};

export function handleRecord(ctx: McpContext, args: RecordArgs) {
  assertEntryArguments(args);
  const result = recordEntry(args, {
    db: ctx.db,
    entriesRoot: ctx.paths.entriesDir,
  });
  ctx.onEntryWritten();
  return result;
}
