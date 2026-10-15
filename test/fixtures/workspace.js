import { randomBytes } from 'node:crypto';
import { Store } from '../../src/store.js';
import { Notion } from '../../src/notion.js';
import { WorkspaceSearch, queryTerms } from '../../src/search.js';
import { IndexWorker } from '../../src/sync.js';
import { config } from '../../src/security.js';
import { readDocument, splitPassages, normalizeId } from '../../src/documents.js';
import { createToolRunner } from '../../src/tools.js';

const uuid = n => n.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ids = { root: uuid(1), project: uuid(2), source: uuid(3), row: uuid(4), row2: uuid(5), other: uuid(6), hidden: uuid(7), toggle: uuid(101), text: uuid(102), heading: uuid(103), table: uuid(104), tableRow: uuid(105), child: uuid(106), long: uuid(107), mention: uuid(108), pdf: uuid(109), rowText: uuid(110), second: uuid(111), otherText: uuid(112) };
const rt = text => [{ type: 'text', plain_text: text, text: { content: text } }];
const page = (id, title, parent = { type: 'workspace', workspace: true }, extra = {}) => ({ id, object: 'page', parent, created_time: '2026-10-01T00:00:00.000Z', last_edited_time: '2026-10-14T10:00:00.000Z', properties: { Name: { type: 'title', title: rt(title) }, ...extra } });
export const block = (id, type, body, more = false) => ({ id, object: 'block', type, has_children: more, [type]: typeof body === 'string' ? { rich_text: rt(body) } : body });
const list = (results, cursor = null) => ({ results, has_more: Boolean(cursor), next_cursor: cursor });
export async function setup(t) {
  const cfg = config({ ENCRYPTION_KEY: randomBytes(32).toString('base64'), NOTION_CLIENT_ID: 'test', NOTION_CLIENT_SECRET: 'test' });
  cfg.notionMinIntervalMs = 0; cfg.autoIndex = false;
  const store = new Store(':memory:', cfg.encryptionKey);
  t.after(() => store.close());
  const a = store.provision('A'), b = store.provision('B');
  const ca = store.saveConnection(a.tenant_id, { access_token: 'tokenA', workspace_id: 'A' }), cb = store.saveConnection(b.tenant_id, { access_token: 'tokenB', workspace_id: 'B' });
  const ka = store.issueKey(a.tenant_id, ca.connection_id, 'read', 'A reader');
  const kb = store.issueKey(b.tenant_id, cb.connection_id, 'read', 'B reader');
  const keyA = store.authenticate(ka.key), keyB = store.authenticate(kb.key);
  const entities = new Map([
    [ids.root, page(ids.root, 'Launch workspace')],
    [ids.project, page(ids.project, 'Planning notes', { type: 'page_id', page_id: ids.root }, { Status: { type: 'status', status: { name: 'Approved' } }, Related: { id: 'rel%3Ax', type: 'relation', relation: [{ id: ids.row }], has_more: true } })],
    [ids.source, { id: ids.source, object: 'data_source', title: rt('Project tracker'), parent: { type: 'page_id', page_id: ids.root }, last_edited_time: '2026-10-14T10:00:00.000Z', properties: { Name: { type: 'title' }, Status: { type: 'status' } } }],
    [ids.row, page(ids.row, 'Orchid launch', { type: 'data_source_id', data_source_id: ids.source }, { Status: { type: 'status', status: { name: 'Blocked' } }, Deadline: { type: 'date', date: { start: '2026-11-01' } } })],
    [ids.row2, page(ids.row2, 'Budget followup', { type: 'data_source_id', data_source_id: ids.source })],
    [ids.other, page(ids.other, 'Another customer private project')],
    [ids.hidden, page(ids.hidden, 'DO NOT EXPOSE hidden page')]
  ]);
  const blocks = new Map([
    [ids.heading, block(ids.heading, 'heading_1', 'Decision log')],
    [ids.toggle, block(ids.toggle, 'toggle', 'Hidden details', true)],
    [ids.text, block(ids.text, 'paragraph', 'The orchid rollout was approved after the reliability review. Serena owns the release checklist.')],
    [ids.table, block(ids.table, 'table', { table_width: 2 }, true)],
    [ids.tableRow, block(ids.tableRow, 'table_row', { cells: [rt('Incident owner'), rt('Marisol handles satellite escalations')] })],
    [ids.child, block(ids.child, 'child_page', { title: 'Planning notes' })],
    [ids.long, block(ids.long, 'paragraph', ('Engineering evidence number. '.repeat(180)) + 'TAIL_SENTINEL')],
    [ids.mention, block(ids.mention, 'paragraph', { rich_text: [{ type: 'mention', plain_text: 'Project reference', mention: { type: 'page', page: { id: ids.row } } }] })],
    [ids.pdf, block(ids.pdf, 'pdf', { caption: rt('Reliability attachment'), type: 'external', external: { url: 'https://example.invalid/report.pdf' } })],
    [ids.rowText, block(ids.rowText, 'paragraph', 'The project deadline is November 1. Orchid requires legal signoff.')],
    [ids.second, block(ids.second, 'paragraph', 'Second pagination section contains the zephyr migration passwordless decision.')],
    [ids.otherText, block(ids.otherText, 'paragraph', 'ORCHID is the other customer confidential strategy.')]
  ]);
  const revoked = new Set(), removedBlocks = new Set(), requests = []; let failDiscovery = 0;
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const notion = new Notion(store, cfg, async (raw, options) => {
    const url = new URL(raw), path = url.pathname.slice(3), body = options.body ? JSON.parse(options.body) : {}, isB = options.headers.Authorization === 'Bearer tokenB';
    requests.push({ path, body, query: url.search, token: isB ? 'B' : 'A' });
    if (path === '/search') {
      if (failDiscovery-- > 0) throw new Error('temporary discovery outage');
      if (isB) return respond(list([entities.get(ids.other)]));
      return respond(body.start_cursor ? list([entities.get(ids.source)]) : list([entities.get(ids.root), entities.get(ids.project)], 'search-next'));
    }
    if (path.includes('/properties/')) return respond(list([{ type: 'relation', relation: { id: ids.row } }, { type: 'relation', relation: { id: ids.hidden } }]));
    const target = path.split('/')[2];
    if (revoked.has(target) || target === ids.hidden || (isB ? ![ids.other, ids.otherText].includes(target) : [ids.other, ids.otherText].includes(target))) return respond({}, 404);
    if (path.endsWith('/query')) return respond(body.start_cursor ? list([entities.get(ids.row2)]) : list([entities.get(ids.row)], 'rows-next'));
    if (path.endsWith('/children')) {
      if (isB) return respond(list([blocks.get(ids.otherText)]));
      if (target === ids.root) return respond(url.searchParams.has('start_cursor') ? list([blocks.get(ids.second)]) : list([blocks.get(ids.heading), blocks.get(ids.toggle), blocks.get(ids.child)], 'root-next'));
      if (target === ids.toggle) return respond(list([blocks.get(ids.text), blocks.get(ids.table)]));
      if (target === ids.table) return respond(list([blocks.get(ids.tableRow)]));
      if (target === ids.project) return respond(list([blocks.get(ids.long), blocks.get(ids.mention), blocks.get(ids.pdf)]));
      if (target === ids.row) return respond(list([blocks.get(ids.rowText)]));
      return respond(list([]));
    }
    if (path.startsWith('/blocks/')) return removedBlocks.has(target) ? respond({}, 404) : respond(blocks.get(target) || {}, blocks.has(target) ? 200 : 404);
    return respond(entities.get(target) || {}, entities.has(target) ? 200 : 404);
  });
  const search = new WorkspaceSearch(store, notion, cfg); notion.searchEngine = search;
  let worker = new IndexWorker(search);
  async function drain(maxSteps = 80) {
    for (let i = 0; i < maxSteps; i++) {
      if (!await worker.tick()) return;
    }
    throw new Error('Fixture worker did not settle.');
  }
  async function index(key = keyA) { search.enqueue(key); await drain(); }
  return { cfg, store, search, notion, keyA, keyB, index, drain, entities, blocks, revoked, removedBlocks, requests, restartWorker: () => { worker = new IndexWorker(search); }, tick: () => worker.tick(), failNextDiscovery: n => { failDiscovery = n; } };
}

