import { hash, Problem } from './security.js';

export const normalizeId = value => {
  const hex = String(value || '').replace(/-/g, '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(hex) ? hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5') : null;
};
export const sourceUrl = (pageId, blockId) => 'https://www.notion.so/' + normalizeId(pageId).replaceAll('-', '') + (blockId && normalizeId(blockId) !== normalizeId(pageId) ? '#' + normalizeId(blockId).replaceAll('-', '') : '');
export const richText = value => (Array.isArray(value) ? value : []).map(t => t.plain_text ?? t.text?.content ?? (t.type === 'equation' ? t.equation?.expression : '') ?? '').join('');
export const titleOf = entity => richText(entity.title) || richText(Object.values(entity.properties || {}).find(p => p.type === 'title')?.title) || 'Untitled';
export const parentOf = entity => normalizeId(entity.parent?.page_id || entity.parent?.data_source_id || entity.parent?.database_id || entity.parent?.block_id);
export const unavailable = e => [401, 403, 404].includes(e.status);
// Notion returns property IDs already URL-encoded. Normalize once, never double-encode.
export function propertyPathId(value) {
  let raw; try { raw = decodeURIComponent(value); } catch { raw = value; }
  if (raw === '.' || raw === '..') throw new Problem(400, 'invalid_property_id', 'Invalid property identifier.');
  return encodeURIComponent(raw);
}
export function propertyText(properties) {
  const values = [];
  for (const [name, p] of Object.entries(properties || {})) {
    let text;
    if (['title', 'rich_text'].includes(p.type)) text = richText(p[p.type]);
    else if (['select', 'status'].includes(p.type)) text = p[p.type]?.name;
    else if (p.type === 'multi_select') text = p.multi_select.map(t => t.name).join(', ');
    else if (p.type === 'people') text = p.people.map(t => t.name || '').filter(Boolean).join(', ');
    else if (p.type === 'date') text = [p.date?.start, p.date?.end].filter(Boolean).join(' to ');
    else if (p.type === 'relation') text = p.relation.map(r => r.id).join(', ');
    else if (p.type === 'formula' || p.type === 'rollup') {
      const v = p[p.type]; text = ['string', 'number', 'boolean'].includes(v?.type) ? String(v[v.type]) : '';
    } else if (['number', 'checkbox', 'url', 'email', 'phone_number', 'created_time', 'last_edited_time'].includes(p.type)) text = String(p[p.type] ?? '');
    else if (p.type === 'files') text = p.files.map(f => f.name).filter(Boolean).join(', ');
    if (text) values.push(name + ': ' + text);
  }
  return values.join('\n');
}
export function blockText(block) {
  const data = block[block.type] || {};
  const body = richText(data.rich_text);
  const caption = richText(data.caption);
  const cells = block.type === 'table_row' ? (data.cells || []).map(richText).join(' | ') : '';
  const equation = block.type === 'equation' ? data.expression || '' : '';
  const label = ['child_page', 'child_database'].includes(block.type) ? data.title : '';
  const media = ['file', 'pdf', 'image', 'video', 'audio'].includes(block.type) ? [block.type, data.name].filter(Boolean).join(': ') : '';
  const link = ['bookmark', 'link_preview', 'embed'].includes(block.type) ? data.url : '';
  return [body, caption, cells, equation, label, media, link].filter(Boolean).join('\n');
}
export const endpoint = (kind, id) => '/' + ({ page: 'pages', database: 'databases', data_source: 'data_sources' }[kind] || 'pages') + '/' + id;
export const liveMetadata = (notion, key, document) => notion.request(key, endpoint(document.kind, document.page_id));
export const deleted = entity => Boolean(entity.in_trash || entity.archived || entity.is_archived);
export function splitPassages(text, max = 1600, overlap = 160) {
  const parts = []; let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('. ', end));
      if (boundary > start + max / 2) end = boundary + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    parts.push({ text: text.slice(start, end), start, end });
    if (end === text.length) break;
    start = Math.max(start + 1, end - overlap);
    if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  }
  return parts;
}
function linkTargets(block) {
  const targets = [];
  const data = block[block.type] || {};
  if (block.type === 'link_to_page') {
    const target = normalizeId(data.page_id || data.database_id);
    if (target) targets.push({ target, relation: 'link', target_kind: data.database_id ? 'database' : 'page' });
  }
  for (const t of [...(data.rich_text || []), ...(data.caption || []), ...(data.cells || []).flat()]) {
    const mention = normalizeId(t.mention?.page?.id || t.mention?.database?.id);
    if (mention) targets.push({ target: mention, relation: 'mention', target_kind: t.mention?.database ? 'database' : 'page' });
    const href = t.href || t.text?.link?.url;
    if (href) {
      try {
        const url = new URL(href);
        if (url.hostname === 'notion.so' || url.hostname.endsWith('.notion.so') || url.hostname.endsWith('.notion.site')) {
          const id = normalizeId(url.pathname.match(/([a-f0-9]{32}|[a-f0-9-]{36})\/?$/i)?.[1]);
          if (id) targets.push({ target: id, relation: 'link', target_kind: 'page' });
        }
      } catch {}
    }
  }
  return targets;
}

