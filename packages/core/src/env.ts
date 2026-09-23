import semver from 'semver';
import type { Environment } from './types.js';

export const DEFAULT_SEMVER_KEYS = ['driver', 'cuda', 'node'];

export interface Fingerprint extends Environment {
  os: string;
  arch: string;
  node: string;
}

export function fingerprint(): Fingerprint {
  return {
    os: process.platform,
    arch: process.arch,
    node: process.versions.node ?? '',
  };
}

type TargetOs = 'windows' | 'macos' | 'linux';

function normalizeTargetOs(value: string): TargetOs | null {
  const lower = value.toLowerCase();
  if (lower === 'win32' || lower === 'windows') return 'windows';
  if (lower === 'darwin' || lower === 'macos') return 'macos';
  if (lower === 'linux') return 'linux';
  return null;
}

/** `environment.os`は記録時の観測値で、適用制約は`applies_to_os`だけで指定する。 */
export function environmentAppliesToTask(environment: Environment, taskText: string, hostPlatform: string): boolean {
  const requiredRaw = environment.applies_to_os;
  if (!requiredRaw) return true;
  const required = normalizeTargetOs(requiredRaw);
  if (!required) throw new Error(`invalid applies_to_os: ${requiredRaw}`);
  const targets = new Set<TargetOs>();
  if (/\b(?:windows|win32)\b/iu.test(taskText)) targets.add('windows');
  if (/\b(?:mac|macos|darwin)\b/iu.test(taskText)) targets.add('macos');
  if (/\b(?:linux|ubuntu|wsl)\b/iu.test(taskText)) targets.add('linux');
  if (targets.size === 0) {
    const host = normalizeTargetOs(hostPlatform);
    if (host) targets.add(host);
  }
  return targets.has(required);
}

export function envMatch(
  current: Environment,
  required: Environment,
  semverKeys: string[] = DEFAULT_SEMVER_KEYS,
): boolean {
  for (const [key, requiredValue] of Object.entries(required)) {
    const currentValue = current[key];
    if (currentValue === undefined) return false;
    if (semverKeys.includes(key)) {
      if (!matchSemver(currentValue, requiredValue)) return false;
    } else {
      if (!currentValue.toLowerCase().includes(requiredValue.toLowerCase())) return false;
    }
  }
  return true;
}

function matchSemver(current: string, required: string): boolean {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(required);
  if (!m) return false;
  const op = m[1] === '=' || !m[1] ? '' : m[1];
  const rhs = m[2]!;

  const head = /^\d+(\.\d+){0,2}/.exec(rhs);
  if (!head) return false;
  const rhsCoerced = semver.coerce(rhs)?.version;
  const headCoerced = semver.coerce(head[0])?.version;
  if (!rhsCoerced || rhsCoerced !== headCoerced) return false;

  const curCoerced = semver.coerce(current)?.version;
  if (!curCoerced) return false;
  const curHead = /^\d+(\.\d+){0,2}/.exec(current);
  if (!curHead || semver.coerce(curHead[0])?.version !== curCoerced) return false;

  return semver.satisfies(curCoerced, `${op}${rhsCoerced}`);
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}
