import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { setup } from './fixtures/workspace.js';
import { createApp } from '../src/app.js';

test('MCP agents can retrieve cited full-text evidence and navigate the indexed workspace', async t => {
  const f = await setup(t); await f.index();
  const app = createApp(f.store, f.notion, f.cfg); await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await app.closeMcp(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); });
  const access = f.store.issueKey(f.keyA.tenant_id, f.keyA.connection_id, 'read', 'MCP search test');
  const client = new Client({ name: 'search-evidence-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + app.server.address().port + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + access.key } } }));
  const response = await client.callTool({ name: 'notion_get_context', arguments: { query: 'Who handles satellite escalations?', max_chars: 2000 } });
  assert.ok(!response.isError); const evidence = JSON.parse(response.content[0].text);
  assert.ok(evidence.passages[0].text.includes('Marisol')); assert.ok(evidence.passages[0].url.includes('#'));
  assert.ok(JSON.stringify(evidence).length <= 2000);
  const map = await client.callTool({ name: 'notion_workspace_map', arguments: {} }); assert.ok(!map.isError);
  assert.equal(JSON.parse(map.content[0].text).nodes.length, 5);
  await client.close();
});
