// Agent-side bridge utility. Credentials stay in private data/, never stdout or source archives.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './security.js';
import { Store } from './store.js';
import { Notion } from './notion.js';
import { WorkspaceSearch } from './search.js';
import { PluginBridge, pluginDocument } from './plugin.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

process.umask(0o077);
const cfg = config(), store = new Store(cfg.dbPath, cfg.encryptionKey), notion = new Notion(store, cfg);
notion.pluginBridge = new PluginBridge(store);
const search = new WorkspaceSearch(store, notion, cfg); notion.searchEngine = search;
const statePath = './data/plugin-session.json';
const input = async () => { let text = ''; for await (const part of process.stdin) text += part; return JSON.parse(text); };
const action = process.argv[2];
let state; try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
try {
  if (action === 'setup') {
    const identity = await input();
    if (state && (state.identity.workspace.id !== identity.workspace.id || state.identity.user.id !== identity.user.id)) throw new Error('Existing relay state belongs to a different plugin account. Use a separate data directory.');
    if (!state) {
      const provisioned = store.provision(identity.workspace.name + ' — plugin source');
      const connection = notion.pluginBridge.bind(provisioned.tenant_id, identity);
      const agent = store.issueKey(provisioned.tenant_id, connection.connection_id, 'read', 'Notion plugin search agent');
      state = { tenant_id: provisioned.tenant_id, connection_id: connection.connection_id, management_key: provisioned.key, agent_key: agent.key, identity };
      mkdirSync('./data', { recursive: true, mode: 0o700 }); writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    }
    const key = { tenant_id: state.tenant_id, connection_id: state.connection_id };
    search.enqueue(key);
    output({ provider: 'plugin', connection_id: state.connection_id, workspace: state.identity.workspace.name, status: search.status(key) });
  } else {
    if (!state) throw new Error('Plugin relay is not set up.');
    const key = { ...store.authenticate(state.management_key, true), connection_id: state.connection_id };
    if (action === 'heartbeat') { notion.pluginBridge.heartbeat(key, await input()); output({ online: true }); }
    else if (action === 'offline') {
      notion.pluginBridge.offline(key);
      output({ online: false });
    } else if (action === 'pending') output({ requests: notion.pluginBridge.pending(key), status: search.status(key) });
    else if (action === 'complete') { notion.pluginBridge.complete(key, process.argv[3], await input()); output({ accepted: true }); }
    else if (action === 'import') {
      const pages = await input();
      for (const page of pages) search.save(key, pluginDocument(page, page.id, page.metadata?.type === 'database' ? 'database' : 'page'));
      output({ imported: pages.length, status: search.status(key) });
    } else if (action === 'reindex') {
      const rows = store.db.prepare('SELECT * FROM search_documents WHERE connection_id=?').all(key.connection_id);
      for (const row of rows) search.save(key, { ...row, passages: JSON.parse(row.passages), warnings: JSON.parse(row.warnings), edges: store.db.prepare('SELECT target_id AS target,target_kind,relation FROM search_edges WHERE connection_id=? AND source_id=?').all(key.connection_id, row.page_id) });
      output({ reindexed: rows.length });
    } else if (action === 'status') output({ workspace: state.identity.workspace.name, connection_id: state.connection_id, status: search.status(key) });
    else if (action === 'check') {
      const args = await input(), client = new Client({ name: 'live-plugin-check', version: '0.4.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(cfg.appUrl + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + state.agent_key } } }));
        const listed = await client.listTools();
        const result = await client.callTool({ name: 'notion_get_context', arguments: { query: args.query, max_chars: 6000, max_pages: 3 } });
        if (result.isError) throw new Error(result.content[0].text);
        const evidence = JSON.parse(result.content[0].text);
        const proof = { provider: 'plugin', transport: 'real MCP HTTP', retrieved_passages: evidence.passages.length, source_urls: [...new Set(evidence.passages.map(p => p.url))], source_checked_at: evidence.passages.map(p => p.source_checked_at), read_only: listed.tools.every(t => t.annotations.readOnlyHint), tools: listed.tools.map(t => t.name), coverage: evidence.coverage };
        writeFileSync('./data/plugin-live-check.json', JSON.stringify(proof, null, 2), { mode: 0o600 }); output(proof);
      } finally { await client.close(); }
    } else throw new Error('Unknown plugin bridge action.');
  }
} finally { store.close(); }
