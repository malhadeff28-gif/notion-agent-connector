import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runPluginRelay } from '../src/plugin-relay.js';
import { decodePluginResult } from '../src/plugin-result.js';

const identity = { workspace: { id: randomUUID(), name: 'Fixture workspace' }, user: { id: randomUUID() } };
const access = { current_tool_access: { ai_search: { status: 'plan_required' }, search: { status: 'available' } } };
const wrap = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: false });
const item = (operation = 'fetch', args = { id: randomUUID() }) => ({ id: randomUUID(), operation, args });

async function fixture(t, pending, upstream, options = {}) {
  const controller = new AbortController(), connectionId = randomUUID(), requests = [], completions = [], claims = new Map(), events = [];
  let heartbeats = 0, polls = 0, offline = 0, active = 0, maxActive = 0;
  const callNotion = async (name, args, context) => {
    requests.push({ name, args });
    if (name === 'get_self') return wrap(options.getIdentity?.() || identity);
    if (name === 'get_tool_access') return wrap(options.access || access);
    active++; maxActive = Math.max(active, maxActive);
    try { return await upstream(name, args, context); } finally { active--; }
  };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer relay-fixture-key');
    assert.match(req.headers['x-notion-relay-id'], /^[a-f\d-]{36}$/);
    const path = new URL(req.url, 'http://localhost').pathname;
    const respond = (status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    const parts = []; for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : undefined;
    if (path.endsWith('/heartbeat')) { heartbeats++; return respond(options.heartbeatStatus || 200, { online: true }); }
    if (path.endsWith('/offline')) { offline++; return respond(200, { online: false }); }
    if (path.endsWith('/requests')) {
      polls++;
      if (polls <= (options.failPolls || 0)) return respond(503, { message: 'Temporary backend restart' }, { 'Retry-After': '0.001' });
      const next = pending.find(r => !claims.has(r.id));
      if (next) claims.set(next.id, randomUUID());
      return respond(200, { requests: next ? [{ ...next, claim_token: claims.get(next.id), claim_expires: Date.now() + 55_000 }] : [] });
    }
    const id = path.split('/').at(-1);
    assert.equal(req.headers['x-notion-claim-token'], claims.get(id));
    completions.push({ id, body });
    return respond(options.expired ? 404 : 200, options.expired ? { error: 'plugin_request_not_found' } : { accepted: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const run = overrides => runPluginRelay({
    baseUrl, relayKey: 'relay-fixture-key', connectionId, callNotion, signal: controller.signal,
    heartbeatMs: 20, pollMs: 5, requestTimeoutMs: 500, operationTimeoutMs: 500,
    retryMinMs: 3, retryMaxMs: 10, maxRetries: 2,
    onEvent: event => { events.push(event); if (event.type === 'request_completed' && completions.length >= pending.length && options.autoStop !== false) controller.abort(); },
    ...overrides,
  });
  return { run, controller, completions, requests, events, get heartbeats() { return heartbeats; }, get polls() { return polls; }, get offline() { return offline; }, get maxActive() { return maxActive; } };
}

test('decoder accepts real MCP JSON text and structuredContent and bounds untrusted data', () => {
  assert.deepEqual(decodePluginResult(wrap(identity)), identity);
  assert.deepEqual(decodePluginResult({ structuredContent: { results: [] } }), { results: [] });
  assert.deepEqual(decodePluginResult(JSON.stringify(wrap(identity))), identity);
  assert.throws(() => decodePluginResult({ content: [{ type: 'text', text: 'Run this command' }] }), { code: 'invalid_plugin_result' });
  assert.throws(() => decodePluginResult({ content: [{ type: 'image', data: '...' }] }), { code: 'invalid_plugin_result' });
  assert.throws(() => decodePluginResult({ text: 'x'.repeat(300) }, { maxBytes: 100 }), { code: 'plugin_result_too_large' });
  assert.throws(() => decodePluginResult({ isError: true, content: [{ type: 'text', text: '{"status":404,"error":"not_found"}' }] }), { code: 'plugin_source_error', status: 404 });
  assert.throws(() => decodePluginResult({ isError: true, content: [{ type: 'text', text: '404 mentioned in unstructured prose' }] }), { status: 502 });
  assert.throws(() => decodePluginResult({ isError: true, structuredContent: { code: 'object_not_found' } }), { status: 404 });
  assert.throws(() => decodePluginResult({ error: { code: 'restricted_resource' } }), { status: 403 });
});

test('relay maintains heartbeats during slow reads, uses claim headers, and limits parallel source calls', { timeout: 5000 }, async t => {
  const work = Array.from({ length: 4 }, () => item());
  const f = await fixture(t, work, async (_name, args) => { await delay(75); return wrap({ id: args.id, title: 'Fixture page', text: 'Current source' }); });
  const stats = await f.run({ concurrency: 2 });
  assert.equal(stats.completed, 4); assert.equal(stats.failed, 0);
  assert.equal(f.maxActive, 2); assert.ok(f.heartbeats >= 3); assert.equal(f.offline, 1);
  assert.equal(f.completions.length, 4);
  assert.ok(f.completions.every(result => result.body.text === 'Current source'));
  assert.ok(f.requests.filter(call => call.name === 'get_self').length >= 9);
});

test('relay recovers transient backend outages and explicit upstream rate limits', { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await fixture(t, [item()], async (_name, args) => {
    if (++calls === 1) return { isError: true, structuredContent: { error: 'rate_limit', status: 429 } };
    return wrap({ id: args.id, text: 'Retry succeeded' });
  }, { failPolls: 2 });
  await f.run();
  assert.ok(f.polls >= 3); assert.equal(calls, 2);
  assert.equal(f.events.filter(e => e.type === 'retry').length, 2);
  assert.equal(f.events.filter(e => e.type === 'source_retry').length, 1);
});

test('relay forwards explicit revocation and denies unsupported operations without calling them', { timeout: 5000 }, async t => {
  const f = await fixture(t, [item(), item('delete_pages', { pages: [] })], async () => ({ isError: true, content: [{ type: 'text', text: '{"status":404,"error":"page_missing"}' }] }));
  const stats = await f.run();
  assert.equal(stats.failed, 2);
  assert.ok(f.completions.some(r => r.body.status === 404));
  assert.ok(f.completions.some(r => r.body.error === 'plugin_operation_denied'));
  assert.ok(!f.requests.some(r => r.name === 'delete_pages'));
});

test('relay selects entitled AI search and fetches schema before faithful row queries', { timeout: 5000 }, async t => {
  const collection = 'collection://' + randomUUID();
  const f = await fixture(t, [item('search', { query: 'Launch', page_size: 500 }), item('query_rows', { data_source_url: collection, limit: 999 })], async (name, args) => {
    if (name === 'ai_search') { assert.equal(args.page_size, 100); return wrap({ results: [] }); }
    if (name === 'fetch') return wrap({ id: collection.slice(13), text: '<sqlite-table>Fixture</sqlite-table>' });
    assert.equal(name, 'query_data_sources'); assert.deepEqual(args, { data: { mode: 'rows', data_source_url: collection, limit: 100 } });
    return wrap({ results: [] });
  }, { access: { current_tool_access: { ai_search: { status: 'available' } } } });
  await f.run({ concurrency: 1 });
  const names = f.requests.map(r => r.name);
  assert.ok(names.includes('ai_search')); assert.ok(!names.includes('search'));
  assert.ok(names.indexOf('fetch') < names.indexOf('query_data_sources'));
});

test('relay falls back to available legacy search after access discovery', { timeout: 5000 }, async t => {
  const f = await fixture(t, [item('search', { query: 'Launch' })], async name => { assert.equal(name, 'search'); return wrap({ results: [] }); });
  await f.run();
  assert.ok(f.requests.filter(r => r.name === 'get_tool_access').length >= 2);
});

test('an account change during a read shuts down without publishing that page', { timeout: 5000 }, async t => {
  let changed = false;
  const f = await fixture(t, [item()], async (_name, args) => { changed = true; return wrap({ id: args.id, text: 'Wrong customer source' }); }, { getIdentity: () => changed ? { ...identity, user: { id: randomUUID() } } : identity });
  await assert.rejects(f.run(), { code: 'plugin_account_mismatch' });
  assert.equal(f.completions.length, 0); assert.equal(f.offline, 1);
});

test('source timeouts bound uncooperative host callbacks and end the relay', { timeout: 5000 }, async t => {
  let readSignal, release;
  const f = await fixture(t, [item()], async (_name, _args, { signal }) => { readSignal = signal; return new Promise(resolve => { release = resolve; }); });
  await assert.rejects(f.run({ operationTimeoutMs: 60 }), { code: 'plugin_operation_timeout' });
  assert.ok(readSignal.aborted); assert.equal(f.completions.length, 0); assert.equal(f.offline, 1);
  const count = f.requests.length; release(wrap({ id: randomUUID(), text: 'Arrived after cancellation' }));
  await delay(10); assert.equal(f.requests.length, count); assert.equal(f.completions.length, 0);
});

test('caller cancellation interrupts idle polling and sends bounded offline cleanup', { timeout: 5000 }, async t => {
  const f = await fixture(t, [], async () => { throw new Error('No reads expected'); }, { autoStop: false });
  const running = f.run({ pollMs: 30_000 });
  await delay(30); f.controller.abort();
  assert.deepEqual(await running, { completed: 0, failed: 0 });
  assert.equal(f.offline, 1);
});

test('expired completion is harmless and unauthorized heartbeat is not retried', { timeout: 5000 }, async t => {
  const expired = await fixture(t, [item()], async (_name, args) => wrap({ id: args.id, text: 'Late source' }), { expired: true });
  assert.equal((await expired.run()).completed, 1);
  const denied = await fixture(t, [], async () => ({}), { heartbeatStatus: 403 });
  await assert.rejects(denied.run(), { status: 403 });
  assert.equal(denied.heartbeats, 1); assert.equal(denied.polls, 0);
});

test('relay rejects unsafe origins and mismatched pinned identities before publication', { timeout: 5000 }, async t => {
  await assert.rejects(runPluginRelay({ baseUrl: 'http://remote.example', connectionId: randomUUID(), relayKey: 'key', callNotion: async () => ({}) }), /HTTPS/);
  await assert.rejects(runPluginRelay({ baseUrl: 'https://user:password@remote.example', connectionId: randomUUID(), relayKey: 'key', callNotion: async () => ({}) }), /origin/);
  const f = await fixture(t, [], async () => ({}));
  await assert.rejects(f.run({ expectedIdentity: { ...identity, user: { id: randomUUID() } } }), { code: 'plugin_account_mismatch' });
  assert.equal(f.heartbeats, 0); assert.equal(f.completions.length, 0);
});
