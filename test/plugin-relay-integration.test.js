import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Store } from '../src/store.js';
import { Notion } from '../src/notion.js';
import { createApp } from '../src/app.js';
import { config } from '../src/security.js';
import { pluginDocument } from '../src/plugin.js';
import { runPluginRelay } from '../src/plugin-relay.js';

test('actual relay library serves concurrent HTTP and MCP clients through scoped claimed requests', { timeout: 8000 }, async t => {
  const cfg = config({ ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTO_INDEX: 'false' });
  const store = new Store(':memory:', cfg.encryptionKey);
  const notion = new Notion(store, cfg, () => { throw new Error('Plugin connections must never call Notion REST.'); });
  const app = createApp(store, notion, cfg), controller = new AbortController();
  const client = new Client({ name: 'fixture-application', version: '1.0.0' });
  let relay;
  t.after(async () => {
    controller.abort(); if (relay) await relay.catch(() => {});
    await client.close(); await app.closeMcp(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve)); store.close();
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  cfg.appUrl = `http://127.0.0.1:${app.server.address().port}`;
  const tenant = store.provision('Relay integration fixture');
  const identity = { workspace: { id: randomUUID(), name: 'Fixture workspace' }, user: { id: randomUUID() } };
  const connection = notion.pluginBridge.bind(tenant.tenant_id, identity);
  const reader = store.issueKey(tenant.tenant_id, connection.connection_id, 'read', 'Application');
  const relayKey = store.issueKey(tenant.tenant_id, connection.connection_id, 'relay', 'Notion host');
  const pageId = randomUUID(), source = { id: pageId, title: 'Orchid launch', text: '<content>Serena owns the Orchid launch approval.</content>' };
  const key = store.authenticate(reader.key);
  notion.searchEngine.save(key, pluginDocument(source, pageId));
  const wrap = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: false });
  let sourceReads = 0, online;
  const started = new Promise(resolve => { online = resolve; });
  relay = runPluginRelay({
    baseUrl: cfg.appUrl, relayKey: relayKey.key, connectionId: connection.connection_id,
    signal: controller.signal, pollMs: 10, heartbeatMs: 50,
    onEvent: event => { if (event.type === 'online') online(); },
    callNotion: async (name, args) => {
      if (name === 'get_self') return wrap(identity);
      if (name === 'get_tool_access') return wrap({ current_tool_access: { ai_search: { status: 'plan_required' }, search: { status: 'available' } } });
      assert.equal(name, 'fetch'); assert.equal(args.id, pageId); sourceReads++;
      await delay(25); return wrap(source);
    },
  });
  await Promise.race([started, relay]);
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.appUrl + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${reader.key}` } } }));
  const [mcp, http] = await Promise.all([
    client.callTool({ name: 'notion_get_context', arguments: { query: 'Orchid launch', max_chars: 6000, max_pages: 2 } }),
    fetch(cfg.appUrl + '/v1/tools/notion_get_page', { method: 'POST', headers: { Authorization: `Bearer ${reader.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ page_id: pageId }) }),
  ]);
  assert.ok(!mcp.isError); assert.equal(http.status, 200); assert.equal((await http.json()).id, pageId);
  const evidence = JSON.parse(mcp.content[0].text);
  assert.ok(evidence.passages.some(p => p.text.includes('Serena')));
  assert.ok(evidence.passages.every(p => p.source_checked_at && p.url.includes(pageId.replaceAll('-', '')) && !p.url.includes('#')));
  assert.ok(sourceReads >= 2);
  controller.abort(); const stats = await relay; assert.ok(stats.completed >= 2);
  const offline = await fetch(cfg.appUrl + '/v1/tools/notion_get_page', { method: 'POST', headers: { Authorization: `Bearer ${reader.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ page_id: pageId }) });
  assert.equal(offline.status, 503); assert.equal((await offline.json()).error, 'plugin_relay_offline');
});
