import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createApp } from '../src/app.js';
import { setup, ids } from './fixtures/workspace.js';

const entry = fileURLToPath(new URL('../src/stdio.js', import.meta.url));
async function fixture(t) {
  const f = await setup(t); await f.index();
  let app = createApp(f.store, f.notion, f.cfg);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => { if (!app) return; await app.closeMcp(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const access = f.store.issueKey(f.keyA.tenant_id, f.keyA.connection_id, 'read', 'stdio fixture');
  return { ...f, access, baseUrl: 'http://127.0.0.1:' + port,
    stop: async () => { await app.closeMcp(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app = null; },
    restart: async () => { app = createApp(f.store, f.notion, f.cfg); await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve)); }
  };
}

test('one MCP stdio process recovers after a real remote shutdown and restart', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'restart-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe', env: {
    NOTION_CONNECTOR_URL: f.baseUrl, NOTION_AGENT_KEY: f.access.key, NOTION_CONNECTOR_MAX_RETRIES: '0', NOTION_CONNECTOR_TIMEOUT_MS: '3000'
  } });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  const listing = await client.listTools();
  assert.ok(listing.tools.some(tool => tool.name === 'notion_get_context' && tool.annotations.readOnlyHint));
  const first = await client.callTool({ name: 'notion_get_page', arguments: { page_id: ids.root } });
  assert.equal(first.structuredContent.id, ids.root);
  await f.stop();
  const offline = await client.callTool({ name: 'notion_get_page', arguments: { page_id: ids.root } });
  assert.equal(offline.isError, true);
  assert.equal(JSON.parse(offline.content[0].text).error, 'connection_failed');
  await f.restart();
  const recovered = await client.callTool({ name: 'notion_get_context', arguments: { query: 'Who handles satellite escalations?', max_chars: 2000 } });
  assert.ok(!recovered.isError);
  assert.match(recovered.structuredContent.passages[0].text, /Marisol/);
  f.store.db.prepare('UPDATE keys SET active=0 WHERE id=?').run(f.access.key_id);
  const revoked = await client.callTool({ name: 'notion_get_page', arguments: { page_id: ids.root } });
  assert.equal(revoked.isError, true);
  assert.equal(JSON.parse(revoked.content[0].text).status, 401);
  assert.ok(!stderr.includes(f.access.key));
  assert.ok(!stderr.includes('Marisol'));
  await client.close();
});

test('stdio accepts private key files, emits only JSON-RPC on stdout, and exits on EOF', async t => {
  const f = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'notion-stdio-key-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'agent-key.txt'); writeFileSync(keyFile, f.access.key + '\n', { mode: 0o600 });
  const child = spawn(process.execPath, [entry], { env: { ...process.env, NOTION_AGENT_KEY: '', NOTION_AGENT_KEY_FILE: keyFile, NOTION_CONNECTOR_URL: f.baseUrl }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const responses = new Map(), waiters = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    stdout += chunk; buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      responses.set(message.id, message); waiters.get(message.id)?.(message);
    }
  });
  const send = message => {
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(message.id); reject(new Error('stdio response timeout: ' + stderr)); }, 5000);
      waiters.set(message.id, result => { clearTimeout(timer); waiters.delete(message.id); resolve(result); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); return pending;
  };
  const initialized = await send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw-stdio-fixture', version: '1.0.0' } } });
  assert.ok(initialized.result.serverInfo);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listing = await send({ id: 2, method: 'tools/list', params: {} });
  assert.ok(listing.result.tools.some(tool => tool.name === 'notion_get_context'));
  const result = await send({ id: 3, method: 'tools/call', params: { name: 'notion_get_page', arguments: { page_id: ids.root } } });
  assert.equal(result.result.structuredContent.id, ids.root);
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stdio child did not exit on EOF')), 5000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end(); assert.equal(await exited, 0);
  assert.ok(stdout.trim().split('\n').every(line => JSON.parse(line).jsonrpc === '2.0'));
  assert.ok(!stdout.includes(f.access.key)); assert.ok(!stderr.includes(f.access.key));
});
