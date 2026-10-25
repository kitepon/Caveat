/** Product limits apply before mutation; transport limits remain SDK-owned. */
export const ENTRY_LIMITS = Object.freeze({ arguments: 1024 * 1024, markdown: 1024 * 1024, frontmatter: 64 * 1024, graph: 10_000, depth: 128 });
export type ConstraintMeasure = 'utf8_bytes' | 'expanded_nodes_and_edges' | 'depth';
export class EntryInputConstraintError extends Error {
  readonly code = 'CAVEAT.ENTRY_INPUT_CONSTRAINT';
  readonly beforeMutation = true;
  constructor(readonly field: string, readonly limit: number, readonly actual: number,
    readonly measure: ConstraintMeasure = 'utf8_bytes', readonly actualKind: 'exact' | 'lower_bound' = 'exact', readonly reason = 'limit_exceeded') {
    super(`${field} exceeds the entry input contract (${actualKind === 'lower_bound' ? 'at least ' : ''}${actual} ${measure}, limit ${limit}); split the entry or move metadata into smaller body sections`);
    this.name = 'EntryInputConstraintError';
  }
  toJSON() { return { code: this.code, field: this.field, limit: this.limit, actual: this.actual, measure: this.measure, actual_kind: this.actualKind, reason: this.reason,
    guidance: 'Split the entry into smaller entries/sections; reduce metadata. Existing files, index and updated_at were not changed by this input refusal.' }; }
}
export function assertUtf8Limit(text: string, field: string, limit: number): void {
  const actual = Buffer.byteLength(text, 'utf8');
  if (actual > limit) throw new EntryInputConstraintError(field, limit, actual);
}
/** Iterative counting matches JSON.stringify for JSON wire values, even when
 * nesting is too deep for the native recursive stringifier. No whole expansion. */
export function serializedArgumentsUtf8Bytes(args: unknown): number {
  type Task = { value: unknown } | { finish: object };
  const tasks: Task[] = [{ value: args }], ancestors = new Set<object>(); let bytes = 0;
  while (tasks.length) {
    const task = tasks.pop()!;
    if ('finish' in task) { ancestors.delete(task.finish); continue; }
    const value = task.value;
    if (value === null || typeof value !== 'object') {
      const encoded = JSON.stringify(value); bytes += Buffer.byteLength(encoded ?? 'null'); continue;
    }
    if (ancestors.has(value)) throw new TypeError('arguments must be a JSON value without cycles');
    ancestors.add(value); tasks.push({ finish: value }); bytes += 2;
    if (Array.isArray(value)) {
      bytes += Math.max(0, value.length - 1);
      for (let i = value.length - 1; i >= 0; i--) tasks.push({ value: value[i] });
    } else {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol');
      bytes += Math.max(0, entries.length - 1);
      for (let i = entries.length - 1; i >= 0; i--) { const [key, v] = entries[i]!; bytes += Buffer.byteLength(JSON.stringify(key)) + 1; tasks.push({ value: v }); }
    }
  }
  return bytes;
}
export function assertEntryArguments(args: unknown): void {
  const actual = serializedArgumentsUtf8Bytes(args);
  if (actual > ENTRY_LIMITS.arguments) throw new EntryInputConstraintError('arguments', ENTRY_LIMITS.arguments, actual);
}
/** Count expansions, not distinct object identities; aliases cannot evade limits. */
export function assertFrontmatterGraph(value: unknown): void {
  const ancestors = new Set<object>(); let work = 0, scalarBytes = 0;
  function visit(v: unknown, depth: number): void {
    if (++work > ENTRY_LIMITS.graph) throw new EntryInputConstraintError('frontmatter.graph', ENTRY_LIMITS.graph, work, 'expanded_nodes_and_edges', 'lower_bound');
    if (depth > ENTRY_LIMITS.depth) throw new EntryInputConstraintError('frontmatter.depth', ENTRY_LIMITS.depth, depth, 'depth', 'lower_bound');
    if (typeof v === 'string') scalarBytes += Buffer.byteLength(v);
    if (v === null || typeof v !== 'object') return;
    if (ancestors.has(v)) throw new EntryInputConstraintError('frontmatter.graph', ENTRY_LIMITS.graph, work, 'expanded_nodes_and_edges', 'lower_bound', 'cycle');
    ancestors.add(v);
    for (const [key, child] of Object.entries(v)) {
      if (++work > ENTRY_LIMITS.graph) throw new EntryInputConstraintError('frontmatter.graph', ENTRY_LIMITS.graph, work, 'expanded_nodes_and_edges', 'lower_bound');
      if (!Array.isArray(v)) scalarBytes += Buffer.byteLength(key);
      visit(child, depth + 1);
    }
    ancestors.delete(v);
  }
  visit(value, 0);
  // noRefs dumping must include every expanded string/key. This lower bound
  // prevents allocating an enormous alias expansion before exact dump sizing.
  if (scalarBytes > ENTRY_LIMITS.frontmatter) throw new EntryInputConstraintError('frontmatter', ENTRY_LIMITS.frontmatter, scalarBytes, 'utf8_bytes', 'lower_bound');
}
