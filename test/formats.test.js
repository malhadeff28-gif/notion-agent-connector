import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup, ids } from './fixtures/workspace.js';
import { createApp } from '../src/app.js';
import { NotionConnectorClient } from '../src/client.js';
import { formatTools, executeToolCall, openApiDocument, portableSchema } from '../src/formats.js';
import { diagnose } from '../src/diagnostics.js';

async function fixture(t) {
  const f = await setup(t); await f.index();
  const app = createApp(f.store, f.notion, f.cfg);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + app.server.address().port;
  const key = f.store.issueKey(f.keyA.tenant_id, f.keyA.connection_id, 'read', 'portable client');
  t.after(async () => { await app.closeMcp(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const client = new NotionConnectorClient({ baseUrl, apiKey: key.key, maxRetries: 0 });
  const get = path => fetch(baseUrl + path, { headers: { Authorization: 'Bearer ' + key.key } });
  return { ...f, app, baseUrl, key, client, get };
}

test('provider schemas and OpenAPI contain only the current key tools and retain optional arguments', async t => {
  const f = await fixture(t), definitions = await f.client.listTools();
  for (const format of ['openai', 'openai-chat', 'anthropic', 'gemini']) {
    const response = await f.get('/v1/tools?format=' + format);
    assert.equal(response.status, 200);
    const { tools } = await response.json();
    assert.deepEqual(tools, formatTools(definitions, format));
    assert.ok(!JSON.stringify(tools).includes('notion_append_text'));
  }
  const openai = formatTools(definitions, 'openai').find(t => t.name === 'notion_get_context');
  assert.equal(openai.strict, false);
  assert.deepEqual(openai.parameters.required, ['query']);
  assert.equal((await f.get('/v1/tools?format=nope')).status, 400);
  const document = await (await f.get('/v1/openapi.json')).json();
  assert.equal(document.openapi, '3.1.0');
  assert.equal(Object.keys(document.paths).length, definitions.length);
  assert.ok(!JSON.stringify(document).includes(f.key.key));
  assert.equal((await fetch(f.baseUrl + '/v1/openapi.json')).status, 401);
});

test('recursive arbitrary JSON schemas are portable inside an OpenAPI envelope', async t => {
  const f = await fixture(t);
  const write = f.store.issueKey(f.keyA.tenant_id, f.keyA.connection_id, 'write', 'write schemas');
  const client = new NotionConnectorClient({ baseUrl: f.baseUrl, apiKey: write.key });
  const doc = openApiDocument(await client.listTools(), f.baseUrl);
  assert.ok(doc.paths['/v1/tools/notion_update_properties']);
  assert.ok(!JSON.stringify(doc).includes('$ref'));
  assert.throws(() => portableSchema({ $ref: '#/$defs/missing' }), /unsupported reference/);
});

test('all four provider call envelopes retrieve live-checked cited evidence over HTTP', async t => {
  const f = await fixture(t), args = { query: 'Who handles satellite escalations?', max_chars: 2000 };
  const calls = [
    ['openai', { type: 'function_call', name: 'notion_get_context', call_id: 'call1', arguments: JSON.stringify(args) }],
    ['openai-chat', { id: 'call1', type: 'function', function: { name: 'notion_get_context', arguments: JSON.stringify(args) } }],
    ['anthropic', { type: 'tool_use', id: 'call1', name: 'notion_get_context', input: args }],
    ['gemini', { functionCall: { id: 'call1', name: 'notion_get_context', args } }]
  ];
  for (const [format, call] of calls) {
    const result = await executeToolCall(f.client, call, { format });
    const evidence = format === 'gemini' ? result.functionResponse.response : JSON.parse(result.output || result.content);
    assert.ok(evidence.passages.some(p => p.text.includes('Marisol') && p.url && p.source_checked_at));
    assert.ok(JSON.stringify(evidence).length <= 2000);
    assert.equal(format === 'gemini' ? result.functionResponse.id : result.call_id || result.tool_call_id || result.tool_use_id, 'call1');
  }
});

test('model dispatch gates writes and rejects malformed calls without executing them', async () => {
  let sent = 0;
  const client = { listTools: async () => [{ name: 'notion_append_text', read_only: false }], callTool: async () => { sent++; return {}; } };
  const call = { name: 'notion_append_text', call_id: 'c', arguments: '{}' };
  assert.equal(JSON.parse((await executeToolCall(client, call)).output).error, 'write_denied');
  assert.equal(sent, 0);
  assert.equal(JSON.parse((await executeToolCall(client, call, { allowWrites: true, allowedTools: [] })).output).error, 'tool_denied');
  await executeToolCall(client, call, { allowWrites: true }); assert.equal(sent, 1);
  await assert.rejects(executeToolCall(client, { ...call, arguments: '{broken' }), /must be JSON/);
  await assert.rejects(executeToolCall(client, { ...call, call_id: null }), /call ID/);
  assert.equal(sent, 1);
});

test('diagnostics verify both question and page reads without returning source text', async t => {
  const f = await fixture(t);
  const metadata = await diagnose(f.client);
  assert.equal(metadata.ok, true); assert.equal(metadata.source_verified, false);
  for (const options of [{ query: 'satellite escalations' }, { pageId: ids.root }]) {
    const result = await diagnose(f.client, options);
    assert.equal(result.ok, true); assert.equal(result.source_verified, true);
    assert.ok(!JSON.stringify(result).includes('Marisol'));
  }
  const status = await (await f.get('/v1/status')).json();
  assert.equal(status.provider, 'oauth'); assert.equal(status.source_ready, null);
  f.store.db.prepare('UPDATE keys SET active=0 WHERE id=?').run(f.key.key_id);
  assert.equal((await diagnose(f.client)).ok, false);
});

test('HTTP JSON parsing preserves Unicode split across TCP chunks and rejects invalid UTF8', async t => {
  const f = await fixture(t);
  const write = f.store.issueKey(f.keyA.tenant_id, f.keyA.connection_id, 'write', 'unicode');
  const request = chunks => new Promise((resolve, reject) => {
    const req = rawRequest(f.baseUrl + '/v1/tools/notion_append_text', { method: 'POST', headers: { Authorization: 'Bearer ' + write.key, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(chunks[0]); setTimeout(() => { for (const chunk of chunks.slice(1)) req.write(chunk); req.end(); }, 20);
  });
  const payload = Buffer.from(JSON.stringify({ block_id: ids.root, text: 'café 🚀 中文', idempotency_key: 'unicode-test-key' }));
  const split = payload.indexOf(Buffer.from('🚀')) + 1;
  assert.equal((await request([payload.subarray(0, split), payload.subarray(split)])).status, 200);
  assert.equal(f.requests.find(r => r.body?.children)?.body.children[0].paragraph.rich_text[0].text.content, 'café 🚀 中文');
  const invalid = await request([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.text).request_id, invalid.headers['x-request-id']);
});

test('CLI config emits cross-platform paths and no environment key secret', async () => {
  const result = await new Promise(resolve => {
    const processHandle = spawn(process.execPath, [fileURLToPath(new URL('../src/agent-cli.js', import.meta.url)), 'config'], { env: { ...process.env, NOTION_AGENT_KEY: 'DO_NOT_PRINT_THIS' } });
    let stdout = '', stderr = ''; processHandle.stdout.on('data', c => stdout += c); processHandle.stderr.on('data', c => stderr += c);
    processHandle.on('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const cfg = JSON.parse(result.stdout).mcpServers['notion-agent-search'];
  assert.equal(cfg.command, process.execPath);
  assert.ok(!cfg.args[0].startsWith('/C:/'));
  assert.ok(!result.stdout.includes('DO_NOT_PRINT_THIS'));
});
