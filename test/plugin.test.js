import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Notion } from '../src/notion.js';
import { WorkspaceSearch } from '../src/search.js';
import { PluginBridge, pluginDocument } from '../src/plugin.js';
import { createToolRunner } from '../src/tools.js';
import { config } from '../src/security.js';
import { IndexWorker } from '../src/sync.js';

const pageId = '12345678-1234-4234-8234-123456789012';
const rawPage = text => ({ id: pageId, title: 'Release notes', text: '<page><properties>{"title":"Release notes"}</properties><content>\n## Launch decision\n' + text + '\n</content></page>', metadata: { type: 'page' }, page_last_edited_at: '2026-10-14T12:00:00Z' });
function fixture(t) {
  const cfg = config({ ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const store = new Store(':memory:', cfg.encryptionKey); t.after(() => store.close());
  const tenant = store.provision('Plugin customer'), identity = { workspace: { id: randomUUID(), name: 'Workspace' }, user: { id: randomUUID() } };
  const notion = new Notion(store, cfg, () => { throw new Error('Plugin mode must never call REST with an exported token.'); });
  const bridge = new PluginBridge(store); notion.pluginBridge = bridge;
  const connection = bridge.bind(tenant.tenant_id, identity);
  const access = store.issueKey(tenant.tenant_id, connection.connection_id, 'read', 'Plugin agent');
  const key = store.authenticate(access.key), search = new WorkspaceSearch(store, notion, cfg); notion.searchEngine = search;
  bridge.heartbeat(key, identity);
  return { store, bridge, identity, connection, key, search, notion };
}
async function replyWhile(f, operation, reply) {
  const timer = setInterval(() => {
    for (const request of f.bridge.pending(f.key)) f.bridge.complete(f.key, request.id, reply(request));
  }, 5);
  try { return await operation(); } finally { clearInterval(timer); }
}
test('plugin connection binds the authenticated workspace/user without copying plugin credentials', t => {
  const f = fixture(t);
  assert.equal(f.store.connection(f.key.tenant_id, f.key.connection_id).tokens, '');
  assert.equal(f.store.connection(f.key.tenant_id, f.key.connection_id).provider, 'plugin');
  assert.equal(f.bridge.bind(f.key.tenant_id, f.identity).connection_id, f.connection.connection_id);
  assert.throws(() => f.bridge.heartbeat(f.key, { workspace: { id: randomUUID() }, user: f.identity.user }), /does not match/);
  const tools = createToolRunner(f.store, f.notion, f.key).definitions;
  assert.ok(tools.some(t => t.name === 'notion_get_context')); assert.ok(tools.every(t => !t.write));
  assert.ok(!tools.some(t => t.name === 'notion_get_block'));
});
test('plugin evidence is fetched through the relay and cites real pages without invented block anchors', async t => {
  const f = fixture(t), raw = rawPage('Serena owns the Orchid release.');
  f.search.save(f.key, pluginDocument(raw, pageId));
  const result = await replyWhile(f, () => f.search.context(f.key, { query: 'Orchid', max_chars: 3000 }), request => { assert.equal(request.operation, 'fetch'); return raw; });
  assert.ok(result.passages[0].text.includes('Serena')); assert.ok(!result.passages[0].url.includes('#'));
  assert.equal(result.provider, 'plugin'); assert.ok(result.passages[0].source_checked_at);
});
test('plugin relay offline fails closed even if indexed text is available', async t => {
  const f = fixture(t); f.search.save(f.key, pluginDocument(rawPage('Cached confidential source'), pageId));
  f.store.db.prepare('UPDATE plugin_relays SET heartbeat=0').run();
  await assert.rejects(f.search.context(f.key, { query: 'confidential', max_chars: 3000 }), /must run the relay/);
  assert.equal(f.search.status(f.key).plugin_relay_online, false);
});
test('plugin adapter never silently turns a requested title filter into full-content search', async t => {
  const f = fixture(t), runner = createToolRunner(f.store, f.notion, f.key);
  await assert.rejects(runner.run('notion_search', { query: 'Release', mode: 'titles' }), /native plugin search/);
});
test('ending an agent relay pauses discovery without counting source failures or losing its checkpoint', async t => {
  const f = fixture(t), worker = new IndexWorker(f.search);
  f.search.enqueue(f.key); f.bridge.offline(f.key);
  for (let i = 0; i < 4; i++) {
    const job = f.store.db.prepare('SELECT * FROM search_jobs WHERE connection_id=?').get(f.key.connection_id);
    const detail = JSON.parse(job.detail); detail.due = 0;
    job.detail = JSON.stringify(detail);
    await worker.step({ id: f.key.connection_id, tenant_id: f.key.tenant_id }, job);
  }
  const row = f.store.db.prepare('SELECT state,detail FROM search_jobs WHERE connection_id=?').get(f.key.connection_id);
  assert.equal(row.state, 'queued'); assert.equal(JSON.parse(row.detail).failures, 0);
  assert.equal(JSON.parse(row.detail).search_done, false);
});
test('plugin search ignores XML attribute noise while retaining visible text and dates', async t => {
  const f = fixture(t), raw = rawPage('<details toggle="true"><summary>Orchid timeline</summary><mention-date start="2026-11-01"/>Final launch</details>');
  f.search.save(f.key, pluginDocument(raw, pageId));
  const noise = await replyWhile(f, () => f.search.search(f.key, { query: 'true' }), () => raw);
  assert.equal(noise.results.length, 0);
  const date = await replyWhile(f, () => f.search.search(f.key, { query: '2026-11-01', match: 'all' }), () => raw);
  assert.ok(date.results.length);
});
test('changed plugin content is refreshed and revoked plugin pages are omitted and purged', async t => {
  const f = fixture(t); f.search.save(f.key, pluginDocument(rawPage('Serena owns Orchid'), pageId));
  const changed = rawPage('Aisha owns Orchid now.');
  const old = await replyWhile(f, () => f.search.search(f.key, { query: 'Serena' }), () => changed);
  assert.equal(old.results.length, 0);
  const fresh = await replyWhile(f, () => f.search.search(f.key, { query: 'Aisha' }), () => changed);
  assert.ok(fresh.results.length);
  const revoked = await replyWhile(f, () => f.search.search(f.key, { query: 'Aisha' }), () => ({ error: 'source_unavailable', status: 404 }));
  assert.equal(revoked.results.length, 0); assert.equal(f.search.document(f.key, pageId), undefined);
});
test('relay replies and request completion are connection scoped', async t => {
  const f = fixture(t);
  const otherTenant = f.store.provision('Other');
  const other = f.bridge.bind(otherTenant.tenant_id, { workspace: { id: randomUUID() }, user: { id: randomUUID() } });
  const otherKey = { tenant_id: otherTenant.tenant_id, connection_id: other.connection_id };
  const read = f.bridge.call(f.key, 'fetch', { id: pageId });
  const request = f.bridge.pending(f.key)[0];
  assert.equal(f.bridge.pending(otherKey).length, 0);
  assert.throws(() => f.bridge.complete(otherKey, request.id, rawPage('Wrong tenant')), /no longer pending/);
  f.bridge.complete(f.key, request.id, rawPage('Correct tenant')); assert.equal((await read).title, 'Release notes');
});
