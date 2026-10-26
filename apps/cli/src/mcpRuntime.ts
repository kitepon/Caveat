// Keep MCP/SDK evaluation on the MCP command path. This module lives beside
// the runtime entry in source and in the packaged dist, including managed runs.
type McpRuntime = typeof import('./mcp-server.js');
export function loadMcpRuntime(): Promise<McpRuntime> {
  return import(new URL('./mcp-server.js', import.meta.url).href) as Promise<McpRuntime>;
}
