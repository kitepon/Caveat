import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from './context.js';
import { observeRuntimeError, type RuntimeErrorImpact } from '@caveat/core';
import { handleSearch, searchInputShape, type SearchArgs } from './tools/search.js';
import { handleGet, getInputShape, type GetArgs } from './tools/get.js';
import { handleRecord, recordInputShape, type RecordArgs } from './tools/record.js';
import { handleUpdate, updateInputShape, type UpdateArgs } from './tools/update.js';
import { handleListRecent, listRecentInputShape, type ListRecentArgs } from './tools/listRecent.js';
import { handlePull, pullInputShape, type PullArgs } from './tools/pull.js';

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
function expectedControlFlow(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^caveat not found:/.test(message) || /^community エントリは購読物/.test(message) || /^immutable frontmatter key:/.test(message);
}
function observeToolFailure<T>(handler: (args: T) => unknown | Promise<unknown>, productVersion = '0.0.0', impact: RuntimeErrorImpact = 'operation_failed') {
  return async (args: T) => {
    try { return jsonResult(await handler(args)); }
    catch (error) { if (!expectedControlFlow(error)) observeRuntimeError('CAVEAT.MCP_TOOL_FAILED', { version: productVersion, impact }); throw error; }
  };
}

export function registerAllTools(server: McpServer, ctx: McpContext, productVersion = '0.0.0'): void {
  server.registerTool(
    'caveat_search',
    {
      title: 'caveat_search',
      description:
        'Search the "caveats" knowledge base — records of time-wasting traps someone already diagnosed, including external-spec issues (GPU/driver/CUDA versions, native-module builds, IDE/shell quirks, platform-specific behavior, library version incompatibilities) and reusable repo-specific context. Call this FIRST when a problem smells like a known trap — before reading stack traces top-to-bottom or trying fixes. Query: 3+ chars, plain tokens only (no OR/NEAR/other FTS5 operators). If it returns 0 hits, retry with synonyms and Japanese/English paraphrases. Returns summary rows including `{id, source}` — pass BOTH to caveat_get for the full body.',
      inputSchema: searchInputShape,
    },
    observeToolFailure((args) => handleSearch(ctx, args as SearchArgs), productVersion),
  );

  server.registerTool(
    'caveat_get',
    {
      title: 'caveat_get',
      description:
        'Fetch the full body (frontmatter + H2 sections + text) of a caveat by id. IMPORTANT: when the id came from caveat_search, you MUST pass the `source` field from that same result (e.g., "community/Caveat"). The default source is "own" only; omitting source for a community entry returns not-found.',
      inputSchema: getInputShape,
    },
    observeToolFailure((args) => handleGet(ctx, args as GetArgs), productVersion),
  );

  server.registerTool(
    'caveat_record',
    {
      title: 'caveat_record',
      description:
        'Create a new caveat: a reusable record of a time-wasting trap (wrong driver, version mismatch, platform bug, IDE quirk, native-module issue, or repo-specific context) so future sessions can find it via caveat_search. REQUIRED BEFORE CALLING: run caveat_search first to avoid duplicates. Set visibility using this binary criterion: `public` if a third party could reproduce it; `private` if it is repo/workflow-specific or depends on intentional local design; when unclear, prefer `private`; follow an explicit user visibility choice. Qualifies: specific symptom + diagnosed cause (or `outcome: impossible` verdict) + environment fingerprint. Does NOT qualify: ordinary project-internal logic bugs, user preferences, session summaries, or ephemeral task notes; reusable repo-specific traps may be `private`. Auto-fills source_session and environment defaults; source_project is left null by design (shared knowledge must not leak per-user project names).',
      inputSchema: recordInputShape,
    },
    observeToolFailure((args) => handleRecord(ctx, args as RecordArgs), productVersion, 'mutation_outcome_unverified'),
  );

  server.registerTool(
    'caveat_update',
    {
      title: 'caveat_update',
      description:
        'Patch an existing caveat — use when newer evidence extends or corrects one that already exists. Frontmatter shallow-merges, but array fields (tags etc.) REPLACE rather than append — to add one tag, read the current list first, then patch with the full new array. Sections match by case-insensitive H2 heading. When changing `Symptom`, preserve raw errors verbatim and add stable Japanese/English symptom keywords when known; do not force or guess translations. Immutable keys: id, created_at, source_session, source_project. Common uses: bump `last_verified` after re-confirming, add a resolution when it was `tentative`, flip `outcome` to `impossible`.',
      inputSchema: updateInputShape,
    },
    observeToolFailure((args) => handleUpdate(ctx, args as UpdateArgs), productVersion, 'mutation_outcome_unverified'),
  );

  server.registerTool(
    'caveat_list_recent',
    {
      title: 'caveat_list_recent',
      description:
        'List caveats ordered by updated_at DESC. Use for browsing recent additions — e.g., showing the user what is new after caveat_pull. Not for search; use caveat_search when you have a query.',
      inputSchema: listRecentInputShape,
    },
    observeToolFailure((args) => handleListRecent(ctx, args as ListRecentArgs), productVersion),
  );

  server.registerTool(
    'caveat_pull',
    {
      title: 'caveat_pull',
      description:
        "git-pull every subscribed community caveat repo (added via `caveat community add`) and re-index. Call when: (a) the user explicitly asks about others' knowledge on a topic, or (b) caveat_search returned empty for a query that feels like it should have hits and a subscribed repo might be stale. Do NOT call reflexively at session start — it is cheap but not free, and stale-by-minutes is acceptable. Safe and idempotent.",
      inputSchema: pullInputShape,
    },
    observeToolFailure((args) => handlePull(ctx, args as PullArgs), productVersion),
  );
}
