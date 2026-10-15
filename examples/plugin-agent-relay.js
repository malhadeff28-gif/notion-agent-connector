// Run inside an agent host that can call the user's connected Notion plugin.
// callNotion(name,args) must invoke that plugin's actual tools, not a REST token.
// It returns the MCP tool result or its decoded structured value.
const decode = r => {
  if (r?.isError) throw new Error('Notion plugin source unavailable.');
  if (r?.structuredContent) return r.structuredContent;
  if (r?.content) return JSON.parse(r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  return r;
};
export async function runPluginRelay({ baseUrl, managementKey, connectionId, callNotion, contentSearch, signal }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Use HTTPS for remote relays.');
  const request = async (path, method = 'GET', body) => {
    const r = await fetch(new URL(path, base), { method, headers: { Authorization: 'Bearer ' + managementKey, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
    const data = await r.json(); if (!r.ok) throw new Error(data.message); return data;
  };
  const prefix = '/v1/plugin/' + connectionId;
  let lastHeartbeat = 0;
  const access = decode(await callNotion('get_tool_access', {}));
  try {
    while (!signal?.aborted) {
      if (Date.now() - lastHeartbeat > 30_000) {
        const identity = decode(await callNotion('get_self', {}));
        await request(prefix + '/heartbeat', 'POST', { identity }); lastHeartbeat = Date.now();
      }
      const { requests } = await request(prefix + '/requests');
      for (const r of requests) {
        let result;
        try {
          if (r.operation === 'fetch') result = decode(await callNotion('fetch', r.args));
          else if (['list_private_pages', 'list_shared_pages', 'list_recent_pages'].includes(r.operation)) result = decode(await callNotion(r.operation, r.args));
          else if (r.operation === 'query_rows') {
            await callNotion('fetch', { id: r.args.data_source_url });
            result = decode(await callNotion('query_data_sources', { data: { mode: 'rows', ...r.args } }));
          } else if (r.operation === 'search') {
            if (contentSearch) result = decode(await contentSearch(r.args, access));
            else if (access.current_tool_access?.ai_search?.status === 'available') throw new Error('Host must supply contentSearch using the entitled AI search tool.');
            else result = decode(await callNotion('search', r.args));
          } else throw new Error('Operation is not allowed.');
        } catch { result = { error: 'plugin_source_error', status: 502 }; }
        await request(prefix + '/requests/' + r.id, 'POST', result);
      }
      if (!requests.length) await new Promise(resolve => setTimeout(resolve, 600));
    }
  } finally {
    // Use an independent request so an aborted work signal does not block cleanup.
    await fetch(new URL(prefix + '/offline', base), { method: 'POST', headers: { Authorization: 'Bearer ' + managementKey } }).catch(() => {});
  }
}
