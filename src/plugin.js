import { randomUUID } from 'node:crypto';
import { hash, Problem } from './security.js';
import { normalizeId, sourceUrl, splitPassages } from './documents.js';

const methods = new Set(['fetch', 'search', 'list_private_pages', 'list_shared_pages', 'list_recent_pages', 'query_rows']);
export function pluginPayload(result) {
  if (result?.isError) throw new Problem(502, 'plugin_source_error', 'The Notion plugin could not read this source.');
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (text) { try { return JSON.parse(text); } catch { throw new Problem(502, 'invalid_plugin_result', 'Expected a structured Notion plugin result.'); } }
  return result;
}
function reference(value) {
  const clean = String(value || '').replace(/^\{\{|\}\}$/g, '');
  if (clean.startsWith('collection://')) return { id: normalizeId(clean.slice(13)), kind: 'data_source' };
  try {
    const u = new URL(clean);
    if (!['app.notion.com', 'notion.so', 'www.notion.so', 'www.notion.com'].includes(u.hostname) && !u.hostname.endsWith('.notion.site')) return null;
    const id = normalizeId(u.pathname.match(/([a-f0-9]{32}|[a-f0-9-]{36})\/?$/i)?.[1]);
    return id ? { id, kind: 'page' } : null;
  } catch { return null; }
}
/** Preserve actual enhanced-Markdown extracts and page citations; never invent block IDs. */
export function pluginDocument(raw, requestedId, kind = 'page') {
  const data = pluginPayload(raw), id = normalizeId(data.id) || normalizeId(requestedId);
  if (!id || typeof data.text !== 'string') throw new Problem(502, 'invalid_plugin_page', 'The plugin did not return readable page content.');
  const title = String(data.title || 'Untitled'), text = data.text;
  const body = text.match(/<content>\n?([\s\S]*)\n?<\/content>/)?.[1] ?? text;
  const props = text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1] || '';
  const parent = reference(text.match(/<parent-page\s+url="([^"]+)"/)?.[1]);
  const edges = [], discovered = [], warnings = ['plugin_discovery_is_partial', 'plugin_requires_active_agent_relay'];
  if (data.truncated || data.unknown_block_count) warnings.push('plugin_source_truncated_or_unknown_blocks');
  if (/<(?:pdf|file|audio|video|embed|unknown)\b/.test(body)) warnings.push('attachment_or_embed_text_not_extracted');
  if (data.metadata?.type) kind = data.metadata.type === 'dataSource' ? 'data_source' : data.metadata.type === 'database' ? 'database' : kind;
  for (const match of text.matchAll(/<(page|mention-page|parent-page|database|mention-database|data-source|mention-data-source|folder)\b[^>]*\burl="([^"]+)"/g)) {
    const ref = reference(match[2]); if (!ref?.id || ref.id === id) continue;
    if (match[1].includes('database')) ref.kind = 'database';
    edges.push({ target: ref.id, target_kind: ref.kind, relation: match[1] === 'page' || match[1] === 'database' || match[1] === 'data-source' ? 'contains' : match[1] === 'parent-page' ? 'parent' : 'mention' });
    // Navigation stays bounded to actual child pages/data sources. Mentions are graph edges, not an unbounded crawl.
    if (['page', 'database', 'data-source'].includes(match[1])) discovered.push(ref);
  }
  if (parent) edges.push({ target: parent.id, target_kind: parent.kind, relation: 'parent' });
  const passages = [], sections = []; let heading = '', lines = [];
  const flush = () => { if (lines.join('\n').trim()) sections.push({ heading, text: lines.join('\n') }); lines = []; };
  for (const line of (props + '\n' + body).slice(0, 1_500_000).split('\n')) {
    const h = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (h) { flush(); heading = h[2].replace(/\s*\{[^}]*\}\s*$/, ''); }
    lines.push(line);
  }
  flush();
  for (const section of sections) for (const p of splitPassages(section.text)) passages.push({ block_id: id, type: 'plugin_markdown', heading: section.heading, text: p.text, start: p.start, end: p.end, source_hash: hash(section.text) });
  if (!passages.length) passages.push({ block_id: id, type: 'plugin_markdown', heading: '', text: title, start: 0, end: title.length, source_hash: hash(title) });
  return { page_id: id, kind, title, parent_id: parent?.id || null, url: sourceUrl(id), edited_at: data.page_last_edited_at || null, created_at: null,
    metadata_hash: hash(JSON.stringify({ title, body, props })), passages, edges, discovered, warnings: [...new Set(warnings)], block_count: null };
}

