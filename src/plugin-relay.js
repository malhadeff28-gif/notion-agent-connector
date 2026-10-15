import { randomUUID } from 'node:crypto';
import { decodePluginResult, pluginSourceStatus } from './plugin-result.js';

const allowed = new Set(['fetch', 'search', 'list_private_pages', 'list_shared_pages', 'list_recent_pages', 'query_rows']);
const transient = new Set([408, 429, 502, 503, 504]);
const uuid = value => typeof value === 'string' && /^[a-f\d]{32}$/i.test(value.replaceAll('-', '')) ? value.replaceAll('-', '').toLowerCase() : null;
const abortError = () => new DOMException('Relay stopped.', 'AbortError');
const failure = (code, status = 502) => Object.assign(new Error(code), { code, status });
const positive = (value, name, max = 120_000) => {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
};

function identityKey(identity) {
  const workspace = uuid(identity?.workspace?.id), user = uuid(identity?.user?.id);
  if (!workspace || !user) throw failure('invalid_plugin_identity', 403);
  return `${workspace}:${user}`;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || abortError());
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason || abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Bound even hosts that ignore cancellation. Source timeouts stop the relay, so
// uncooperative callbacks cannot accumulate abandoned source reads indefinitely.
async function bounded(action, signal, timeoutMs) {
  const timerController = new AbortController();
  const timer = setTimeout(() => timerController.abort(failure('plugin_operation_timeout', 504)), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timerController.signal]) : timerController.signal;
  let listener;
  try {
    combined.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(() => action(combined)),
      new Promise((_, reject) => { listener = () => reject(combined.reason || abortError()); combined.addEventListener('abort', listener, { once: true }); }),
    ]);
  } finally { clearTimeout(timer); if (listener) combined.removeEventListener('abort', listener); }
}

async function jsonResponse(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw failure('relay_response_too_large'); }
  let text = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > limit) { await reader.cancel(); throw failure('relay_response_too_large'); }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw failure('relay_response_too_large');
  try { return JSON.parse(text); } catch { throw failure('invalid_relay_response'); }
}

/**
 * Run inside the host owning the connected Notion tools. callNotion receives
 * (logicalToolName, arguments, { signal }); preserve that user's account and honor
 * cancellation. No plugin credentials leave this host. Each run owns one relay ID.
 */
