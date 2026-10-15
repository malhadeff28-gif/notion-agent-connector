import { createServer as httpServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, hostHeaderValidation } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { createServer, createToolRunner } from './tools.js';
import { Problem, hash } from './security.js';
import { WorkspaceSearch } from './search.js';
import { readFileSync } from 'node:fs';
import { PluginBridge } from './plugin.js';

const bearer = req => /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1] || '';
const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const parse = async (req, maximum = 256_000) => {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Problem(415, 'json_required', 'Use application/json.');
  let body = '', length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > maximum) throw new Problem(413, 'body_too_large', 'Request too large.'); body += chunk; }
  try { return JSON.parse(body); } catch { throw new Problem(400, 'invalid_json', 'Invalid JSON.'); }
};
const validate = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new Problem(400, 'invalid_arguments', 'Invalid arguments.');
  return result.data;
};
const stateCookie = (config, state, browser, expired = false) => 'nc_oauth_' + hash(state).slice(0, 24) + '=' + browser + '; Path=/oauth/notion; HttpOnly; SameSite=Lax; Max-Age=' + (expired ? 0 : 600) + (config.appUrl.startsWith('https:') ? '; Secure' : '');

export function createApp(store, notion, config) {
  notion.pluginBridge ||= new PluginBridge(store);
  const search = notion.searchEngine || new WorkspaceSearch(store, notion, config);
  notion.searchEngine = search;
  const validateHost = hostHeaderValidation([new URL(config.appUrl).hostname]);
  const mcp = createMcpHandler(({ authInfo }) => createServer(store, notion, authInfo.extra.key), { maxRequestBodySize: 256_000 });
  const nodeMcp = toNodeHandler(mcp, { maxRequestBodySize: 256_000 });
  // Single-process limits supplement a production ingress/WAF; no request content is retained.
  const windows = new Map();
  const limit = req => {
    const supplied = bearer(req);
    const known = supplied && store.db.prepare('SELECT id,role FROM keys WHERE digest=? AND active=1').get(hash(supplied));
    const now = Date.now(), subject = known ? known.id : req.socket.remoteAddress || 'anonymous';
    if (windows.size > 10_000) for (const [id, entry] of windows) if (now - entry.start > 60_000) windows.delete(id);
    const prior = windows.get(subject);
    const entry = !prior || now - prior.start > 60_000 ? { start: now, count: 0 } : prior;
    entry.count++; windows.set(subject, entry);
    const cap = req.url.startsWith('/v1/plugin/') && known?.role === 'manage' ? 600 : 120;
    if (entry.count > cap) throw new Problem(429, 'rate_limited', 'Too many requests. Retry in a minute.');
  };
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!validateHost(req, res)) return;
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) throw new Problem(403, 'origin_denied', 'Origin not allowed.');
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id' }); res.end(); return; }
      limit(req);
      const url = new URL(req.url, config.appUrl), path = url.pathname;
      if (path === '/llms.txt' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(readFileSync(new URL('../public/llms.txt', import.meta.url))); return; }
      if (path === '/' && req.method === 'GET') return reply(res, 200, {
        service: 'notion-agent-connector', version: '0.4.0', interaction: 'agent_only',
        source_modes: ['public_notion_oauth', 'connected_notion_plugin'],
        interfaces: { mcp: '/mcp', http_tool_discovery: '/v1/tools', http_tool_call: '/v1/tools/{name}', guide: '/llms.txt' },
        authentication: 'Bearer agent key required for workspace access',
        starting_tool: 'notion_get_context', navigation_tools: ['notion_workspace_map', 'notion_related_pages', 'notion_read_page']
      });
      if (path === '/health' && req.method === 'GET') return reply(res, 200, { status: 'ok', version: '0.4.0', notion_oauth_configured: Boolean(config.clientId && config.clientSecret) });
      if (path === '/connect/notion' && req.method === 'GET') {
        const tenant = store.consumeTicket(url.searchParams.get('ticket') || '');
        const { state, browser } = store.createState(tenant);
        res.setHeader('Set-Cookie', stateCookie(config, state, browser));
        const auth = new URL(config.notionBase + '/oauth/authorize');
        auth.search = new URLSearchParams({ owner: 'user', client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', state });
        res.writeHead(302, { Location: auth.toString() }); res.end(); return;
      }
      if (path === '/oauth/notion/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state') || '';
        const name = 'nc_oauth_' + hash(state).slice(0, 24);
        const cookie = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(name + '='))?.slice(name.length + 1) || '';
        const tenant = store.consumeState(state, cookie);
        res.setHeader('Set-Cookie', stateCookie(config, state, '', true));
        if (url.searchParams.has('error')) throw new Problem(400, 'authorization_denied', 'Notion access was declined.');
        const code = url.searchParams.get('code');
        if (!code) throw new Problem(400, 'code_required', 'Authorization code missing.');
        const grant = await notion.oauth({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri });
        const connection = store.saveConnection(tenant, grant);
        if (config.autoIndex !== false) search.enqueue({ tenant_id: tenant, connection_id: connection.connection_id });
        store.log({ tenant_id: tenant }, 'connect_workspace', 'success', connection.connection_id);
        return reply(res, 200, { ...connection, status: 'connected', next_operation: 'POST /v1/keys' });
      }
      if (path === '/mcp') {
        const key = store.authenticate(bearer(req));
        req.auth = { token: 'verified', clientId: key.id, scopes: [key.role], extra: { key } };
        return await nodeMcp(req, res);
      }
      if (path === '/v1/tools' && req.method === 'GET') {
        const key = store.authenticate(bearer(req));
        return reply(res, 200, { version: '0.4.0', tools: createToolRunner(store, notion, key).definitions.map(t => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(t.schema, { io: 'input' }), read_only: !t.write })) });
      }
      if (path.startsWith('/v1/tools/') && req.method === 'POST') {
        const key = store.authenticate(bearer(req));
        return reply(res, 200, await createToolRunner(store, notion, key).run(path.slice('/v1/tools/'.length), await parse(req)));
      }
      if (path.startsWith('/v1/')) {
        const key = store.authenticate(bearer(req), true);
        if (path === '/v1/notion/connect' && req.method === 'POST') {
          if (!config.clientId || !config.clientSecret) throw new Problem(503, 'notion_not_configured', 'Add your public Notion connection credentials to the server.');
          const ticket = store.createTicket(key.tenant_id);
          return reply(res, 200, { connect_url: config.appUrl + '/connect/notion?ticket=' + ticket, expires_in: 600 });
        }
        if (path === '/v1/plugin/connect' && req.method === 'POST') {
          const body = validate(z.object({ identity: z.object({ workspace: z.object({ id: z.string().uuid(), name: z.string().optional() }), user: z.object({ id: z.string().uuid() }) }) }), await parse(req));
          const connection = notion.pluginBridge.bind(key.tenant_id, body.identity);
          search.enqueue({ ...key, connection_id: connection.connection_id });
          return reply(res, 201, connection);
        }
        if (path.startsWith('/v1/plugin/')) {
          const parts = path.split('/'), connectionId = parts[3];
          const connection = store.connection(key.tenant_id, connectionId);
          if (connection.provider !== 'plugin') throw new Problem(400, 'not_plugin_connection', 'This is not a plugin-backed connection.');
          const scoped = { ...key, connection_id: connectionId };
          if (parts[4] === 'heartbeat' && req.method === 'POST') {
            const body = validate(z.object({ identity: z.object({ workspace: z.object({ id: z.string().uuid() }), user: z.object({ id: z.string().uuid() }) }) }), await parse(req));
            notion.pluginBridge.heartbeat(scoped, body.identity); return reply(res, 200, { relay_online: true });
          }
          if (parts[4] === 'requests' && parts.length === 5 && req.method === 'GET') return reply(res, 200, { requests: notion.pluginBridge.pending(scoped) });
          if (parts[4] === 'offline' && req.method === 'POST') { notion.pluginBridge.offline(scoped); return reply(res, 200, { relay_online: false }); }
          if (parts[4] === 'requests' && parts.length === 6 && req.method === 'POST') {
            const body = await parse(req, 2_000_000); notion.pluginBridge.complete(scoped, parts[5], body); return reply(res, 200, { accepted: true });
          }
        }
        if (path === '/v1/connections' && req.method === 'GET') return reply(res, 200, { connections: store.db.prepare('SELECT id, workspace_id, workspace_name, active, provider FROM connections WHERE tenant_id=?').all(key.tenant_id) });
        if (path.startsWith('/v1/index/')) {
          const connectionId = path.split('/')[3]; store.connection(key.tenant_id, connectionId);
          const scoped = { ...key, connection_id: connectionId };
          if (path === '/v1/index/' + connectionId && req.method === 'GET') return reply(res, 200, search.status(scoped));
          if (path === '/v1/index/' + connectionId + '/sync' && req.method === 'POST') return reply(res, 202, search.enqueue(scoped));
        }
        if (path === '/v1/keys' && req.method === 'GET') return reply(res, 200, { keys: store.db.prepare('SELECT id, connection_id, role, label, active FROM keys WHERE tenant_id=?').all(key.tenant_id) });
        if (path === '/v1/keys' && req.method === 'POST') {
          const body = validate(z.object({ connection_id: z.string().uuid(), role: z.enum(['read', 'write']).default('read'), label: z.string().min(1).max(100) }), await parse(req));
          const connection = store.connection(key.tenant_id, body.connection_id);
          if (connection.provider === 'plugin' && body.role === 'write') throw new Problem(403, 'plugin_read_only_adapter', 'Plugin-backed search connections issue read-only agent keys.');
          const issued = store.issueKey(key.tenant_id, body.connection_id, body.role, body.label);
          store.log(key, 'issue_agent_key', 'success', body.connection_id);
          return reply(res, 201, issued);
        }
        if (path.startsWith('/v1/keys/') && req.method === 'DELETE') {
          const result = store.db.prepare('UPDATE keys SET active=0 WHERE id=? AND tenant_id=? AND role<>?').run(path.slice('/v1/keys/'.length), key.tenant_id, 'manage');
          if (!result.changes) throw new Problem(404, 'key_not_found', 'Agent key unavailable.');
          store.log(key, 'revoke_agent_key', 'success');
          return reply(res, 200, { revoked: true });
        }
        if (path.startsWith('/v1/connections/') && req.method === 'DELETE') {
          const row = store.connection(key.tenant_id, path.slice('/v1/connections/'.length));
          // Deny future connector requests immediately, even when upstream revoke fails.
          store.db.prepare('UPDATE connections SET active=0 WHERE id=? AND tenant_id=?').run(row.id, key.tenant_id);
          store.db.prepare('UPDATE keys SET active=0 WHERE connection_id=?').run(row.id);
          search.purgeConnection(row.id);
          if (row.provider === 'plugin') {
            store.db.prepare('DELETE FROM plugin_requests WHERE connection_id=?').run(row.id);
            store.db.prepare('DELETE FROM plugin_relays WHERE connection_id=?').run(row.id);
            store.log(key, 'disconnect_plugin_search', 'success', row.id);
            return reply(res, 200, { disconnected: true, provider: 'plugin' });
          }
          let upstreamRevoked = false;
          try { await notion.oauth({ token: store.tokens(row).access_token }, 'revoke'); upstreamRevoked = true; } catch {}
          store.db.prepare('UPDATE connections SET tokens=? WHERE id=?').run('', row.id);
          store.log(key, 'disconnect_workspace', upstreamRevoked ? 'revoked' : 'local_only', row.id);
          return reply(res, 200, { disconnected: true, notion_revoked: upstreamRevoked, ...(!upstreamRevoked ? { action_required: 'Remove this connection in Notion settings to revoke upstream access.' } : {}) });
        }
        if (path === '/v1/audit' && req.method === 'GET') return reply(res, 200, { events: store.db.prepare('SELECT key_id,connection_id,action,outcome,at FROM audit WHERE tenant_id=? ORDER BY id DESC LIMIT 100').all(key.tenant_id) });
      }
      throw new Problem(404, 'not_found', 'Route not found.');
    } catch (e) {
      if (!res.headersSent) reply(res, e instanceof Problem ? e.status : 500, { error: e.code || 'internal_error', message: e instanceof Problem ? e.message : 'The connector could not complete this request.' });
      else res.end();
    }
  };
  return { server: httpServer((req, res) => { void handler(req, res); }), closeMcp: () => mcp.close(), search };
}
