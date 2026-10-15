import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ConnectorError, NotionConnectorClient, validateConnectorUrl } from '../src/client.js';
import { createApp } from '../src/app.js';
import { setup, ids } from './fixtures/workspace.js';

const schema = { type: 'object', properties: { query: { type: 'string' }, idempotency_key: { type: 'string' } }, additionalProperties: false };
const catalog = { tools: [
  { name: 'notion_read', description: 'Fixture read', input_schema: schema, read_only: true },
  { name: 'notion_write', description: 'Fixture write', input_schema: schema, read_only: false }
] };
const json = (res, data, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
async function endpoint(t, onRequest) {
  const server = createServer((req, res) => { void onRequest(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port };
}
const makeClient = (baseUrl, extra = {}) => new NotionConnectorClient({ baseUrl, apiKey: 'fixture-agent-key', retryDelayMs: 0, ...extra });
async function body(req) { let value = ''; for await (const chunk of req) value += chunk; return JSON.parse(value); }

test('client discovers scoped schemas and retrieves real connector evidence over HTTP', async t => {
  const f = await setup(t); await f.index();
  const app = createApp(f.store, f.notion, f.cfg);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.closeMcp(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const access = f.store.issueKey(f.keyA.tenant_id, f.keyA.connection_id, 'read', 'HTTP client fixture');
  const client = new NotionConnectorClient({ baseUrl: 'http://127.0.0.1:' + app.server.address().port, apiKey: access.key });
  const tools = await client.listTools();
  assert.ok(tools.every(tool => tool.read_only));
  assert.ok(tools.some(tool => tool.name === 'notion_get_context' && tool.input_schema.properties.query));
  const evidence = await client.callTool('notion_get_context', { query: 'Who handles satellite escalations?', max_chars: 2000 });
  assert.match(evidence.passages[0].text, /Marisol/);
  assert.ok(evidence.passages[0].url.includes('#'));
  assert.ok(JSON.stringify(evidence).length <= 2000);
  const page = await client.callTool('notion_get_page', { page_id: ids.root });
  assert.equal(page.id, ids.root);
  await assert.rejects(client.callTool('notion_get_page', { page_id: 'invalid-id' }), error => error instanceof ConnectorError && error.status === 400 && error.code === 'invalid_arguments');
  f.store.db.prepare('UPDATE keys SET active=0 WHERE id=?').run(access.key_id);
  await assert.rejects(client.callTool('notion_get_page', { page_id: ids.root }), error => error.status === 401 && !error.retryable);
});

test('client protects credentials with HTTPS/loopback validation and refuses redirects', async t => {
  for (const value of ['http://example.com', 'http://127.0.0.1.attacker.test', 'ftp://localhost', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com#secret', '/relative']) {
    assert.throws(() => validateConnectorUrl(value), ConnectorError);
  }
  assert.equal(validateConnectorUrl('https://example.com/connector').href, 'https://example.com/connector/');
  assert.equal(validateConnectorUrl('http://[::1]:3100').hostname, '[::1]');
  assert.throws(() => makeClient('http://localhost', { apiKey: 'key\nheader' }), { code: 'invalid_key' });
  let received = 0;
  const target = await endpoint(t, (req, res) => { received++; json(res, catalog); });
  const redirect = await endpoint(t, (req, res) => { res.writeHead(307, { Location: target.baseUrl + '/v1/tools' }); res.end(); });
  await assert.rejects(makeClient(redirect.baseUrl).listTools(), { code: 'redirect_denied', status: 307 });
  assert.equal(received, 0, 'an agent credential must never follow a redirect');
});

test('read retries honor Retry-After and preserve arguments while writes are sent only once', async t => {
  const attempts = { read: 0, write: 0 }, received = [];
  const f = await endpoint(t, async (req, res) => {
    if (req.url === '/v1/tools') return json(res, catalog);
    received.push(await body(req));
    if (req.url.endsWith('/notion_read')) {
      if (++attempts.read === 1) return json(res, { error: 'busy', message: 'Try again.' }, 503, { 'Retry-After': '0' });
      return json(res, { answer: 'retried read' });
    }
    attempts.write++;
    return json(res, { error: 'upstream_unavailable', message: 'Write response unavailable.' }, 503, { 'X-Request-ID': 'request-123' });
  });
  const client = makeClient(f.baseUrl);
  const args = { query: 'initial query' };
  const pending = client.callTool('notion_read', args); args.query = 'changed by caller';
  assert.deepEqual(await pending, { answer: 'retried read' });
  assert.equal(attempts.read, 2);
  assert.deepEqual(received, [{ query: 'initial query' }, { query: 'initial query' }]);
  await assert.rejects(client.callTool('notion_write', { query: 'write' }), { code: 'idempotency_key_required' });
  assert.equal(attempts.write, 0);
  await assert.rejects(client.callTool('notion_write', { query: 'write', idempotency_key: 'same-write-key' }), error => {
    assert.equal(error.code, 'upstream_unavailable');
    assert.equal(error.writeOutcomeUnknown, true);
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, 'request-123');
    assert.equal(error.toJSON().write_outcome_unknown, true);
    return true;
  });
  assert.equal(attempts.write, 1);
});

test('disconnects retry reads, mark writes uncertain, and do not poison future requests', async t => {
  let reads = 0, writes = 0;
  const f = await endpoint(t, (req, res) => {
    if (req.url === '/v1/tools') return json(res, catalog);
    if (req.url.endsWith('/notion_write')) { writes++; req.socket.destroy(); return; }
    if (++reads === 1) { req.socket.destroy(); return; }
    return json(res, { recovered: true });
  });
  const client = makeClient(f.baseUrl);
  assert.deepEqual(await client.callTool('notion_read'), { recovered: true });
  assert.equal(reads, 2);
  await assert.rejects(client.callTool('notion_write', { idempotency_key: 'one-operation' }), error => error.code === 'connection_failed' && error.writeOutcomeUnknown);
  assert.equal(writes, 1);
  assert.deepEqual(await client.callTool('notion_read'), { recovered: true });
});

test('timeouts and caller cancellation cover discovery, response bodies, and retry backoff', async t => {
  let mode = 'ready', attempts = 0;
  const f = await endpoint(t, (req, res) => {
    if (mode === 'discovery-hang') return;
    if (req.url === '/v1/tools') return json(res, catalog);
    attempts++;
    if (mode === 'body-hang') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); return; }
    if (mode === 'backoff') return json(res, { error: 'rate_limited' }, 429, { 'Retry-After': '10' });
    return json(res, { ok: true });
  });
  const client = makeClient(f.baseUrl);
  mode = 'discovery-hang';
  await assert.rejects(client.listTools({ timeoutMs: 80 }), { code: 'timeout' });
  mode = 'ready'; await client.listTools();
  mode = 'body-hang';
  await assert.rejects(client.callTool('notion_read', {}, { timeoutMs: 80 }), { code: 'timeout', writeOutcomeUnknown: false });
  await assert.rejects(client.callTool('notion_write', { idempotency_key: 'timeout-write' }, { timeoutMs: 80 }), { code: 'timeout', writeOutcomeUnknown: true });
  mode = 'backoff'; attempts = 0;
  const controller = new AbortController();
  const pending = client.callTool('notion_read', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(pending, { code: 'aborted', retryable: false });
  assert.equal(attempts, 1, 'cancellation interrupts Retry-After rather than sending another request');
  const before = attempts;
  await assert.rejects(client.callTool('notion_read', {}, { signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(attempts, before);
});

test('discovery cache is defensive, refreshable, and rejects malformed or duplicate tools', async t => {
  let discoveryCalls = 0, mode = 'valid';
  const f = await endpoint(t, (req, res) => {
    discoveryCalls++;
    if (mode === 'duplicate') return json(res, { tools: [catalog.tools[0], catalog.tools[0]] });
    if (mode === 'missing-safety') return json(res, { tools: [{ name: 'notion_write', input_schema: schema }] });
    if (mode === 'huge') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ body: 'x'.repeat(3000) })); return; }
    if (mode === 'html') { res.writeHead(200); res.end('<html>Login</html>'); return; }
    return json(res, catalog);
  });
  const client = makeClient(f.baseUrl, { maxResponseBytes: 2048 });
  const tools = await client.listTools(); tools[1].read_only = true;
  assert.equal((await client.listTools())[1].read_only, false);
  assert.equal(discoveryCalls, 1);
  await client.listTools({ refresh: true }); assert.equal(discoveryCalls, 2);
  await assert.rejects(client.callTool('../keys'), { code: 'invalid_tool_name' });
  await assert.rejects(client.callTool('notion_read', { impossible: 1n }), { code: 'invalid_arguments' });
  await assert.rejects(client.callTool('notion_read', { toJSON: () => 'string' }), { code: 'invalid_arguments' });
  for (const invalid of ['duplicate', 'missing-safety', 'html']) {
    mode = invalid; await assert.rejects(client.listTools({ refresh: true }), { code: 'invalid_response' });
  }
  mode = 'huge'; await assert.rejects(client.listTools({ refresh: true }), { code: 'response_too_large' });
});
