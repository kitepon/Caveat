import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../../src/registerTools.js';
import { buildMcpContext, type McpContextOverrides } from '../../src/context.js';
import { waitForMcpSyncs } from '../../src/tools/sync.js';

export async function syncClient(overrides: McpContextOverrides) {
  const ctx = buildMcpContext({...overrides,onEntryWritten:()=>{}});
  const server = new McpServer({name:'fixture',version:'1'});
  registerAllTools(server,ctx,'0.21.7');
  const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name:'fixture',version:'1'});
  await server.connect(serverTransport); await client.connect(clientTransport);
  return {client,ctx, async close(){await client.close();await waitForMcpSyncs();await server.close();ctx.db.close();}};
}
