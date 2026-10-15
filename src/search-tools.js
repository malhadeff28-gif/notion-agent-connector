import { z } from 'zod';
import { propertyPathId } from './documents.js';

const id = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
const date = z.string().datetime({ offset: true });
const filters = { root_id: id.optional(), kind: z.enum(['page', 'database', 'data_source']).optional(), updated_after: date.optional(), updated_before: date.optional() };
export const searchSchema = z.object({
  query: z.string().max(500).optional(), mode: z.enum(['auto', 'full_text', 'titles']).default('auto'),
  match: z.enum(['any', 'all', 'phrase']).default('any'), prefix: z.boolean().default(false),
  start_cursor: z.string().max(1500).optional(), page_size: z.number().int().min(1).max(100).default(8), ...filters
}).superRefine((a, ctx) => {
  if (a.mode === 'titles' && (a.root_id || a.kind || a.updated_after || a.updated_before)) ctx.addIssue({ code: 'custom', message: 'Use full_text mode for subtree, kind, and date filters.' });
});
export function searchTools(notion, key) {
  const engine = notion.searchEngine;
  if (!engine) return [];
  return [
    { name: 'notion_get_context', description: 'Best first call for a question about the workspace. Search indexed full page contents and properties, recheck selected sources live, and return diverse cited passages within a hard character budget. Reports partial coverage; no answer is invented. Plain-language questions work best with specific subjects.', schema: z.object({ query: z.string().min(1).max(500), max_chars: z.number().int().min(2000).max(32000).default(12000), max_pages: z.number().int().min(1).max(8).default(5), match: z.enum(['any', 'all', 'phrase']).default('any'), prefix: z.boolean().default(false), ...filters }), call: a => engine.context(key, a) },
    { name: 'notion_read_page', description: 'Read a whole page as heading-aware text with block citations, including nested toggles and tables. Automatically follows Notion pagination. Returns a continuation cursor when the evidence budget is filled. Cursors must be reused on the same page and content version.', schema: z.object({ page_id: id, max_chars: z.number().int().min(2000).max(32000).default(12000), start_cursor: z.string().max(1500).optional() }), call: a => engine.readPage(key, a) },
    { name: 'notion_workspace_map', description: 'Find your way around the indexed workspace: page/database titles, hierarchy, and visible link/relation edges. Scope to a root page to inspect a subtree. Every returned node is rechecked live. Follow next_cursor.', schema: z.object({ root_id: id.optional(), depth: z.number().int().min(0).max(8).default(3), limit: z.number().int().min(1).max(20).default(15), start_cursor: z.string().max(1500).optional() }), call: a => engine.map(key, a) },
    { name: 'notion_related_pages', description: 'Follow outgoing and incoming page links, mentions, database relations, and hierarchy. Only returns indexed neighbors that pass live access and freshness checks.', schema: z.object({ page_id: id, limit: z.number().int().min(1).max(20).default(10) }), call: a => engine.related(key, a) },
    { name: 'notion_recent_changes', description: 'Retrieve indexed pages changed since an ISO timestamp. Live-checks each result. Use notion_sync_index to discover newly added pages before checking again.', schema: z.object({ since: date.optional(), limit: z.number().int().min(1).max(20).default(10) }), call: a => engine.recent(key, a) },
    { name: 'notion_index_status', description: 'Inspect search coverage, indexing progress, freshness, pending refreshes, errors, and attachment limitations. An incomplete index cannot prove that a fact is absent.', schema: z.object({}), call: () => engine.status(key) },
    { name: 'notion_sync_index', description: 'Queue a durable refresh of the shared workspace search index. Does not modify Notion. Returns immediately; check notion_index_status for progress. Background indexing follows all discovered pages, data sources, and nested blocks up to documented bounds.', schema: z.object({}), call: () => engine.enqueue(key) },
    { name: 'notion_get_block', description: 'Read a cited block directly from Notion to inspect exact source text or a currently available attachment reference.', schema: z.object({ block_id: id }), call: a => notion.request(key, '/blocks/' + a.block_id) },
    { name: 'notion_get_property', description: 'Read a page property directly, with pagination for long rich text, people, formulas, rollups, or relations truncated in page metadata. Use the property ID from notion_get_page, and follow next_cursor when present.', schema: z.object({ page_id: id, property_id: z.string().min(1).max(200), start_cursor: z.string().max(500).optional(), page_size: z.number().int().min(1).max(100).default(100) }), call: ({ page_id, property_id, ...paging }) => notion.request(key, '/pages/' + page_id + '/properties/' + propertyPathId(property_id) + '?' + new URLSearchParams(Object.entries(paging).filter(([, v]) => v !== undefined))) }
  ];
}
