/** Metadata-only diagnostics; optional proof reads return counts, never source text. */
export async function diagnose(client, { query, pageId, signal } = {}) {
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, ...detail });
  let definitions, index;
  try {
    definitions = await client.listTools({ refresh: true, signal });
    record('authentication_and_discovery', 'pass', { tool_count: definitions.length });
  } catch (e) {
    record('authentication_and_discovery', 'fail', { error: e.code || 'connection_failed' });
    return { ok: false, source_verified: false, checks };
  }
  try {
    index = await client.callTool('notion_index_status', {}, { signal });
    record('index', index.indexed_documents > 0 ? 'pass' : 'warning', { state: index.state, indexed_documents: index.indexed_documents, warnings: index.warnings });
    if (index.provider === 'plugin') record('plugin_relay', index.plugin_relay_online ? 'pass' : 'fail', { online: index.plugin_relay_online });
  } catch (e) { record('index', 'fail', { error: e.code || 'index_unavailable' }); }
  let sourceVerified = false;
  if (query || pageId) {
    try {
      const result = pageId
        ? await client.callTool('notion_read_page', { page_id: pageId, max_chars: 2000 }, { signal })
        : await client.callTool('notion_get_context', { query, max_chars: 2000, max_pages: 1 }, { signal });
      const passages = result.passages || [];
      sourceVerified = passages.some(p => p.source_checked_at && p.url && p.text);
      record('live_source_read', sourceVerified ? 'pass' : 'warning', { passage_count: passages.length, coverage: result.coverage });
    } catch (e) { record('live_source_read', 'fail', { error: e.code || 'source_unavailable' }); }
  } else record('live_source_read', 'not_run', { next_step: 'Use --query or --page-id to verify a real source read.' });
  return { ok: !checks.some(c => c.status === 'fail') && (!(query || pageId) || sourceVerified), source_verified: sourceVerified, checks };
}