/** Read content through the customer's own credential. Never fetch arbitrary linked URLs. */
export async function readDocument(notion, key, pageId, kind = 'page', limits = {}, initialEntity = null) {
  if (notion.usesPlugin?.(key)) return notion.pluginBridge.document(key, pageId, kind);
  const maxBlocks = limits.maxBlocks || 3000, maxDepth = limits.maxDepth || 24, maxCalls = limits.maxCalls || 150;
  const entity = initialEntity || await notion.request(key, endpoint(kind, pageId));
  if (deleted(entity)) throw new Problem(404, 'notion_resource_not_found', 'This Notion resource is in the trash.');
  const title = titleOf(entity), warnings = [], passages = [], edges = [], discovered = [];
  const id = normalizeId(entity.id || pageId);
  let blocks = 0, calls = 1, chars = 0;
  const add = (blockId, text, heading, type) => {
    if (!text) return;
    if (chars + text.length > 1_500_000) { warnings.push('page_text_limit'); return; }
    chars += text.length;
    const source_hash = hash(text);
    for (const part of splitPassages(text)) passages.push({ block_id: blockId, text: part.text, start: part.start, end: part.end, heading, type, source_hash });
  };
  const meta = kind === 'page' ? propertyText(entity.properties) : Object.entries(entity.properties || {}).map(([name, p]) => name + ': ' + p.type).join('\n');
  add(id, meta || title, 'Properties', 'properties');
  for (const p of Object.values(entity.properties || {})) {
    if (kind === 'page' && p.has_more && p.type !== 'relation') warnings.push('property_value_truncated_use_property_tool');
    if (kind !== 'page' || p.type !== 'relation') continue;
    let relation = p.relation || [];
    if (p.has_more && kind === 'page') {
      let cursor, visited = new Set(); relation = [];
      do {
        if (++calls > maxCalls || relation.length >= 1000) { warnings.push('relation_limit'); break; }
        const response = await notion.request(key, '/pages/' + id + '/properties/' + propertyPathId(p.id) + '?' + new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) }));
        relation.push(...(response.results || []).map(r => r.relation).filter(Boolean));
        cursor = response.has_more ? response.next_cursor : null;
        if (cursor && visited.has(cursor)) { warnings.push('relation_cursor_cycle'); break; }
        if (cursor) visited.add(cursor);
      } while (cursor);
    }
    for (const target of relation) if (normalizeId(target.id)) edges.push({ target: normalizeId(target.id), relation: 'relation', target_kind: 'page' });
  }
  const seen = new Set();
  const walk = async (parent, headings = [], depth = 0) => {
    if (depth > maxDepth) { warnings.push('depth_limit'); return; }
    if (seen.has(parent)) { warnings.push('block_cycle'); return; }
    seen.add(parent);
    let cursor, cursors = new Set(), section = [...headings];
    do {
      if (++calls > maxCalls || blocks >= maxBlocks) { warnings.push('block_limit'); return; }
      const response = await notion.request(key, '/blocks/' + parent + '/children?' + new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) }));
      for (const block of response.results || []) {
        if (++blocks > maxBlocks) { warnings.push('block_limit'); break; }
        if (deleted(block)) continue;
        const blockId = normalizeId(block.id); if (!blockId) continue;
        const body = blockText(block);
        if (/^heading_[123]$/.test(block.type)) { const level = Number(block.type.slice(-1)); section = section.slice(0, level - 1); section[level - 1] = body; }
        add(blockId, body, section.filter(Boolean).join(' > '), block.type);
        edges.push(...linkTargets(block));
        if (block.type === 'child_page' || block.type === 'child_database') {
          const childKind = block.type === 'child_page' ? 'page' : 'database';
          discovered.push({ id: blockId, kind: childKind });
          edges.push({ target: blockId, relation: 'contains', target_kind: childKind });
        } else if (block.has_children) {
          await walk(blockId, section, depth + 1);
        }
        if (['file', 'pdf', 'image', 'video', 'audio', 'embed', 'unsupported'].includes(block.type)) warnings.push('attachment_or_embed_text_not_extracted');
      }
      cursor = response.has_more ? response.next_cursor : null;
      if (cursor && cursors.has(cursor)) { warnings.push('block_cursor_cycle'); break; }
      if (cursor) cursors.add(cursor);
    } while (cursor && calls < maxCalls && blocks < maxBlocks);
    if (cursor) warnings.push('block_limit');
  };
  if (kind === 'page') await walk(id);
  if (kind === 'database') for (const ds of entity.data_sources || []) if (normalizeId(ds.id)) discovered.push({ id: normalizeId(ds.id), kind: 'data_source' });
  return {
    page_id: id, kind, title, parent_id: parentOf(entity), url: sourceUrl(kind === 'data_source' && normalizeId(entity.parent?.database_id) || id),
    edited_at: entity.last_edited_time || null, created_at: entity.created_time || null,
    metadata_hash: hash(JSON.stringify({ title, meta })), passages, edges, discovered,
    warnings: [...new Set(warnings)], block_count: blocks
  };
}
