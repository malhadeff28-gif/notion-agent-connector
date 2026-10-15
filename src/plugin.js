import { randomUUID } from 'node:crypto';
import { hash, Problem } from './security.js';
import { normalizeId, sourceUrl, splitPassages } from './documents.js';

const methods = new Set(['fetch', 'search', 'list_private_pages', 'list_shared_pages', 'list_recent_pages', 'query_rows']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceStatus = value => {
  const status = value?.status ?? value?.statusCode ?? value?.status_code ?? value?.error?.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  const code = typeof value?.error === 'string' ? value.error : value?.error?.code || value?.code;
  return new Map([['unauthorized', 401], ['restricted_resource', 403], ['object_not_found', 404], ['rate_limited', 429]]).get(code) || 502;
};
const sourceError = value => new Problem(sourceStatus(value), 'plugin_source_error', 'The Notion plugin could not read this source.');
export function pluginPayload(result) {
  const text = Array.isArray(result?.content) ? result.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
  let data = result?.structuredContent;
  if (data === undefined && text) {
    try { data = JSON.parse(text); } catch {
      if (result?.isError) throw sourceError(result);
      throw new Problem(502, 'invalid_plugin_result', 'Expected a structured Notion plugin result.');
    }
  }
  data ??= result;
  if (result?.isError || data?.isError || data?.error) throw sourceError(data);
  if (!object(data)) throw new Problem(502, 'invalid_plugin_result', 'Expected a structured Notion plugin result.');
  return data;
}
function sourceIdentity(data, requestedId) {
  const expected = normalizeId(requestedId), returned = normalizeId(data.id);
  // Some plugin versions omit the ID; when present it must bind the answer to the requested source.
  if (data.id !== undefined && (!returned || (expected && returned !== expected))) throw new Problem(502, 'plugin_source_mismatch', 'The Notion plugin returned a different source than requested.');
  return returned || expected;
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
  const data = pluginPayload(raw), id = sourceIdentity(data, requestedId);
  if (!id || typeof data.text !== 'string') throw new Problem(502, 'invalid_plugin_page', 'The plugin did not return readable page content.');
  const title = String(data.title || 'Untitled'), text = data.text;
  const body = text.match(/<content>\n?([\s\S]*)\n?<\/content>/)?.[1] ?? text;
  const props = text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1] || '';
  const parent = reference(text.match(/<parent-page\s+url="([^"]+)"/)?.[1]);
  const edges = [], discovered = [], warnings = ['plugin_discovery_is_partial', 'plugin_requires_active_agent_relay'];
  if (data.truncated || data.unknown_block_count) warnings.push('plugin_source_truncated_or_unknown_blocks');
  if (props.length + body.length + 1 > 1_500_000) warnings.push('extracted_text_limit');
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
    const columns = this.db.prepare('PRAGMA table_info(plugin_requests)').all();
    for (const [name, type] of [['relay_id', 'TEXT'], ['claim_token', 'TEXT'], ['claim_expires', 'INTEGER']]) {
      if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE plugin_requests ADD COLUMN ${name} ${type}`);
    }
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
    // Include leased requests so callers fail promptly even while their relay was reading a source.
    this.db.prepare("UPDATE plugin_requests SET state='complete',reply=? WHERE connection_id=? AND state='pending'").run(JSON.stringify({ error: 'plugin_relay_offline', status: 503 }), key.connection_id);
  }
  async call(key, operation, args = {}) {
    this.store.connection(key.tenant_id, key.connection_id);
    if (!methods.has(operation)) throw new Problem(403, 'plugin_operation_denied', 'Unsupported plugin operation.');
    if (!this.online(key)) throw new Problem(503, 'plugin_relay_offline', 'An agent with this Notion plugin connection must run the relay to fetch or verify current sources.');
    if (this.db.prepare("SELECT count(*) n FROM plugin_requests WHERE connection_id=? AND state='pending'").get(key.connection_id).n >= 40) throw new Problem(429, 'plugin_relay_busy', 'Too many pending plugin requests.');
    const id = randomUUID();
    this.db.prepare('DELETE FROM plugin_requests WHERE created<?').run(Date.now() - 300_000);
    this.db.prepare("INSERT INTO plugin_requests(id,connection_id,operation,args,state,reply,created) VALUES(?,?,?,?,'pending',NULL,?)").run(id, key.connection_id, operation, JSON.stringify(args), Date.now());
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        this.store.connection(key.tenant_id, key.connection_id);
        const row = this.db.prepare('SELECT state,reply FROM plugin_requests WHERE id=?').get(id);
        if (!row) throw new Problem(503, 'plugin_request_expired', 'Plugin request expired.');
        if (row.state === 'complete') {
          const result = JSON.parse(row.reply);
          if (result.error) throw new Problem(sourceStatus(result), typeof result.error === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(result.error) ? result.error : 'plugin_source_error', 'The plugin could not read this source.');
          return result;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Problem(503, 'plugin_relay_timeout', 'The Notion plugin relay did not answer.');
    } finally { this.db.prepare('DELETE FROM plugin_requests WHERE id=?').run(id); }
  }
  pending(key, relayId) {
    this.store.connection(key.tenant_id, key.connection_id);
    if (!relayId) return this.db.prepare("SELECT id,operation,args FROM plugin_requests WHERE connection_id=? AND state='pending' AND claim_token IS NULL ORDER BY created LIMIT 10").all(key.connection_id).map(r => ({ ...r, args: JSON.parse(r.args) }));
    if (typeof relayId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(relayId)) throw new Problem(400, 'invalid_relay_id', 'Supply a valid relay instance ID.');
    // One atomic UPDATE prevents competing pollers from claiming the same source read.
    const now = Date.now(), claimToken = randomUUID();
    const rows = this.db.prepare("UPDATE plugin_requests SET relay_id=?,claim_token=?,claim_expires=? WHERE id IN (SELECT id FROM plugin_requests WHERE connection_id=? AND state='pending' AND (claim_token IS NULL OR claim_expires<=?) ORDER BY created LIMIT 1) RETURNING id,operation,args,claim_token,claim_expires").all(relayId, claimToken, now + 55_000, key.connection_id, now);
    return rows.map(r => ({ ...r, args: JSON.parse(r.args) }));
  }
  complete(key, id, result, claimToken) {
    this.store.connection(key.tenant_id, key.connection_id);
    if (!object(result)) throw new Problem(400, 'invalid_plugin_result', 'A plugin reply must be a structured object.');
    if (Buffer.byteLength(JSON.stringify(result)) > 2_000_000) throw new Problem(413, 'plugin_result_too_large', 'The plugin reply exceeds the maximum size.');
    if (claimToken !== undefined && (typeof claimToken !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(claimToken))) throw new Problem(400, 'invalid_claim_token', 'Supply a valid request claim token.');
    const changed = this.db.prepare("UPDATE plugin_requests SET state='complete',reply=? WHERE id=? AND connection_id=? AND state='pending' AND ((claim_token IS NULL AND ? IS NULL) OR (claim_token=? AND claim_expires>?))").run(JSON.stringify(result), id, key.connection_id, claimToken ?? null, claimToken ?? null, Date.now());
    if (!changed.changes) throw new Problem(404, 'plugin_request_not_found', 'Plugin request is no longer pending.');
  }
  async document(key, id, kind = 'page') { return pluginDocument(await this.call(key, 'fetch', { id: kind === 'data_source' ? 'collection://' + id : id }), id, kind); }
  async request(key, path, method, body = {}) {
    if (path === '/search') {
      if (body.query) {
        const data = pluginPayload(await this.call(key, 'search', { query: body.query, page_size: body.page_size || 20 }));
        if (!Array.isArray(data.results)) throw new Problem(502, 'invalid_plugin_result', 'The plugin did not return a search result list.');
        const results = []; let excludedExternalSources = 0;
        for (const result of data.results) {
          // Notion AI can also search Mail, Slack, and Calendar. This connection
          // authorizes Notion resources only; a UUID alone does not prove origin.
          const ref = object(result) && reference(result.url);
          if (!ref?.id) { excludedExternalSources++; continue; }
          results.push({ ...result, id: ref.id, object: ref.kind === 'data_source' ? 'data_source' : result.type === 'database' ? 'database' : 'page' });
        }
        return { results, has_more: false, next_cursor: null, excluded_external_sources: excludedExternalSources };
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
      if (ref) {
        const data = pluginPayload(await this.call(key, 'fetch', { id: ref[1] === 'data_sources' ? 'collection://' + ref[2] : ref[2] }));
        sourceIdentity(data, ref[2]);
        return data;
      }
    }
    throw new Problem(403, 'plugin_read_only_adapter', 'Use the native Notion plugin for this operation; the search-layer plugin adapter is read-only.');
  }
}
