import { observeRuntimeError } from '@caveat/core';
import { loadMcpRuntime } from '../mcpRuntime.js';
import { CAVEAT_VERSION } from '../version.js';

export async function runMcpServer(): Promise<void> {
  try { const { startMcpStdioServer } = await loadMcpRuntime(); await startMcpStdioServer({ productVersion: CAVEAT_VERSION }); } catch (error) { observeRuntimeError('CAVEAT.MCP_SERVER_FAILED', { version: CAVEAT_VERSION, impact: 'feature_unavailable' }); throw error; }
}
