import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Notion } from '../src/notion.js';
import { WorkspaceSearch } from '../src/search.js';
import { PluginBridge, pluginDocument, pluginPayload } from '../src/plugin.js';
import { config } from '../src/security.js';

const pageId = '12345678-1234-4234-8234-123456789012';
const rawPage = (id = pageId) => ({ id, title: 'Launch decision', text: '<content>Serena owns the Orchid release.</content>' });
function fixture(t) {
  const cfg = config({ ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const store = new Store(':memory:', cfg.encryptionKey); t.after(() => store.close());
  const tenant = store.provision('Plugin customer');
  const identity = { workspace: { id: randomUUID() }, user: { id: randomUUID() } };
  const bridge = new PluginBridge(store);
  const connection = bridge.bind(tenant.tenant_id, identity);
  const key = store.authenticate(store.issueKey(tenant.tenant_id, connection.connection_id, 'read', 'Agent').key);
  const notion = new Notion(store, cfg, () => { throw new Error('Unexpected REST request.'); });
  notion.pluginBridge = bridge;
  const search = new WorkspaceSearch(store, notion, cfg); notion.searchEngine = search;
  bridge.heartbeat(key, identity);
  return { store, bridge, key, search };
}
async function answer(f, operation, reply) {
  const pending = operation();
  const requests = f.bridge.pending(f.key);
  assert.equal(requests.length, 1);
  f.bridge.complete(f.key, requests[0].id, reply);
  return pending;
}

test('plugin page identity cannot be replaced by another page with matching contents', async t => {
  const f = fixture(t), wrong = rawPage(randomUUID());
  f.search.save(f.key, pluginDocument(rawPage(), pageId));
  assert.throws(() => pluginDocument(wrong, pageId), { code: 'plugin_source_mismatch' });
  await assert.rejects(answer(f, () => f.search.context(f.key, { query: 'Orchid', max_chars: 3000 }), wrong), { code: 'plugin_source_mismatch' });
  assert.equal(f.search.document(f.key, wrong.id), undefined);
  await assert.rejects(answer(f, () => f.bridge.request(f.key, '/pages/' + pageId, 'GET'), wrong), { code: 'plugin_source_mismatch' });
});

test('plugin page identity accepts normalized UUIDs and rejects malformed returned IDs', () => {
  assert.equal(pluginDocument(rawPage(pageId.replaceAll('-', '').toUpperCase()), pageId).page_id, pageId);
  assert.throws(() => pluginDocument(rawPage('not-a-page'), pageId), { code: 'plugin_source_mismatch' });
  assert.throws(() => pluginDocument(null, pageId), { code: 'invalid_plugin_result' });
  assert.throws(() => pluginDocument([], pageId), { code: 'invalid_plugin_result' });
});

test('explicit plugin permission errors preserve status and purge inaccessible indexed text', async t => {
  const f = fixture(t);
  f.search.save(f.key, pluginDocument(rawPage(), pageId));
  const denied = { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'object_not_found', message: 'No access.' }) }] };
  assert.throws(() => pluginPayload(denied), { code: 'plugin_source_error', status: 404 });
  const result = await answer(f, () => f.search.search(f.key, { query: 'Orchid' }), denied);
  assert.equal(result.results.length, 0);
  assert.equal(f.search.document(f.key, pageId), undefined);
});

test('malformed and oversized relay replies cannot complete a pending request', async t => {
  const f = fixture(t), pending = f.bridge.call(f.key, 'fetch', { id: pageId });
  const request = f.bridge.pending(f.key)[0];
  for (const value of [null, [], 'text', 3]) assert.throws(() => f.bridge.complete(f.key, request.id, value), { code: 'invalid_plugin_result' });
  assert.throws(() => f.bridge.complete(f.key, request.id, { text: 'x'.repeat(2_000_001) }), { code: 'plugin_result_too_large' });
  f.bridge.complete(f.key, request.id, rawPage());
  assert.equal((await pending).id, pageId);
});

test('untrusted relay error status cannot turn a failed source read into HTTP success', async t => {
  const f = fixture(t);
  await assert.rejects(answer(f, () => f.bridge.call(f.key, 'fetch', { id: pageId }), { error: 'source_unavailable', status: 200 }), { status: 502 });
  await assert.rejects(answer(f, () => f.bridge.call(f.key, 'fetch', { id: pageId }), { error: 'constructor' }), { status: 502 });
});

