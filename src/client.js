const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A connector failure with stable fields for application-side handling. */
export class ConnectorError extends Error {
  constructor(message, { code = 'connector_error', status, retryable = false, requestId, retryAfterMs, writeOutcomeUnknown = false } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
    this.writeOutcomeUnknown = writeOutcomeUnknown;
  }
  toJSON() {
    return { error: this.code, message: this.message, ...(this.status !== undefined && { status: this.status }), retryable: this.retryable,
      ...(this.requestId && { request_id: this.requestId }), ...(this.retryAfterMs !== undefined && { retry_after_ms: this.retryAfterMs }),
      ...(this.writeOutcomeUnknown && { write_outcome_unknown: true }) };
  }
}

/** Validate the service base URL before attaching an agent credential. */
export function validateConnectorUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ConnectorError('Use an absolute connector base URL.', { code: 'invalid_url' }); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new ConnectorError('Remote connector URLs require HTTPS; HTTP is allowed only on loopback.', { code: 'insecure_url' });
  if (url.username || url.password || url.search || url.hash) throw new ConnectorError('Connector URLs must not contain credentials, a query, or a fragment.', { code: 'invalid_url' });
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new ConnectorError(`${name} must be an integer between ${min} and ${max}.`, { code: 'invalid_configuration' });
  return value;
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function retryAfter(header) {
  if (!header) return undefined;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  // Node clamps overflowing timer delays to 1ms; keep Retry-After a real wait.
  return Number.isFinite(delay) ? Math.min(2_147_483_647, Math.max(0, Math.ceil(delay))) : undefined;
}

/**
 * Framework-independent HTTP tool client. Keep the agent key in a trusted backend.
 * Only discovered read-only operations are retried. Writes always need the caller's
 * stable idempotency_key and are sent once, including after timeouts/disconnects.
 */
