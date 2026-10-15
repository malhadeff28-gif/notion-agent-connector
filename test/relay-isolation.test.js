import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Notion } from '../src/notion.js';
import { createApp } from '../src/app.js';
import { config } from '../src/security.js';

const pageId = '12345678-1234-4234-8234-123456789012';
const page = { id: pageId, title: 'Scoped source', text: '<content>Connection A source.</content>' };
async function fixture(t) {
  const cfg = config({ ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTO_INDEX: 'false' });
  const store = new Store(':memory:', cfg.encryptionKey);
  const notion = new Notion(store, cfg, () => { throw new Error('Fixture must not contact Notion REST.'); });
  const app = createApp(store, notion, cfg);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  cfg.appUrl = 'http://127.0.0.1:' + app.server.address().port;
  t.after(async () => {
    await app.closeMcp(); app.server.closeAllConnections();
    await new Promise(r => app.server.close(r)); store.close();
  });
  const request = async (path, key, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const response = await fetch(cfg.appUrl + path, {
      method, headers: { Authorization: 'Bearer ' + key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, data: await response.json() };
  };
  const a = store.provision('A'), b = store.provision('B');
  const connect = async admin => {
    const identity = { workspace: { id: randomUUID() }, user: { id: randomUUID() } };
    const result = await request('/v1/plugin/connect', admin.key, { identity });
    assert.equal(result.status, 201);
    return { ...result.data, identity };
  };
  const ca = await connect(a), ca2 = await connect(a), cb = await connect(b);
  const issued = await request('/v1/keys', a.key, { connection_id: ca.connection_id, role: 'relay', label: 'Agent-host relay' });
  assert.equal(issued.status, 201);
  const relay = issued.data;
  const reader = store.issueKey(a.tenant_id, ca.connection_id, 'read', 'Reader');
  return { store, notion, request, a, b, ca, ca2, cb, relay, reader, prefix: '/v1/plugin/' + ca.connection_id };
}

test('management issues plugin-only relay keys and agents cannot issue their own keys', async t => {
  const f = await fixture(t);
  assert.equal(f.relay.role, 'relay'); assert.equal(f.relay.connection_id, f.ca.connection_id);
  const oauth = f.store.saveConnection(f.a.tenant_id, { access_token: 'fixture-token', workspace_id: randomUUID() });
  const rejected = await f.request('/v1/keys', f.a.key, { connection_id: oauth.connection_id, role: 'relay', label: 'Invalid relay' });
  assert.equal(rejected.status, 400); assert.equal(rejected.data.error, 'not_plugin_connection');
  for (const key of [f.relay.key, f.reader.key]) {
    assert.equal((await f.request('/v1/keys', key, { connection_id: f.ca.connection_id, role: 'relay', label: 'Escalation' })).status, 401);
  }
  assert.equal((await f.request('/v1/keys', f.a.key, { connection_id: f.cb.connection_id, role: 'relay', label: 'Other tenant' })).status, 404);
});

test('scoped relay completes real HTTP source reads with claim tokens and can go offline', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.prefix + '/heartbeat', f.relay.key, { identity: f.ca.identity })).status, 200);
  const pending = f.request('/v1/tools/notion_get_page', f.reader.key, { page_id: pageId });
  let requests = [];
  for (let i = 0; i < 30 && !requests.length; i++) {
    requests = (await f.request(f.prefix + '/requests', f.relay.key, undefined, 'GET', { 'X-Notion-Relay-Id': 'relay-http-test' })).data.requests;
    if (!requests.length) await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 'fetch'); assert.equal(requests[0].args.id, pageId);
  assert.equal((await f.request(f.prefix + '/requests', f.relay.key)).data.requests.length, 0);
  assert.equal((await f.request(f.prefix + '/requests/' + requests[0].id, f.relay.key, page)).status, 404);
  const completion = await f.request(f.prefix + '/requests/' + requests[0].id, f.relay.key, page, 'POST', { 'X-Notion-Claim-Token': requests[0].claim_token });
  assert.equal(completion.status, 200);
  const result = await pending; assert.equal(result.status, 200); assert.equal(result.data.id, pageId);
  assert.equal((await f.request(f.prefix + '/offline', f.relay.key, {}, 'POST')).status, 200);
  const offline = await f.request('/v1/tools/notion_get_page', f.reader.key, { page_id: pageId });
  assert.equal(offline.status, 503); assert.equal(offline.data.error, 'plugin_relay_offline');
});

test('relay credentials are isolated from tool, management, same-tenant and cross-tenant routes', async t => {
  const f = await fixture(t);
  for (const path of ['/v1/tools', '/v1/status', '/v1/openapi.json', '/v1/keys', '/v1/connections', '/v1/audit', '/v1/index/' + f.ca.connection_id, '/mcp']) {
    assert.equal((await f.request(path, f.relay.key)).status, 401, path);
  }
  assert.equal((await f.request('/v1/tools/notion_get_page', f.relay.key, { page_id: pageId })).status, 401);
  assert.equal((await f.request('/v1/plugin/connect', f.relay.key, { identity: f.ca.identity })).status, 401);
  assert.equal((await f.request('/v1/connections/' + f.ca.connection_id, f.relay.key, undefined, 'DELETE')).status, 401);
  assert.equal((await f.request('/v1/keys/' + f.reader.key_id, f.relay.key, undefined, 'DELETE')).status, 401);
  for (const other of [f.ca2, f.cb]) {
    const prefix = '/v1/plugin/' + other.connection_id;
    for (const [suffix, body] of [['/heartbeat', { identity: other.identity }], ['/requests', undefined], ['/requests/' + randomUUID(), page], ['/offline', {}]]) {
      assert.equal((await f.request(prefix + suffix, f.relay.key, body)).status, 401, prefix + suffix);
    }
  }
  assert.equal((await f.request(f.prefix + '/heartbeat', f.relay.key, { identity: f.ca2.identity })).status, 403);
  assert.equal((await f.request(f.prefix + '/requests', f.reader.key)).status, 401);
  // Tenant management keys retain their supported relay compatibility.
  assert.equal((await f.request(f.prefix + '/requests', f.a.key)).status, 200);
  assert.equal((await f.request(f.prefix + '/requests', f.b.key)).status, 404);
});

test('revocation and disconnect stop relay keys immediately without affecting another connection', async t => {
  const f = await fixture(t);
  const second = (await f.request('/v1/keys', f.a.key, { connection_id: f.ca2.connection_id, role: 'relay', label: 'Second relay' })).data;
  assert.equal((await f.request('/v1/keys/' + f.relay.key_id, f.a.key, undefined, 'DELETE')).status, 200);
  for (const [suffix, body] of [['/heartbeat', { identity: f.ca.identity }], ['/requests', undefined], ['/requests/' + randomUUID(), page], ['/offline', {}]]) {
    assert.equal((await f.request(f.prefix + suffix, f.relay.key, body)).status, 401);
  }
  const secondPrefix = '/v1/plugin/' + f.ca2.connection_id;
  assert.equal((await f.request(secondPrefix + '/heartbeat', second.key, { identity: f.ca2.identity })).status, 200);
  assert.equal((await f.request('/v1/connections/' + f.ca2.connection_id, f.a.key, undefined, 'DELETE')).status, 200);
  assert.equal((await f.request(secondPrefix + '/requests', second.key)).status, 401);
});
