const CSS = `
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  max-width: 860px;
  margin: 0 auto;
  padding: 1rem;
  line-height: 1.6;
  color: #222;
}
header {
  border-bottom: 1px solid #e0e0e0;
  padding-bottom: 0.6rem;
  margin-bottom: 1rem;
  display: flex;
  gap: 1rem;
  align-items: baseline;
}
header h1 { font-size: 1.2rem; margin: 0; }
header h1 a { color: inherit; text-decoration: none; }
header nav a { margin-right: 0.8rem; color: #555; text-decoration: none; }
header nav a:hover { text-decoration: underline; }
form.search { margin: 1rem 0; display: flex; gap: 0.4rem; flex-wrap: wrap; }
form.search input[type=text], form.search select {
  padding: 0.3rem 0.5rem;
  font-size: 0.95rem;
  border: 1px solid #bbb;
  border-radius: 4px;
}
form.search input[type=text] { flex: 1; min-width: 200px; }
form.search button {
  padding: 0.3rem 0.8rem;
  background: #0a5fff;
  color: white;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
ul.entries { list-style: none; padding: 0; }
ul.entries li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
ul.entries a.title { font-weight: 600; color: #0a5fff; text-decoration: none; }
ul.entries a.title:hover { text-decoration: underline; }
ul.entries .meta { font-size: 0.85rem; color: #666; margin-top: 0.2rem; }
.badge {
  display: inline-block;
  padding: 0 0.4rem;
  margin-right: 0.3rem;
  border-radius: 3px;
  background: #f0f0f0;
  font-size: 0.8rem;
}
.badge.confirmed { background: #d7f4dc; color: #16703a; }
.badge.reproduced { background: #e6eeff; color: #234ea3; }
.badge.tentative { background: #fff4d1; color: #8a5a00; }
.badge.impossible { background: #ffd9d9; color: #8a1a1a; }
.badge.public { background: #eef2f5; color: #5a6470; }
.badge.private { background: #fde7e7; color: #a02525; font-weight: 600; }
ul.entries .excerpt { margin-top: 0.3rem; color: #444; font-size: 0.92rem; }
article h2 { border-bottom: 1px solid #eee; padding-bottom: 0.2rem; margin-top: 1.6rem; }
article pre {
  background: #f6f8fa;
  padding: 0.8rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.85rem;
}
article code {
  background: #f6f8fa;
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  font-size: 0.9em;
}
article pre code { background: transparent; padding: 0; }
article a.wikilink { color: #0a5fff; background: #e6f0ff; padding: 0 0.25rem; border-radius: 2px; }
.jev-metrics { display: flex; gap: 0.7rem; flex-wrap: wrap; margin: 1rem 0; }
.jev-metrics div { flex: 1; min-width: 150px; padding: 0.7rem; background: #f4f7fb; border-radius: 4px; }
.jev-metrics strong { display: block; font-size: 1.4rem; }
.jev-metrics small { display: block; color: #666; }
.jev-cases { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.jev-scroll { overflow-x: auto; }
.jev-cases th, .jev-cases td { padding: 0.5rem; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.jev-cases code { font-size: 0.75rem; }
.jev-cases pre { max-width: 700px; max-height: 420px; overflow: auto; }
.meta-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.3rem 1rem;
  font-size: 0.9rem;
  color: #555;
  background: #fafafa;
  padding: 0.8rem;
  border-radius: 4px;
  margin: 0.5rem 0 1rem;
}
.meta-grid dt { font-weight: 600; color: #333; }
.meta-grid dd { margin: 0; }
footer {
  margin-top: 3rem;
  border-top: 1px solid #eee;
  padding-top: 0.6rem;
  font-size: 0.82rem;
  color: #888;
}
.empty { color: #888; text-align: center; padding: 2rem 0; }
`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${CSS}</style>
</head>
<body>
<header>
  <h1><a href="/">Caveat</a></h1>
  <nav>
    <a href="/">all</a>
    <a href="/?source=own">own</a>
    <a href="/?source=community">community</a>
    <a href="/community">community repos</a>
    <a href="/jev">Jev検証</a>
  </nav>
</header>
${body}
<footer>read-only share portal — edit via Obsidian or direct md</footer>
</body>
</html>`;
}
