import { describe, it, expect } from 'vitest';
import { envMatch, normalizePath, fingerprint, environmentAppliesToTask } from '../src/env.js';

describe('envMatch', () => {
  it('matches substring for non-semver keys', () => {
    expect(envMatch({ os: 'windows-11', gpu: 'RTX 5090' }, { os: 'windows' })).toBe(true);
    expect(envMatch({ os: 'linux' }, { os: 'windows' })).toBe(false);
  });

  it('matches semver ranges on whitelisted keys', () => {
    expect(envMatch({ cuda: '12.4' }, { cuda: '<12.5' }, ['cuda'])).toBe(true);
    expect(envMatch({ cuda: '12.6' }, { cuda: '<12.5' }, ['cuda'])).toBe(false);
    expect(envMatch({ cuda: '12.5' }, { cuda: '>=12.5' }, ['cuda'])).toBe(true);
    expect(envMatch({ cuda: '12.5' }, { cuda: '=12.5' }, ['cuda'])).toBe(true);
    expect(envMatch({ cuda: '12.5' }, { cuda: '12.5' }, ['cuda'])).toBe(true);
  });

  it('rejects semver.coerce hallucination for non-semver strings', () => {
    expect(envMatch({ gpu: 'RTX 5090' }, { gpu: 'windows-11' }, ['gpu'])).toBe(false);
  });

  it('rejects when key missing from current', () => {
    expect(envMatch({ os: 'windows-11' }, { gpu: 'RTX 5090' })).toBe(false);
  });

  it('returns true for empty required', () => {
    expect(envMatch({ os: 'windows-11' }, {})).toBe(true);
  });
});

describe('normalizePath', () => {
  it('lowercases and normalizes separators', () => {
    expect(normalizePath('C:\\Users\\Alice')).toBe('c:/users/alice');
  });
});

describe('fingerprint', () => {
  it('includes os, arch, node', () => {
    const fp = fingerprint();
    expect(typeof fp.os).toBe('string');
    expect(typeof fp.arch).toBe('string');
    expect(fp.node).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('明示された適用OS', () => {
  it('記録時のOSは制限に使わず、適用OSだけを照合する', () => {
    expect(environmentAppliesToTask({ os: 'Windows 11' }, 'Macで作業', 'darwin')).toBe(true);
    expect(environmentAppliesToTask({ os: 'Windows 11', applies_to_os: 'windows' }, 'Pythonの改行問題', 'darwin')).toBe(false);
    expect(environmentAppliesToTask({ applies_to_os: 'windows' }, 'Windows向けPythonの改行問題', 'darwin')).toBe(true);
    expect(environmentAppliesToTask({ applies_to_os: 'macos' }, 'Pythonの改行問題', 'darwin')).toBe(true);
  });
});
