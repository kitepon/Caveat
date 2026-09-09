import { spawnSync } from 'node:child_process';

/** Windowsのpackage-manager shimはPowerShell 7から起動する。 */
export function commandInvocation(command, args, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) return { command, args };
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const source = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & ${[command, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
  return { command: 'pwsh.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')] };
}

export function spawnCommandSync(command, args, options = {}) {
  const invocation = commandInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, { ...options, shell: false, windowsHide: true });
}
