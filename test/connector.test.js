import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as rawRequest } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Store } from '../src/store.js';
import { Notion } from '../src/notion.js';
import { createApp } from '../src/app.js';
import { config, seal, unseal } from '../src/security.js';

const pageA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pageB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(t) {
  const cfg = config({ ENCRYPTION_KEY: randomBytes(32).toString('base64'), NOTION_CLIENT_ID: 'test-client', NOTION_CLIENT_SECRET: 'test-secret' });
  cfg.notionBase = 'https://notion.test/v1';
  cfg.autoIndex = false; cfg.notionMinIntervalMs = 0;
  const store = new Store(':memory:', cfg.encryptionKey);
  const calls = [], stats = { writes: 0, refreshes: 0, expired: false, timeoutWrite: false, throttled: false, revokeFailed: false };
  const respond = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname.slice(3), body = options.body && JSON.parse(options.body), auth = options.headers.Authorization;
    calls.push({ path, query: new URL(url).search, body, auth, version: options.headers['Notion-Version'] });
    if (path === '/oauth/token') {
      if (body.grant_type === 'refresh_token') { stats.refreshes++; await new Promise(r => setTimeout(r, 5)); return respond({ access_token: 'access-A-fresh', refresh_token: 'refresh-A-fresh' }); }
      const code = body.code;
      return respond({ access_token: 'access-' + code, refresh_token: 'refresh-' + code, bot_id: 'bot-' + code, workspace_id: 'workspace-' + code, workspace_name: 'Customer ' + code });
    }
    if (path === '/oauth/revoke') return stats.revokeFailed ? respond({}, 503) : respond({ request_id: 'revoked' });
    if (stats.expired && auth === 'Bearer access-A') return respond({ error: 'unauthorized' }, 401);
    if (stats.throttled && path === '/search') { stats.throttled = false; return respond({}, 429, { 'Retry-After': '0' }); }
    if (path === '/search') return respond({ results: [{ id: auth.includes('access-A') ? pageA : pageB }], has_more: true, next_cursor: 'next-page' });
    if (path === '/pages/' + pageB && auth.includes('access-A')) return respond({}, 404);
    if (path === '/pages/' + pageA && auth.includes('access-B')) return respond({}, 404);
    if (options.method === 'PATCH' || (options.method === 'POST' && path === '/pages')) {
      stats.writes++;
      if (stats.timeoutWrite) throw new Error('simulated timeout after upstream mutation');
      return respond({ id: pageA, object: 'page', properties: body.properties || {}, url: 'https://notion.test/' + pageA });
    }
    if (path.includes('/children')) return respond({ results: [{ id: pageA, has_children: true }], next_cursor: 'block-next', has_more: true });
    if (path.endsWith('/query')) return respond({ results: [{ id: pageA }], has_more: false, next_cursor: null });
    return respond({ id: path.split('/').at(-1), object: 'page', properties: {} });
  };
  const notion = new Notion(store, cfg, fetcher), app = createApp(store, notion, cfg);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  cfg.appUrl = 'http://127.0.0.1:' + app.server.address().port;
  cfg.allowedOrigins = [cfg.appUrl]; cfg.redirectUri = cfg.appUrl + '/oauth/notion/callback';
  t.after(async () => { await app.closeMcp(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); store.close(); });
  const request = (path, token, body, method = body ? 'POST' : 'GET', extra = {}) => fetch(cfg.appUrl + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const a = store.provision('A'), b = store.provision('B');
  async function connect(admin, code) {
    const start = await request('/v1/notion/connect', admin.key, {}, 'POST');
    assert.equal(start.status, 200);
    const browser = await fetch((await start.json()).connect_url, { redirect: 'manual' });
    const authUrl = new URL(browser.headers.get('location'));
    const callback = await request('/oauth/notion/callback?state=' + authUrl.searchParams.get('state') + '&code=' + code, null, null, 'GET', { Cookie: browser.headers.get('set-cookie').split(';')[0] });
    assert.equal(callback.status, 200);
    return callback.json();
  }
  const ca = await connect(a, 'A'), cb = await connect(b, 'B');
  const ra = store.issueKey(a.tenant_id, ca.connection_id, 'read', 'reader');
  const wa = store.issueKey(a.tenant_id, ca.connection_id, 'write', 'writer');
  const rb = store.issueKey(b.tenant_id, cb.connection_id, 'read', 'reader');
  return { store, cfg, calls, stats, request, a, b, ca, cb, ra, wa, rb, notion };
}

