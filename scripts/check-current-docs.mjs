#!/usr/bin/env node
import { spawnCommandSync } from './process-command.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPackedMarkdownClosed, documentTargets, npmPackReport } from './docs-contract.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const overviewPath = resolve(repo, 'docs/00_overview.md');
const overview = readFileSync(overviewPath, 'utf8');
const currentSection = overview.match(/^## 現行\s*$([\s\S]*?)(?=^## )/m)?.[1];
if (!currentSection) fail('docs/00_overview.mdに現行sectionがありません');

const indexed = new Set(localMarkdownTargets(currentSection, overviewPath));
const directCurrentDocs = readdirSync(resolve(repo, 'docs'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && extname(entry.name) === '.md' && entry.name !== '00_overview.md')
  .map((entry) => resolve(repo, 'docs', entry.name));
for (const file of directCurrentDocs) {
  if (!indexed.has(file)) fail(`${relative(repo, file)}がdocs/00_overview.mdの現行索引にありません`);
}

for (const file of new Set([overviewPath, ...indexed])) {
  if (!existsSync(file) || !statSync(file).isFile()) fail(`現行索引の参照先がありません: ${relative(repo, file)}`);
  const source = readFileSync(file, 'utf8');
  if (/\b(?:TODO|TBD|FIXME|placeholder|stub)\b/i.test(source)) {
    fail(`現行文書に未解決stub markerがあります: ${relative(repo, file)}`);
  }
  if (/\/(?:Users|home)\/[^/\s]+\//.test(source)) {
    fail(`現行文書に個人host固定pathがあります: ${relative(repo, file)}`);
  }
}

const markdownFiles = walkMarkdown(repo);
for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8');
  let targets;
  try { targets = localMarkdownTargets(source, file); }
  catch (error) { fail(`${relative(repo, file)}の文書構文を解析できません: ${error.message}`); }
  for (const target of targets) {
    if (!existsSync(target)) fail(`${relative(repo, file)}のlocal linkが切れています: ${relative(repo, target)}`);
  }
}

const packed = checkPackedMarkdown();
process.stdout.write(`current docs check: ok (${indexed.size} indexed, ${markdownFiles.length} linked files, ${packed.markdown} packed Markdown in ${packed.files} files)\n`);

function localMarkdownTargets(source, sourcePath) {
  const targets = [];
  for (const raw of documentTargets(source)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(raw)) continue;
    const pathname = raw.split('#', 1)[0].split('?', 1)[0];
    if (!pathname) continue;
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { fail(`${relative(repo, sourcePath)}に不正なlink URIがあります: ${raw}`); }
    targets.push(decoded.startsWith('/') ? resolve(repo, `.${decoded}`) : resolve(dirname(sourcePath), decoded));
  }
  return targets;
}

function checkPackedMarkdown() {
  const packageDir = resolve(repo, 'apps/cli');
  const result = spawnCommandSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  if (result.error) fail(`npm pack dry-runを起動できません: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`npm pack dry-runが失敗しました: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  let reports;
  try { reports = JSON.parse(result.stdout); }
  catch { fail('npm pack dry-runのJSONを解析できません'); }
  const packageName = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')).name;
  let report;
  try { report = npmPackReport(reports, packageName); }
  catch (error) { fail(error.message); }
  const files = new Set(report.files.map((entry) => entry?.path).filter((path) => typeof path === 'string'));
  const markdown = [...files].filter((path) => extname(path).toLowerCase() === '.md');
  if (markdown.length === 0) fail('公開packageにMarkdownがありません');

  for (const markdownPath of markdown) {
    const sourcePath = resolve(packageDir, markdownPath);
    if (!existsSync(sourcePath)) fail(`pack manifestのMarkdown sourceがありません: ${markdownPath}`);
    try { assertPackedMarkdownClosed(files, markdownPath, readFileSync(sourcePath, 'utf8')); }
    catch (error) { fail(`公開packageの${markdownPath}から${error.message}`); }
  }
  return { files: files.size, markdown: markdown.length };
}

function walkMarkdown(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'rag') continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && extname(entry.name) === '.md') files.push(path);
    }
  }
  return files;
}

function fail(message) {
  process.stderr.write(`current docs check: ${message}\n`);
  process.exit(1);
}