export async function runPluginRelay({
  baseUrl, relayKey, managementKey, connectionId, callNotion, contentSearch, expectedIdentity, signal,
  fetchImpl = globalThis.fetch, heartbeatMs = 25_000, pollMs = 600, requestTimeoutMs = 10_000,
  operationTimeoutMs = 45_000, concurrency = 2, maxRetries = 4, retryMinMs = 250,
  retryMaxMs = 8_000, maxResponseBytes = 2_000_000, onEvent = () => {},
}) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new TypeError('baseUrl must be the connector origin.');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new TypeError('Use HTTPS for remote relays.');
  if (!uuid(connectionId)) throw new TypeError('A valid connectionId is required.');
  const credential = relayKey ?? managementKey;
  if (typeof credential !== 'string' || !credential || /[\r\n]/.test(credential)) throw new TypeError('A connection-scoped relayKey is required (managementKey also accepted for older hosts).');
  if (typeof callNotion !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('Provide callNotion and fetch implementations.');
  positive(heartbeatMs, 'heartbeatMs', 30_000); positive(pollMs, 'pollMs', 30_000);
  positive(requestTimeoutMs, 'requestTimeoutMs', 30_000); positive(operationTimeoutMs, 'operationTimeoutMs', 50_000);
  positive(concurrency, 'concurrency', 8); positive(retryMinMs, 'retryMinMs'); positive(retryMaxMs, 'retryMaxMs');
  positive(maxResponseBytes, 'maxResponseBytes', 10_000_000);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10 || retryMaxMs < retryMinMs) throw new TypeError('Invalid retry settings.');
  if (signal?.aborted) return { completed: 0, failed: 0 };

  const stop = new AbortController(), runSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const prefix = `/v1/plugin/${encodeURIComponent(connectionId)}`, relayId = randomUUID();
  const stats = { completed: 0, failed: 0 }, inFlight = new Map(), finished = new Map();
  let boundIdentity, heartbeatTask, fatal, connected = false;
  const event = (type, fields = {}) => { try { onEvent({ type, ...fields }); } catch { /* Observability cannot alter authorization. */ } };
  const fail = error => { if (!fatal && !runSignal.aborted) { fatal = error; stop.abort(error); } };
  const decode = result => decodePluginResult(result, { maxBytes: maxResponseBytes });
  const invoke = async (name, args, callSignal) => {
    for (let attempt = 0;; attempt++) {
      let received = false;
      try {
        callSignal.throwIfAborted();
        const result = await callNotion(name, args, { signal: callSignal });
        callSignal.throwIfAborted();
        received = true;
        return decode(result);
      }
      catch (error) {
        if (callSignal.aborted) throw callSignal.reason || abortError();
        const status = pluginSourceStatus(error);
        const explicit = error.status !== undefined || error.statusCode !== undefined || error.status_code !== undefined || error.code === 'rate_limited';
        if ((received && error.code !== 'plugin_source_error') || (!received && !explicit && !(error instanceof TypeError)) || !transient.has(status) || attempt >= Math.min(maxRetries, 2)) throw error;
        const delay = Math.min(retryMaxMs, retryMinMs * 2 ** attempt);
        event('source_retry', { attempt: attempt + 1, delay_ms: delay, status });
        await wait(delay, callSignal);
      }
    }
  };

  async function request(path, method = 'GET', body, { allowExpired = false, claimToken } = {}) {
    for (let attempt = 0;; attempt++) {
      try {
        return await bounded(async requestSignal => {
          const response = await fetchImpl(new URL(prefix + path, base), {
            method, redirect: 'error', headers: { Authorization: `Bearer ${credential}`, 'X-Notion-Relay-Id': relayId, ...(claimToken ? { 'X-Notion-Claim-Token': claimToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal,
          });
          if (allowExpired && response.status === 404) { await response.body?.cancel(); return { expired: true }; }
          if (!response.ok) {
            const retryAfter = response.headers.get('retry-after'); await response.body?.cancel();
            const err = failure('relay_http_error', response.status);
            if (retryAfter) err.retryMs = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
            throw err;
          }
          return jsonResponse(response, maxResponseBytes);
        }, runSignal, requestTimeoutMs);
      } catch (error) {
        if (runSignal.aborted) throw runSignal.reason || abortError();
        const retryable = transient.has(error.status) || error.code === 'plugin_operation_timeout' || error instanceof TypeError;
        if (!retryable || attempt >= maxRetries) throw error;
        const delay = Math.min(retryMaxMs, Math.max(retryMinMs * 2 ** attempt, Number.isFinite(error.retryMs) ? error.retryMs : 0));
        event('retry', { attempt: attempt + 1, delay_ms: delay, status: error.status || null });
        await wait(delay, runSignal);
      }
    }
  }

  async function verifiedIdentity(callSignal) {
    const identity = await invoke('get_self', {}, callSignal), key = identityKey(identity);
    if (boundIdentity && key !== boundIdentity) throw failure('plugin_account_mismatch', 403);
    return identity;
  }

  async function dispatch(item, callSignal) {
    if (!item || typeof item.id !== 'string' || !uuid(item.id) || !allowed.has(item.operation) || !item.args || typeof item.args !== 'object' || Array.isArray(item.args)) throw failure('plugin_operation_denied', 403);
    const args = item.args;
    await verifiedIdentity(callSignal);
    let result;
    if (item.operation === 'search') {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 2000) throw failure('invalid_plugin_request', 400);
      const access = await invoke('get_tool_access', {}, callSignal);
      if (!access.current_tool_access || !access.current_tool_access.ai_search?.status) throw failure('invalid_plugin_access', 502);
      const searchArgs = { query: args.query, page_size: Math.min(100, Math.max(1, Number(args.page_size) || 20)) };
      if (contentSearch) result = decode(await contentSearch(searchArgs, access, { signal: callSignal }));
      else {
        const name = access.current_tool_access.ai_search.status === 'available' ? 'ai_search' : 'search';
        if (!['available', 'available_with_limit'].includes(access.current_tool_access[name]?.status)) throw failure('plugin_tool_unavailable', 403);
        result = await invoke(name, searchArgs, callSignal);
      }
    } else if (item.operation === 'query_rows') {
      if (typeof args.data_source_url !== 'string' || !/^collection:\/\/[a-f\d-]+$/i.test(args.data_source_url) || !uuid(args.data_source_url.slice(13))) throw failure('invalid_plugin_request', 400);
      await invoke('fetch', { id: args.data_source_url }, callSignal);
      result = await invoke('query_data_sources', { data: { mode: 'rows', data_source_url: args.data_source_url, limit: Math.min(100, Math.max(1, Number(args.limit) || 100)) } }, callSignal);
    } else if (item.operation === 'fetch') {
      if (typeof args.id !== 'string' || !args.id || args.id.length > 2048) throw failure('invalid_plugin_request', 400);
      result = await invoke('fetch', { id: args.id }, callSignal);
    } else {
      if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 8192)) throw failure('invalid_plugin_request', 400);
      result = await invoke(item.operation, { limit: Math.min(200, Math.max(1, Number(args.limit) || 100)), ...(args.cursor ? { cursor: args.cursor } : {}) }, callSignal);
    }
    // An account switch during the upstream read must not publish that account's data.
    await verifiedIdentity(callSignal);
    return result;
  }

  async function handle(item) {
    let result;
    try { result = await bounded(callSignal => dispatch(item, callSignal), runSignal, operationTimeoutMs); }
    catch (error) {
      if (runSignal.aborted) throw error;
      if (['plugin_account_mismatch', 'invalid_plugin_identity', 'plugin_operation_timeout'].includes(error.code)) throw error;
      const status = pluginSourceStatus(error);
      const code = ['plugin_operation_denied', 'invalid_plugin_request', 'invalid_plugin_access', 'plugin_tool_unavailable', 'invalid_plugin_result', 'plugin_result_too_large'].includes(error.code) ? error.code : 'plugin_source_error';
      result = { error: code, status }; stats.failed++;
    }
    runSignal.throwIfAborted();
    await request(`/requests/${encodeURIComponent(item.id)}`, 'POST', result, { allowExpired: true, claimToken: item.claim_token });
    stats.completed++; finished.set(item.id, Date.now()); event('request_completed', { operation: item.operation, failed: Boolean(result.error) });
  }

  try {
    const initial = await bounded(async callSignal => {
      const identity = await verifiedIdentity(callSignal); boundIdentity = identityKey(identity);
      if (expectedIdentity && identityKey(expectedIdentity) !== boundIdentity) throw failure('plugin_account_mismatch', 403);
      const access = await invoke('get_tool_access', {}, callSignal);
      if (!access.current_tool_access || typeof access.current_tool_access !== 'object') throw failure('invalid_plugin_access');
      return identity;
    }, runSignal, operationTimeoutMs);
    await request('/heartbeat', 'POST', { identity: initial, relay_id: relayId }); connected = true; event('online');
    heartbeatTask = (async () => {
      while (!runSignal.aborted) {
        await wait(heartbeatMs, runSignal);
        const identity = await bounded(verifiedIdentity, runSignal, operationTimeoutMs);
        await request('/heartbeat', 'POST', { identity, relay_id: relayId }); event('heartbeat');
      }
    })().catch(fail);
    while (!runSignal.aborted) {
      if (inFlight.size < concurrency) {
        const payload = await request('/requests');
        if (!Array.isArray(payload?.requests) || payload.requests.length > 40) throw failure('invalid_relay_response');
        for (const item of payload.requests) {
          if (!item || !uuid(item.id)) throw failure('invalid_relay_request');
          if (inFlight.size >= concurrency) break;
          if (inFlight.has(item.id) || finished.has(item.id)) continue;
          const task = handle(item).catch(fail).finally(() => inFlight.delete(item.id)); inFlight.set(item.id, task);
        }
      }
      for (const [id, time] of finished) if (Date.now() - time > 300_000 || finished.size > 1000) finished.delete(id);
      await wait(pollMs, runSignal);
    }
  } catch (error) { if (!signal?.aborted && !fatal) fatal = error; }
  finally {
    stop.abort(fatal || abortError());
    await Promise.allSettled([heartbeatTask, ...inFlight.values()]);
    if (connected) {
      try { await bounded(async cleanupSignal => {
        const response = await fetchImpl(new URL(prefix + '/offline', base), { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${credential}`, 'X-Notion-Relay-Id': relayId, 'Content-Type': 'application/json' }, body: JSON.stringify({ relay_id: relayId }), signal: cleanupSignal });
        await response.body?.cancel();
      }, undefined, Math.min(requestTimeoutMs, 2000)); } catch { /* The server lease also expires without heartbeats. */ }
    }
    event('offline');
  }
  if (fatal) throw fatal;
  return stats;
}
