import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPackedMarkdownClosed, documentTargets, npmPackReport } from './docs-contract.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('npm packの配列とpackage名付き出力を読み、別packageや不正な一覧を拒否する', () => {
  const report = { name: 'caveat-cli', files: [{ path: 'README.md' }] };
  assert.equal(npmPackReport([report], 'caveat-cli'), report);
  assert.equal(npmPackReport({ 'caveat-cli': report }, 'caveat-cli'), report);
  for (const invalid of [null, [], {}, [{ name: 'other', files: [] }], { 'caveat-cli': { name: 'caveat-cli' } }]) {
    assert.throws(() => npmPackReport(invalid, 'caveat-cli'), /files manifest/);
  }
});

test('extracts effective Markdown links, references, and HTML image candidates through ASTs', () => {
  const targets = documentTargets(`
[![badge](https://img.example/badge.svg)](docs/badges.md)
[API](docs/api_(v1).md)
[escaped \\] label](docs/escaped.md)

[guide]:
  docs/guide.md

[guide]

> [quoted]: docs/quoted.md
>
> [quoted]

- [listed]: docs/listed.md
  [listed]

<a href="docs/a&amp;b.md"><img src="images/direct.png" srcset="data:image/svg+xml,%3Csvg%3E 1x, images/two.png 2x">
<template><img src="images/template.png"></template>
`);

  assert.deepEqual(targets, [
    'docs/badges.md',
    'https://img.example/badge.svg',
    'docs/api_(v1).md',
    'docs/escaped.md',
    'docs/guide.md',
    'docs/quoted.md',
    'docs/listed.md',
    'docs/a&b.md',
    'images/direct.png',
    'data:image/svg+xml,%3Csvg%3E',
    'images/two.png',
    'images/template.png',
  ]);
});

test('ignores CommonMark code, escaped definitions, malformed links, and fake HTML attributes', () => {
  const targets = documentTargets(`
    [indented code](missing-indented.md)

\`\` \`[unequal backticks](missing-inline.md)\` \`\`

\\[escaped]: missing-escaped.md

[escaped]

[unterminated title](missing-title.md "title)

[blank line](

missing-blank.md)

<div title='href="missing-html.md"' data-example="src='missing-src.md'"></div>
`);

  assert.deepEqual(targets, []);
});

test('rejects a relative target missing from the packed manifest', () => {
  const files = new Set(['README.md', 'docs/guide.md', 'images/logo.png']);
  assert.doesNotThrow(() => assertPackedMarkdownClosed(
    files,
    'README.md',
    '[Guide](docs/guide.md) ![Logo](images/logo.png)',
  ));
  assert.throws(
    () => assertPackedMarkdownClosed(files, 'README.md', '[Missing](docs/missing.md)'),
    /同梱されないtargetを参照しています: docs\/missing\.md/,
  );
  assert.throws(
    () => assertPackedMarkdownClosed(files, 'README.md', '[Missing]:\n  docs/missing.md\n\n[Missing]'),
    /同梱されないtargetを参照しています: docs\/missing\.md/,
  );
  assert.doesNotThrow(() => assertPackedMarkdownClosed(
    files,
    'README.md',
    '[Package root](.) [Packed docs](docs/)',
  ));
});

test('rejects a packed Markdown target that escapes the package', () => {
  assert.throws(
    () => assertPackedMarkdownClosed(new Set(['README.md']), 'README.md', '[Secret](../secret.md)'),
    /package外を参照しています/,
  );
});

test('parses single-character and comma-bearing srcset URLs without dropping targets', () => {
  assert.deepEqual(
    documentTargets('<img srcset="a 1x, data:image/svg+xml,%3Csvg%3E 2x, images/a,b.png 3x">'),
    ['a', 'data:image/svg+xml,%3Csvg%3E', 'images/a,b.png'],
  );
  assert.throws(
    () => assertPackedMarkdownClosed(new Set(['README.md']), 'README.md', '<img srcset="a">'),
    /同梱されないtargetを参照しています: a/,
  );
});

test('public docs expose one product-owned non-interactive setup entry', async () => {
  for (const path of ['README.md', 'README.ja.md', 'apps/cli/README.md']) {
    const content = await readFile(join(ROOT, path), 'utf8');
    assert.match(content, /caveat init --sync --yes/u, `${path}に一回setup入口がない`);
    assert.match(content, /非0終了|non-zero/u, `${path}に明示sync失敗の契約がない`);
  }
});

test('current host docs separate Claude MCP actions from native CLI actions', async () => {
  for (const path of ['README.md', 'README.ja.md', 'apps/cli/README.md']) {
    const content = await readFile(join(ROOT, path), 'utf8');
    assert.match(content, /caveat show <id> --source <source>/u, `${path}にnative詳細取得入口がない`);
    assert.match(content, /caveat index/u, `${path}にnative index更新入口がない`);
  }

  const hostContract = await readFile(join(ROOT, 'docs/03_dual_agent_support.md'), 'utf8');
  const actionSection = hostContract.match(/^## Reminder Action Surfaces\s*$([\s\S]*?)(?=^## )/mu)?.[1];
  assert.ok(actionSection, 'host契約にReminder Action Surfaces節がない');
  assert.match(actionSection, /mcp__caveat__caveat_get/u);
  assert.match(actionSection, /mcp__caveat__caveat_update/u);
  assert.match(actionSection, /mcp__caveat__caveat_record/u);
  assert.match(actionSection, /caveat show <id> --source <source>/u);
  assert.match(actionSection, /caveat index/u);
  assert.match(actionSection, /community entryは購読物/u);
  const nativeGuidance = actionSection.match(/^- Codex \/ Cursor[^\n]*(?:\n {2}[^\n]*)*/mu)?.[0];
  assert.ok(nativeGuidance, 'host契約にCodex / Cursorのnative操作案内がない');
  assert.doesNotMatch(nativeGuidance, /mcp__caveat__/u);
});

test('product docs keep Cursor machine diagnostics behind the Caveat aggregate contract', async () => {
  const productContract = await readFile(join(ROOT, 'docs/01_plan.md'), 'utf8');
  assert.match(productContract, /caveat\.native_factory_diagnostics\.v1/u);
  assert.match(productContract, /caveat factory-diagnostics --json --require-connector cursor/u);
  assert.match(productContract, /connectors\.cursor\.compatibility_status/u);
  assert.match(productContract, /overall\.status/u);
  assert.match(productContract, /hook名、必要集合、command、timeoutを複製しない/u);

  for (const path of ['README.md', 'README.ja.md', 'apps/cli/README.md', 'docs/03_dual_agent_support.md']) {
    const content = await readFile(join(ROOT, path), 'utf8');
    assert.match(content, /caveat factory-diagnostics --json --require-connector cursor/u, `${path}にCursor集約診断入口がない`);
    assert.match(content, /connectors\.cursor\.compatibility_status/u, `${path}にCursor互換判定がない`);
    assert.match(content, /overall\.status/u, `${path}にtop-level判定契約がない`);
  }
});
