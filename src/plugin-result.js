/** Decode data returned by a host's connected Notion MCP tools. Never execute source text. */
export class PluginResultError extends Error {
  constructor(code = 'invalid_plugin_result', status = 502) {
    super(code === 'plugin_source_error' ? 'The Notion plugin could not read this source.' : 'Expected a structured Notion plugin result.');
    this.name = 'PluginResultError'; this.code = code; this.status = status;
  }
}

export function pluginSourceStatus(value) {
  // Only explicit machine-readable statuses can prove revocation. Do not infer
  // access loss by matching arbitrary page text or provider error prose.
  const status = value?.status ?? value?.statusCode ?? value?.status_code ?? value?.error?.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  const code = typeof value?.error === 'string' ? value.error : value?.error?.code || value?.code;
  return new Map([['unauthorized', 401], ['restricted_resource', 403], ['object_not_found', 404], ['rate_limited', 429]]).get(code) || 502;
}
const sourceError = value => new PluginResultError('plugin_source_error', pluginSourceStatus(value));

export function decodePluginResult(raw, { maxBytes = 2_000_000 } = {}) {
  let value = raw;
  const contentText = content => {
    const blocks = content.filter(c => c?.type === 'text' && typeof c.text === 'string');
    if (blocks.reduce((total, block) => total + Buffer.byteLength(block.text, 'utf8') + 1, 0) > maxBytes) throw new PluginResultError('plugin_result_too_large', 502);
    return blocks.map(c => c.text).join('\n');
  };
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new PluginResultError('plugin_result_too_large', 502);
      try { value = JSON.parse(value); } catch { throw new PluginResultError(); }
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginResultError();
    if (value.isError) {
      if (value.structuredContent) throw sourceError(value.structuredContent);
      try {
        const text = Array.isArray(value.content) ? contentText(value.content) : '';
        if (text) { const data = JSON.parse(text); throw sourceError(data); }
      } catch (error) { if (error instanceof PluginResultError) throw error; }
      throw sourceError(value);
    }
    if (value.structuredContent !== undefined) { value = value.structuredContent; continue; }
    // Only MCP content arrays are envelopes. A page's own string content stays data.
    if (Array.isArray(value.content)) {
      if (!value.content.length || value.content.some(item => item?.type !== 'text' || typeof item.text !== 'string')) throw new PluginResultError();
      value = contentText(value.content);
      continue;
    }
    let encoded;
    try { encoded = JSON.stringify(value); } catch { throw new PluginResultError(); }
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new PluginResultError('plugin_result_too_large', 502);
    if (value.error) throw sourceError(value);
    return value;
  }
  throw new PluginResultError();
}
