import { statSync } from 'node:fs';
import { communityList } from '@caveat/core';
import { Hono } from 'hono';
import type { WebContext } from '../context.js';
import { escapeHtml, layout } from '../layout.js';

export function createCommunityRoute(ctx: WebContext): Hono {
  const app = new Hono();

  app.get('/community', (c) => {
    const handles = communityList({ communityDir: ctx.paths.communityDir, db: ctx.db });

    const list = handles
      .map((h) => {
        let mtime = '';
        try {
          mtime = statSync(h.path).mtime.toISOString().slice(0, 10);
        } catch {
          mtime = '';
        }
        return `
      <li>
        <a class="title" href="/?source=community/${encodeURIComponent(h.handle)}">${escapeHtml(h.handle)}</a>
        <div class="meta">
          <span class="badge">${h.entryCount} entries</span>
          ${mtime ? `<span>clone mtime: ${escapeHtml(mtime)}</span>` : ''}
        </div>
      </li>`;
      })
      .join('');

    const body = `
<h2 style="margin-top:0">community repos</h2>
${
  handles.length > 0
    ? `<ul class="entries">${list}</ul>`
    : `<div class="empty">no community repos imported yet. Use <code>caveat community add &lt;github-url&gt;</code>.</div>`
}
<p style="font-size:0.85rem;color:#666">To update: run <code>caveat community pull</code> in a terminal, then <code>caveat index</code>.</p>`;

    return c.html(layout('community · Caveat', body));
  });

  return app;
}