test('credentials encrypted at rest and bound to their connection', async t => {
  const f = await fixture(t), row = f.store.connection(f.a.tenant_id, f.ca.connection_id);
  assert.ok(!row.tokens.includes('access-A'));
  assert.equal(f.store.tokens(row).access_token, 'access-A');
  assert.throws(() => unseal(row.tokens, f.cfg.encryptionKey, f.b.tenant_id + ':' + row.id));
  const encrypted = seal({ token: 'fixture' }, f.cfg.encryptionKey, 'x');
  assert.throws(() => unseal(encrypted.slice(0, -8) + 'AAAAAAAA', f.cfg.encryptionKey, 'x'));
});
test('customer connections, encrypted credentials, and key permissions survive a restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'notion-connector-test-'));
  let second;
  t.after(() => { second?.close(); rmSync(directory, { recursive: true, force: true }); });
  const dbPath = join(directory, 'connector.sqlite'), encryptionKey = randomBytes(32);
  const first = new Store(dbPath, encryptionKey);
  const tenant = first.provision('Persistence customer');
  const connection = first.saveConnection(tenant.tenant_id, { access_token: 'persistent-fixture-secret', refresh_token: 'refresh-fixture', workspace_id: 'workspace-fixture' });
  const agent = first.issueKey(tenant.tenant_id, connection.connection_id, 'read', 'Persistent reader');
  first.close();
  assert.ok(!readFileSync(dbPath).includes(Buffer.from('persistent-fixture-secret')));
  second = new Store(dbPath, encryptionKey);
  assert.equal(second.authenticate(agent.key).role, 'read');
  assert.equal(second.tokens(second.connection(tenant.tenant_id, connection.connection_id)).access_token, 'persistent-fixture-secret');
});
test('OAuth state requires the initiating browser and rejects replay/expiry', async t => {
  const f = await fixture(t);
  const start = await f.request('/v1/notion/connect', f.a.key, {});
  const connectUrl = (await start.json()).connect_url;
  const browser = await fetch(connectUrl, { redirect: 'manual' });
  assert.equal((await fetch(connectUrl, { redirect: 'manual' })).status, 400);
  const state = new URL(browser.headers.get('location')).searchParams.get('state');
  const path = '/oauth/notion/callback?state=' + state + '&code=A';
  assert.equal((await f.request(path)).status, 400);
  const headers = { Cookie: browser.headers.get('set-cookie').split(';')[0] };
  assert.equal((await f.request(path, null, null, 'GET', headers)).status, 200);
  assert.equal((await f.request(path, null, null, 'GET', headers)).status, 400);
  const expired = f.store.createState(f.a.tenant_id);
  f.store.db.prepare('UPDATE oauth_states SET expires=0').run();
  assert.throws(() => f.store.consumeState(expired.state, expired.browser), /expired/);
});
test('management and data access enforce customer isolation', async t => {
  const f = await fixture(t);
  const list = await (await f.request('/v1/connections', f.a.key)).json();
  assert.equal(list.connections.length, 1); assert.equal(list.connections[0].workspace_id, 'workspace-A');
  assert.equal((await f.request('/v1/keys', f.a.key, { connection_id: f.cb.connection_id, role: 'read', label: 'intruder' })).status, 404);
  assert.equal((await f.request('/v1/connections/' + f.cb.connection_id, f.a.key, null, 'DELETE')).status, 404);
  assert.equal((await f.request('/v1/tools/notion_get_page', f.ra.key, { page_id: pageB })).status, 404);
  assert.equal((await f.request('/v1/tools/notion_get_page', f.rb.key, { page_id: pageB })).status, 200);
  assert.equal((await f.request('/v1/connections', f.ra.key)).status, 401);
  assert.equal((await f.request('/v1/tools/notion_search', f.a.key, {})).status, 401);
  assert.equal((await f.request('/v1/tools/notion_search', 'invalid-key', {})).status, 401);
  assert.equal(f.calls.at(-1).version, '2026-03-11');
});
test('read keys cannot write; write retries and mismatched payloads are controlled', async t => {
  const f = await fixture(t), args = { block_id: pageA, text: 'First note', idempotency_key: 'write-operation-1' };
  assert.equal((await f.request('/v1/tools/notion_append_text', f.ra.key, args)).status, 403);
  const [r1, r2] = await Promise.all([f.request('/v1/tools/notion_append_text', f.wa.key, args), f.request('/v1/tools/notion_append_text', f.wa.key, args)]);
  assert.equal(r1.status, 200); assert.ok([200, 409].includes(r2.status));
  assert.equal((await f.request('/v1/tools/notion_append_text', f.wa.key, args)).status, 200);
  assert.equal(f.stats.writes, 1);
  assert.equal((await f.request('/v1/tools/notion_append_text', f.wa.key, { ...args, text: 'different note' })).status, 409);
});
test('uncertain writes are never automatically repeated, including another agent key', async t => {
  const f = await fixture(t), args = { block_id: pageA, text: 'Ambiguous note', idempotency_key: 'uncertain-1' };
  f.stats.timeoutWrite = true;
  assert.equal((await f.request('/v1/tools/notion_append_text', f.wa.key, args)).status, 502);
  const writer2 = f.store.issueKey(f.a.tenant_id, f.ca.connection_id, 'write', 'second writer');
  const retry = await f.request('/v1/tools/notion_append_text', writer2.key, args);
  assert.equal(retry.status, 409); assert.equal((await retry.json()).error, 'write_outcome_unknown');
  assert.equal(f.stats.writes, 1);
});
test('token refresh is serialized for simultaneous requests and persisted', async t => {
  const f = await fixture(t); f.stats.expired = true;
  const replies = await Promise.all([f.request('/v1/tools/notion_search', f.ra.key, {}), f.request('/v1/tools/notion_search', f.ra.key, {})]);
  assert.ok(replies.every(r => r.status === 200)); assert.equal(f.stats.refreshes, 1);
  const tokens = f.store.tokens(f.store.connection(f.a.tenant_id, f.ca.connection_id));
  assert.equal(tokens.access_token, 'access-A-fresh'); assert.equal(tokens.refresh_token, 'refresh-A-fresh');
});
test('pagination is explicit and title search retries bounded 429s', async t => {
  const f = await fixture(t); f.stats.throttled = true;
  const search = await f.request('/v1/tools/notion_search', f.ra.key, { query: 'Plan', start_cursor: 'cursor-before', page_size: 10 });
  const data = await search.json(); assert.equal(data.has_more, true); assert.equal(data.next_cursor, 'next-page');
  assert.equal(f.calls.at(-1).body.start_cursor, 'cursor-before');
  assert.equal(f.calls.filter(c => c.path === '/search').length, 2);
  const blocks = await f.request('/v1/tools/notion_list_blocks', f.ra.key, { block_id: pageA, start_cursor: 'child-cursor' });
  assert.equal(blocks.status, 200); assert.ok(f.calls.at(-1).query.includes('start_cursor=child-cursor'));
  assert.equal((await f.request('/v1/tools/notion_query_data_source', f.ra.key, { data_source_id: pageA, filter: { property: 'Status', select: { equals: 'Done' } } })).status, 200);
});
test('invalid inputs, untrusted origins, and host rebinding are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/tools/notion_get_page', f.ra.key, { page_id: '../users' })).status, 400);
  assert.equal((await f.request('/v1/tools/notion_search', f.ra.key, { page_size: 101 })).status, 400);
  assert.equal((await f.request('/v1/connections', f.a.key, null, 'GET', { Origin: 'https://evil.example' })).status, 403);
  const rawStatus = await new Promise((resolve, reject) => {
    const req = rawRequest(f.cfg.appUrl + '/health', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rawStatus, 403);
});
test('key and connection revocation stop access; audit contains no secrets or content', async t => {
  const f = await fixture(t);
  await f.request('/v1/tools/notion_search', f.ra.key, { query: 'private-query-fixture' });
  assert.equal((await f.request('/v1/keys/' + f.ra.key_id, f.a.key, null, 'DELETE')).status, 200);
  assert.equal((await f.request('/v1/tools/notion_search', f.ra.key, {})).status, 401);
  assert.equal((await f.request('/v1/connections/' + f.ca.connection_id, f.a.key, null, 'DELETE')).status, 200);
  assert.equal((await f.request('/v1/tools/notion_search', f.wa.key, {})).status, 401);
  assert.equal((await f.request('/v1/tools/notion_search', f.rb.key, {})).status, 200);
  const audit = JSON.stringify(await (await f.request('/v1/audit', f.a.key)).json());
  assert.ok(!audit.includes('private-query-fixture')); assert.ok(!audit.includes('access-A')); assert.ok(!audit.includes(f.ra.key));
  assert.ok(audit.includes('disconnect_workspace'));
});
test('failed upstream revocation still disables connector access and returns an action', async t => {
  const f = await fixture(t); f.stats.revokeFailed = true;
  const response = await f.request('/v1/connections/' + f.ca.connection_id, f.a.key, null, 'DELETE');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.disconnected, true); assert.equal(result.notion_revoked, false); assert.ok(result.action_required);
  assert.equal((await f.request('/v1/tools/notion_search', f.wa.key, {})).status, 401);
  assert.equal(f.store.db.prepare('SELECT tokens FROM connections WHERE id=?').get(f.ca.connection_id).tokens, '');
});
test('real MCP HTTP transport lists scoped tools and executes through fixture Notion', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'connector-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(f.cfg.appUrl + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + f.ra.key } } });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 16); assert.ok(listed.tools.every(tool => tool.annotations.readOnlyHint));
  const result = await client.callTool({ name: 'notion_search', arguments: { query: 'Plan' } });
  assert.ok(!result.isError); const data = JSON.parse(result.content[0].text); assert.equal(data.results[0].id, pageA);
  await client.close();
  const writer = new Client({ name: 'writer-test', version: '1.0.0' });
  t.after(() => writer.close());
  await writer.connect(new StreamableHTTPClientTransport(new URL(f.cfg.appUrl + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + f.wa.key } } }));
  assert.equal((await writer.listTools()).tools.length, 19);
  const created = await writer.callTool({ name: 'notion_create_page', arguments: { parent_id: pageA, title: 'Test page', text: 'Fixture only', idempotency_key: 'mcp-create-1' } });
  assert.ok(!created.isError); assert.equal(f.stats.writes, 1);
});
test('headless service exposes machine discovery only and has no UI or cookie-based management access', async t => {
  const f = await fixture(t);
  const root = await f.request('/', null, null, 'GET', { Accept: 'text/html' });
  assert.equal(root.status, 200); assert.ok(root.headers.get('content-type').includes('application/json'));
  assert.equal((await root.json()).interaction, 'agent_only');
  for (const path of ['/console', '/console/style.css', '/console/app.js', '/console/me']) {
    const removed = await f.request(path, f.a.key);
    assert.equal(removed.status, 404); assert.ok(removed.headers.get('content-type').includes('application/json'));
  }
  for (const path of ['/console/session', '/console/configure']) assert.equal((await f.request(path, f.a.key, {})).status, 404);
  assert.equal((await f.request('/v1/connections', null, null, 'GET', { Cookie: 'nc_console=old-session' })).status, 401);
  assert.equal((await f.request('/v1/index/' + f.ca.connection_id + '/preview', f.a.key, { query: 'project' })).status, 404);
  const discovery = await f.request('/v1/tools', f.ra.key);
  assert.equal(discovery.status, 200); const tools = await discovery.json(); assert.equal(tools.tools.length, 16);
  assert.ok(tools.tools.every(tool => tool.read_only && tool.input_schema.type === 'object'));
  assert.equal((await f.request('/llms.txt')).status, 200);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('console_sessions','console_tickets')").get().n, 0);
  const start = await f.request('/v1/notion/connect', f.a.key, {});
  const authorization = await fetch((await start.json()).connect_url, { redirect: 'manual' });
  const state = new URL(authorization.headers.get('location')).searchParams.get('state');
  const callback = await f.request('/oauth/notion/callback?state=' + state + '&code=A', null, null, 'GET', { Cookie: authorization.headers.get('set-cookie').split(';')[0], Accept: 'text/html' });
  assert.equal(callback.status, 200); assert.ok(callback.headers.get('content-type').includes('application/json'));
  assert.equal(callback.headers.get('location'), null);
});
test('stdio bridge exposes the scoped tools and makes real HTTP calls to the connector', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'stdio-bridge-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/stdio.js', import.meta.url))], env: { NOTION_CONNECTOR_URL: f.cfg.appUrl, NOTION_AGENT_KEY: f.ra.key } });
  t.after(() => client.close());
  await client.connect(transport);
  const listing = await client.listTools(); assert.equal(listing.tools.length, 16);
  const result = await client.callTool({ name: 'notion_search_titles', arguments: { query: 'Plan' } });
  assert.ok(!result.isError); assert.equal(JSON.parse(result.content[0].text).results[0].id, pageA);
  await client.close();
});