test('relay request claims exclude duplicate and legacy pollers and require their token', async t => {
  const f = fixture(t), pending = f.bridge.call(f.key, 'fetch', { id: pageId });
  const first = f.bridge.pending(f.key, 'relay-first')[0];
  assert.ok(first.claim_token); assert.ok(first.claim_expires > Date.now());
  assert.equal(f.bridge.pending(f.key, 'relay-second').length, 0);
  assert.equal(f.bridge.pending(f.key).length, 0);
  assert.throws(() => f.bridge.complete(f.key, first.id, rawPage()), { code: 'plugin_request_not_found' });
  assert.throws(() => f.bridge.complete(f.key, first.id, rawPage(), randomUUID()), { code: 'plugin_request_not_found' });
  f.bridge.complete(f.key, first.id, rawPage(), first.claim_token);
  assert.equal((await pending).id, pageId);
});

test('expired relay claims can be reclaimed but stale replies cannot overwrite the new claim', async t => {
  const f = fixture(t), pending = f.bridge.call(f.key, 'fetch', { id: pageId });
  const first = f.bridge.pending(f.key, 'relay-first')[0];
  f.store.db.prepare('UPDATE plugin_requests SET claim_expires=0 WHERE id=?').run(first.id);
  assert.throws(() => f.bridge.complete(f.key, first.id, rawPage(), first.claim_token), { code: 'plugin_request_not_found' });
  const second = f.bridge.pending(f.key, 'relay-second')[0];
  assert.equal(second.id, first.id); assert.notEqual(second.claim_token, first.claim_token);
  assert.throws(() => f.bridge.complete(f.key, first.id, rawPage(), first.claim_token), { code: 'plugin_request_not_found' });
  f.bridge.complete(f.key, second.id, rawPage(), second.claim_token);
  assert.equal((await pending).id, pageId);
});

test('taking a relay offline fails both claimed and legacy requests promptly', async t => {
  const f = fixture(t);
  const first = f.bridge.call(f.key, 'fetch', { id: pageId });
  f.bridge.pending(f.key, 'relay-first');
  const second = f.bridge.call(f.key, 'fetch', { id: pageId });
  const rejected = Promise.all([
    assert.rejects(first, { code: 'plugin_relay_offline', status: 503 }),
    assert.rejects(second, { code: 'plugin_relay_offline', status: 503 })
  ]);
  f.bridge.offline(f.key);
  await rejected;
});

test('unified plugin search returns only verifiable Notion resources and counts external exclusions', async t => {
  const f = fixture(t), secondId = randomUUID(), sourceId = randomUUID();
  const mixed = { results: [
    { id: 'provider-opaque-id', url: 'https://www.notion.so/Launch-' + pageId.replaceAll('-', ''), title: 'Notion page', type: 'page' },
    { url: 'https://workspace.notion.site/' + secondId.replaceAll('-', ''), title: 'Notion database', type: 'database' },
    { url: 'collection://' + sourceId, title: 'Notion data source' },
    { id: randomUUID(), url: 'https://slack.com/archives/channel/message', title: 'EXTERNAL_SECRET', type: 'page' },
    { id: randomUUID(), url: 'https://mail.google.com/mail/u/0/inbox/message', title: 'EXTERNAL_SECRET' },
    { id: randomUUID(), url: 'https://notion.so.example.com/' + pageId, title: 'EXTERNAL_SECRET' },
    { id: randomUUID(), title: 'EXTERNAL_SECRET' },
    null
  ] };
  const result = await answer(f, () => f.search.search(f.key, { query: 'launch' }), mixed);
  assert.deepEqual(result.results.map(r => r.id), [pageId, secondId, sourceId]);
  assert.deepEqual(result.results.map(r => r.object), ['page', 'database', 'data_source']);
  assert.equal(result.excluded_external_sources, 5);
  assert.equal(result.coverage, 'live_plugin_search_index_pending');
  assert.ok(!JSON.stringify(result).includes('EXTERNAL_SECRET'));
});
