/** Match executable/entry tokens, never a desktop helper name or a later command argument. */
export function isClaudeCodeProcess(argv: string[] | null, executable?: string) {
  const image = executable?.replaceAll('\\', '/');
  const embedded = (value: string) => /(?:^|\/)claude-code\/[^/]+\/(?:[^/]+\/)*claude\.app\/Contents\/MacOS\/claude$/.test(value);
  if (image && /\/Claude\.app\/Contents\//i.test(image) && !embedded(image)) return false;
  const tokens = [image, ...(argv?.slice(0, 2) ?? [])].filter((value): value is string => !!value).map(value => value.replaceAll('\\', '/'));
  return tokens.some(value => /(?:^|\/)@anthropic-ai\/claude-code\/(?:cli\.js|bin\/claude(?:\.exe)?)$/i.test(value)
    || embedded(value)
    || /(?:^|\/)bin\/claude(?:\.exe)?$/i.test(value)
    || /^(?:claude|claude\.exe)$/.test(value));
}