/** Agent-mediated RPC. The plugin owns authentication; the server never receives its credentials. */
export class PluginBridge {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_relays(connection_id TEXT PRIMARY KEY REFERENCES connections(id),workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,heartbeat INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS plugin_requests(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES connections(id),operation TEXT NOT NULL,args TEXT NOT NULL,state TEXT NOT NULL,reply TEXT,created INTEGER NOT NULL);
    `);
  }
  online(key) {
    return Boolean(this.db.prepare('SELECT heartbeat FROM plugin_relays WHERE connection_id=?').get(key.connection_id)?.heartbeat > Date.now() - 90_000);
  }
  bind(tenantId, identity) {
    const workspaceId = normalizeId(identity.workspace?.id), userId = normalizeId(identity.user?.id);
    if (!workspaceId || !userId) throw new Problem(400, 'invalid_plugin_identity', 'Supply the workspace and user returned by Notion get_self.');
    const prior = this.db.prepare("SELECT c.id FROM connections c JOIN plugin_relays r ON r.connection_id=c.id WHERE c.tenant_id=? AND c.active=1 AND c.provider='plugin' AND r.workspace_id=? AND r.user_id=?").get(tenantId, workspaceId, userId);
    if (prior) return { connection_id: prior.id, workspace_id: workspaceId, provider: 'plugin' };
    const id = randomUUID();
    this.db.prepare("INSERT INTO connections(id,tenant_id,workspace_id,workspace_name,tokens,provider) VALUES(?,?,?,?,?,'plugin')").run(id, tenantId, workspaceId, identity.workspace.name || 'Notion workspace', '');
    this.db.prepare('INSERT INTO plugin_relays VALUES(?,?,?,0)').run(id, workspaceId, userId);
    return { connection_id: id, workspace_id: workspaceId, provider: 'plugin' };
  }
  heartbeat(key, identity) {
    this.store.connection(key.tenant_id, key.connection_id);
    const relay = this.db.prepare('SELECT * FROM plugin_relays WHERE connection_id=?').get(key.connection_id);
    if (!relay || normalizeId(identity.workspace?.id) !== relay.workspace_id || normalizeId(identity.user?.id) !== relay.user_id) throw new Problem(403, 'plugin_account_mismatch', 'The active Notion plugin account does not match this connection.');
    this.db.prepare('UPDATE plugin_relays SET heartbeat=? WHERE connection_id=?').run(Date.now(), key.connection_id);
  }
  offline(key) {
    this.store.connection(key.tenant_id, key.connection_id);
    this.db.prepare('UPDATE plugin_relays SET heartbeat=0 WHERE connection_id=?').run(key.connection_id);
    for (const r of this.pending(key)) this.complete(key, r.id, { error: 'plugin_relay_offline', status: 503 });
  }
  async call(key, operation, args = {}) {
    this.store.connection(key.tenant_id, key.connection_id);
    if (!methods.has(operation)) throw new Problem(403, 'plugin_operation_denied', 'Unsupported plugin operation.');
    if (!this.online(key)) throw new Problem(503, 'plugin_relay_offline', 'An agent with this Notion plugin connection must run the relay to fetch or verify current sources.');
    if (this.db.prepare("SELECT count(*) n FROM plugin_requests WHERE connection_id=? AND state='pending'").get(key.connection_id).n >= 40) throw new Problem(429, 'plugin_relay_busy', 'Too many pending plugin requests.');
    const id = randomUUID();
    this.db.prepare('DELETE FROM plugin_requests WHERE created<?').run(Date.now() - 300_000);
    this.db.prepare("INSERT INTO plugin_requests VALUES(?,?,?,?,'pending',NULL,?)").run(id, key.connection_id, operation, JSON.stringify(args), Date.now());
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        this.store.connection(key.tenant_id, key.connection_id);
        const row = this.db.prepare('SELECT state,reply FROM plugin_requests WHERE id=?').get(id);
        if (!row) throw new Problem(503, 'plugin_request_expired', 'Plugin request expired.');
        if (row.state === 'complete') {
          const result = JSON.parse(row.reply);
          if (result.error) throw new Problem(result.status || 502, result.error, 'The plugin could not read this source.');
          return result;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Problem(503, 'plugin_relay_timeout', 'The Notion plugin relay did not answer.');
    } finally { this.db.prepare('DELETE FROM plugin_requests WHERE id=?').run(id); }
  }
  pending(key) {
    this.store.connection(key.tenant_id, key.connection_id);
    return this.db.prepare("SELECT id,operation,args FROM plugin_requests WHERE connection_id=? AND state='pending' ORDER BY created LIMIT 10").all(key.connection_id).map(r => ({ ...r, args: JSON.parse(r.args) }));
  }
  complete(key, id, result) {
    this.store.connection(key.tenant_id, key.connection_id);
    const changed = this.db.prepare("UPDATE plugin_requests SET state='complete',reply=? WHERE id=? AND connection_id=? AND state='pending'").run(JSON.stringify(result), id, key.connection_id);
    if (!changed.changes) throw new Problem(404, 'plugin_request_not_found', 'Plugin request is no longer pending.');
  }
  async document(key, id, kind = 'page') { return pluginDocument(await this.call(key, 'fetch', { id: kind === 'data_source' ? 'collection://' + id : id }), id, kind); }
  async request(key, path, method, body = {}) {
    if (path === '/search') {
      if (body.query) {
        const data = pluginPayload(await this.call(key, 'search', { query: body.query, page_size: body.page_size || 20 }));
        return { results: (data.results || []).map(r => ({ ...r, id: reference(r.url)?.id || normalizeId(r.id), object: r.type === 'database' ? 'database' : 'page' })), has_more: false, next_cursor: null };
      }
      let cursor = body.start_cursor ? JSON.parse(Buffer.from(body.start_cursor, 'base64url')) : { stage: 0 };
      const ops = ['list_private_pages', 'list_shared_pages', 'list_recent_pages'];
      const data = pluginPayload(await this.call(key, ops[cursor.stage], { limit: 100, ...(cursor.cursor ? { cursor: cursor.cursor } : {}) }));
      const next = data.nextCursor ? { stage: cursor.stage, cursor: data.nextCursor } : cursor.stage < 2 ? { stage: cursor.stage + 1 } : null;
      return { results: (data.results || []).map(r => ({ ...r, id: reference(r.url)?.id, object: r.type === 'database' ? 'database' : 'page' })).filter(r => r.id), has_more: Boolean(next), next_cursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null };
    }
    const query = path.match(/^\/data_sources\/([^/]+)\/query$/);
    if (query && method === 'POST') {
      if (body.start_cursor) throw new Problem(400, 'plugin_rows_cursor_unavailable', 'Plugin row discovery has a bounded page; use native plugin views for additional rows.');
      const data = pluginPayload(await this.call(key, 'query_rows', { data_source_url: 'collection://' + query[1], limit: 100 }));
      return { results: (data.results || []).map(r => ({ ...r, id: reference(r.url)?.id, object: 'page' })).filter(r => r.id), has_more: false, next_cursor: null, plugin_more_rows: Boolean(data.has_more) };
    }
    if (method === 'GET') {
      const ref = path.match(/^\/(pages|databases|data_sources)\/([^/?]+)$/);
      if (ref) return pluginPayload(await this.call(key, 'fetch', { id: ref[1] === 'data_sources' ? 'collection://' + ref[2] : ref[2] }));
    }
    throw new Problem(403, 'plugin_read_only_adapter', 'Use the native Notion plugin for this operation; the search-layer plugin adapter is read-only.');
  }
}
