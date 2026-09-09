import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandInvocation } from './process-command.mjs';

test('Windowsのcmd入口と特殊文字をPowerShell 7のリテラルへ渡す', () => {
  const result = commandInvocation('C:\\Program Files\\npm.cmd', ['pack', "a'b $(echo secret) ` &"], 'win32');
  assert.equal(result.command, 'pwsh.exe');
  assert.deepEqual(result.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const source = Buffer.from(result.args[3], 'base64').toString('utf16le');
  assert.match(source, /& 'C:\\Program Files\\npm.cmd' 'pack' 'a''b \$\(echo secret\) ` &'/);
  assert.match(source, /exit \$LASTEXITCODE$/);
});

test('POSIXの公式commandとWindowsの実行ファイルは直接起動する', () => {
  assert.deepEqual(commandInvocation('npm', ['pack'], 'linux'), { command: 'npm', args: ['pack'] });
  assert.deepEqual(commandInvocation('node.exe', ['script.mjs'], 'win32'), { command: 'node.exe', args: ['script.mjs'] });
});
