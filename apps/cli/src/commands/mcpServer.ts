import { observeRuntimeError } from '@caveat/core';
import { startMcpStdioServer } from '@caveat/mcp';
import { CAVEAT_VERSION } from '../version.js';

export async function runMcpServer(): Promise<void> {
  try { await startMcpStdioServer({ productVersion: CAVEAT_VERSION }); } catch (error) { observeRuntimeError('CAVEAT.MCP_SERVER_FAILED', { version: CAVEAT_VERSION, impact: 'feature_unavailable' }); throw error; }
}
