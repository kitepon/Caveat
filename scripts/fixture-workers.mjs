// The foreground Stop hook intentionally leaves autosync/reindex workers.
// A fixture owns their paths until they exit; deleting it earlier lets a late
// SQLite open recreate directories during recursive removal.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForFixtureWorkers(root, timeoutMs = 30000) {
  const roots = [...new Set([root, realpathSync(root)])];
  const deadline = Date.now() + timeoutMs, seen = new Set();
  let empty = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error(`fixture_workers_timeout:pids=${[...seen].join(',')}`);
    let result, rows;
    if (process.platform === 'win32') {
      const script = String.raw`$ErrorActionPreference='Stop';$roots=ConvertFrom-Json $env:CAVEAT_FIXTURE_ROOTS;$ids=@(Get-CimInstance Win32_Process | Where-Object {$c=$_.CommandLine;$c -and $c -match '\bhook["'']?\s+["'']?(autosync|reindex)\b' -and @($roots | Where-Object {$c.IndexOf($_,[StringComparison]::OrdinalIgnoreCase) -ge 0}).Count -gt 0} | ForEach-Object {$_.ProcessId});ConvertTo-Json -InputObject $ids -Compress`;
      result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CAVEAT_FIXTURE_ROOTS: JSON.stringify(roots) }, encoding: 'utf8', timeout: Math.min(5000, remaining), windowsHide: true });
      if (result.status === 0) rows = JSON.parse(result.stdout);
    } else {
      result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: Math.min(5000, remaining), maxBuffer: 8 * 1024 * 1024 });
      if (result.status === 0) rows = result.stdout.split('\n').filter(line => roots.some(path => line.includes(path)) && /\bhook\s+(?:autosync|reindex)\b/.test(line)).map(line => Number(line.trim().split(/\s+/, 1)[0]));
    }
    if (result.status !== 0) throw Error(`fixture_worker_query_failed:${result.error?.code ?? result.status}`);
    for (const pid of rows) seen.add(pid);
    if (!rows.length) { if (++empty === 2) return { status: 'drained', observedWorkers: seen.size, cleanupLimitMs: timeoutMs }; }
    else empty = 0;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
}
