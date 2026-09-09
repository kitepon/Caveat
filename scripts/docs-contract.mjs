import { posix } from 'node:path';
import { parseFragment } from 'parse5';
import parseSrcset from 'parse-srcset';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdownParser = unified().use(remarkParse).use(remarkGfm);

/** npmの配列形式とpackage名をキーにした形式を同じ配布一覧へ解決する。 */
export function npmPackReport(reports, packageName) {
  const report = Array.isArray(reports)
    ? reports.find((entry) => entry?.name === packageName)
    : reports?.[packageName];
  if (!report || report.name !== packageName || !Array.isArray(report.files)) {
    throw new Error('npm pack dry-runに対象packageのfiles manifestがありません');
  }
  return report;
}

export function documentTargets(source) {
  const tree = markdownParser.parse(source);
  const definitions = new Map();
  walkMarkdown(tree, (node) => {
    if (node.type === 'definition' && typeof node.identifier === 'string'
      && typeof node.url === 'string' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });

  const targets = [];
  walkMarkdown(tree, (node) => {
    if ((node.type === 'link' || node.type === 'image') && typeof node.url === 'string') {
      targets.push(node.url);
    } else if ((node.type === 'linkReference' || node.type === 'imageReference')
      && typeof node.identifier === 'string') {
      const target = definitions.get(node.identifier);
      if (target !== undefined) targets.push(target);
    } else if (node.type === 'html' && typeof node.value === 'string') {
      targets.push(...htmlTargets(node.value));
    }
  });
  return targets;
}

export function assertPackedMarkdownClosed(files, markdownPath, source) {
  const packedFiles = [...files];
  for (const raw of documentTargets(source)) {
    const target = packedTarget(markdownPath, raw);
    if (target === null || target === '.') continue;
    if (!files.has(target) && !packedFiles.some((file) => file.startsWith(`${target}/`))) {
      throw new Error(`同梱されないtargetを参照しています: ${raw}`);
    }
  }
}

function htmlTargets(source) {
  const targets = [];
  walkHtml(parseFragment(source), (node) => {
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === 'href' || attribute.name === 'src') {
        targets.push(attribute.value);
      } else if (attribute.name === 'srcset') {
        const candidates = parseSrcset(attribute.value);
        targets.push(...candidates.map((candidate) => candidate.url));
      }
    }
  });
  return targets;
}

function packedTarget(markdownPath, raw) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(raw)) return null;
  const pathname = raw.split('#', 1)[0].split('?', 1)[0];
  if (!pathname) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new Error(`不正なlink URIがあります: ${raw}`); }
  const normalized = posix.normalize(decoded.startsWith('/')
    ? decoded.slice(1)
    : posix.join(posix.dirname(markdownPath), decoded));
  const target = normalized === '.' ? normalized : normalized.replace(/\/+$/, '');
  if (target === '..' || target.startsWith('../')) {
    throw new Error(`package外を参照しています: ${raw}`);
  }
  return target;
}

function walkMarkdown(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walkMarkdown(child, visit);
}

function walkHtml(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walkHtml(child, visit);
  if (node.content) walkHtml(node.content, visit);
}