export class NotionConnectorClient {
  #baseUrl;
  #apiKey;
  #fetch;
  #tools;
  #timeoutMs;
  #maxRetries;
  #retryDelayMs;
  #maxResponseBytes;
  constructor({ baseUrl = 'http://127.0.0.1:3100', apiKey, timeoutMs = 30_000, maxRetries = 2, retryDelayMs = 250, maxResponseBytes = 16_000_000, fetch: fetcher = globalThis.fetch } = {}) {
    this.#baseUrl = validateConnectorUrl(baseUrl);
    if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(apiKey)) throw new ConnectorError('Provide a valid connector agent key.', { code: 'invalid_key' });
    if (typeof fetcher !== 'function') throw new ConnectorError('A fetch implementation is required.', { code: 'invalid_configuration' });
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
    this.#timeoutMs = integer(timeoutMs, 'timeoutMs', 1, 2_147_483_647);
    this.#maxRetries = integer(maxRetries, 'maxRetries', 0, 5);
    this.#retryDelayMs = integer(retryDelayMs, 'retryDelayMs', 0, 30_000);
    this.#maxResponseBytes = integer(maxResponseBytes, 'maxResponseBytes', 1024, 100_000_000);
  }

  /** Return independent copies of the scoped tools and their JSON input schemas. */
  async listTools({ refresh = false, signal, timeoutMs } = {}) {
    return this.#operation({ signal, timeoutMs }, async operation => {
      const tools = await this.#discover(operation, refresh);
      return structuredClone(tools);
    });
  }

  /** Execute one discovered tool and return its ordinary JSON result. */
  async callTool(name, args = {}, { signal, timeoutMs } = {}) {
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw new ConnectorError('Use a tool name returned by listTools().', { code: 'invalid_tool_name' });
    if (!object(args)) throw new ConnectorError('Tool arguments must be a JSON object.', { code: 'invalid_arguments' });
    let body;
    try { body = JSON.stringify(args); } catch { throw new ConnectorError('Tool arguments must be JSON serializable.', { code: 'invalid_arguments' }); }
    // Snapshot before the first await so caller mutation cannot change a retried request.
    let snapshot;
    try { snapshot = JSON.parse(body); } catch { throw new ConnectorError('Tool arguments must be JSON serializable.', { code: 'invalid_arguments' }); }
    if (!object(snapshot)) throw new ConnectorError('Tool arguments must serialize to a JSON object.', { code: 'invalid_arguments' });
    return this.#operation({ signal, timeoutMs }, async operation => {
      const tools = await this.#discover(operation);
      const tool = tools.find(candidate => candidate.name === name);
      if (!tool) throw new ConnectorError('This tool is not available to the current agent key. Refresh discovery after changing access.', { code: 'unknown_tool', status: 404 });
      if (!tool.read_only && (typeof snapshot.idempotency_key !== 'string' || snapshot.idempotency_key.length < 8 || snapshot.idempotency_key.length > 128)) {
        throw new ConnectorError('Writes require a stable idempotency_key of 8–128 characters. Reuse it only for the same intended operation and inputs.', { code: 'idempotency_key_required' });
      }
      return this.#request(`v1/tools/${name}`, { method: 'POST', body, readOnly: tool.read_only }, operation);
    });
  }

  async #discover(operation, refresh = false) {
    if (this.#tools && !refresh) return this.#tools;
    const result = await this.#request('v1/tools', { method: 'GET', readOnly: true }, operation);
    const names = new Set();
    if (!object(result) || !Array.isArray(result.tools) || !result.tools.every(tool => {
      if (!object(tool) || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || typeof tool.read_only !== 'boolean' || !object(tool.input_schema) || names.has(tool.name)) return false;
      names.add(tool.name); return true;
    })) throw new ConnectorError('The connector returned an invalid tool catalog.', { code: 'invalid_response' });
    this.#tools = result.tools;
    return this.#tools;
  }

  async #operation({ signal: callerSignal, timeoutMs = this.#timeoutMs }, work) {
    integer(timeoutMs, 'timeoutMs', 1, 2_147_483_647);
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) throw new ConnectorError('signal must be an AbortSignal.', { code: 'invalid_configuration' });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    const operation = { signal, writeSent: false };
    try {
      signal.throwIfAborted();
      return await work(operation);
    } catch (error) {
      if (signal.aborted) throw new ConnectorError(callerSignal?.aborted ? 'The connector request was cancelled.' : 'The connector request exceeded its timeout.', {
        code: callerSignal?.aborted ? 'aborted' : 'timeout', retryable: !callerSignal?.aborted && !operation.writeSent, writeOutcomeUnknown: operation.writeSent
      });
      throw error;
    } finally { clearTimeout(timer); }
  }

  async #request(path, { method, body, readOnly }, operation) {
    const { signal } = operation;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        if (!readOnly) operation.writeSent = true;
        const response = await this.#fetch(new URL(path, this.#baseUrl), {
          method, body, signal, redirect: 'manual',
          headers: { Accept: 'application/json', Authorization: `Bearer ${this.#apiKey}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) }
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new ConnectorError('The connector redirected this request. Configure its final HTTPS service URL explicitly.', { code: 'redirect_denied', status: response.status, writeOutcomeUnknown: !readOnly });
        }
        const requestId = response.headers.get('x-request-id') || undefined;
        let data;
        try { data = JSON.parse(await this.#readBody(response)); }
        catch (error) {
          if (error instanceof ConnectorError) { if (!readOnly) error.writeOutcomeUnknown = true; throw error; }
          if (!(error instanceof SyntaxError)) throw error;
          if (response.ok) throw new ConnectorError('The connector returned invalid JSON.', { code: 'invalid_response', status: response.status, requestId, writeOutcomeUnknown: !readOnly });
        }
        if (!response.ok) {
          const code = object(data) && typeof data.error === 'string' && /^[a-z0-9_]{1,80}$/.test(data.error) ? data.error : 'http_error';
          const message = object(data) && typeof data.message === 'string' ? data.message.replaceAll(this.#apiKey, '[redacted]').slice(0, 2000) : `Connector request failed with HTTP ${response.status}.`;
          throw new ConnectorError(message, { code, status: response.status, requestId, retryable: readOnly && TRANSIENT.has(response.status), retryAfterMs: retryAfter(response.headers.get('retry-after')), writeOutcomeUnknown: !readOnly && (response.status >= 500 || response.status === 408 || code === 'write_outcome_unknown') });
        }
        return data;
      } catch (cause) {
        if (signal.aborted) throw cause;
        const error = cause instanceof ConnectorError ? cause : new ConnectorError('Could not reach the connector. Check its URL and running service.', { code: 'connection_failed', retryable: readOnly, writeOutcomeUnknown: !readOnly });
        if (!readOnly || !error.retryable || attempt >= this.#maxRetries) throw error;
        const delay = error.retryAfterMs ?? Math.min(30_000, this.#retryDelayMs * 2 ** attempt);
        await pause(delay, signal);
      }
    }
  }

  async #readBody(response) {
    if (Number(response.headers.get('content-length')) > this.#maxResponseBytes) {
      await response.body?.cancel();
      throw new ConnectorError('The connector response exceeds the configured size limit.', { code: 'response_too_large', status: response.status });
    }
    if (!response.body) return '';
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.#maxResponseBytes) {
          await reader.cancel();
          throw new ConnectorError('The connector response exceeds the configured size limit.', { code: 'response_too_large', status: response.status });
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }
}
