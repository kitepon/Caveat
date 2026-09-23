import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface CaveatConfig {
  knowledgeRepo: string;
  semverKeys: string[];
  publishTarget: string | null;
  sealedKeyId: string;
  sealedKeyserverUrl: string | null;
  runtimeErrors: boolean;
  jevEnabled: boolean;
}

export const DEFAULT_CONFIG: CaveatConfig = {
  knowledgeRepo: 'own',
  semverKeys: ['driver', 'cuda', 'node'],
  publishTarget: null,
  sealedKeyId: 'v1',
  sealedKeyserverUrl: null,
  runtimeErrors: false,
  jevEnabled: false,
};

export function loadConfig(userConfigPath: string): CaveatConfig {
  const userCfg = existsSync(userConfigPath)
    ? (JSON.parse(readFileSync(userConfigPath, 'utf-8')) as Partial<CaveatConfig>)
    : {};
  return deepMerge(DEFAULT_CONFIG, userCfg) as CaveatConfig;
}

export function ensureUserConfig(userConfigPath: string): void {
  if (!existsSync(userConfigPath)) {
    writeFileSync(userConfigPath, '{}\n', 'utf-8');
  }
}

/** Write only user overrides, preserving unrelated keys in the sparse config file. */
export function writeUserConfigPatch(
  userConfigPath: string,
  patch: Partial<CaveatConfig>,
): void {
  const existing = existsSync(userConfigPath)
    ? (JSON.parse(readFileSync(userConfigPath, 'utf-8')) as Record<string, unknown>)
    : {};
  writeFileSync(userConfigPath, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, 'utf-8');
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === null || overlay === undefined) return base;
  if (Array.isArray(overlay)) return overlay;
  if (typeof overlay !== 'object') return overlay;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return overlay;

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay as Record<string, unknown>)) {
    result[k] = deepMerge(result[k], v);
  }
  return result;
}
