import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryTerms } from '../src/search.js';
import { readDocument, splitPassages, normalizeId, propertyPathId } from '../src/documents.js';
import { createToolRunner } from '../src/tools.js';
import { setup, ids, block } from './fixtures/workspace.js';

test('indexes nested blocks, table cells, property values, child pages, and paginated source rows', async t => {
  const f = await setup(t); await f.index();
  const status = f.search.status(f.keyA);
  assert.equal(status.indexed_documents, 5); assert.equal(status.state, 'partial');
  assert.ok(status.warnings.includes('attachment_or_embed_text_not_extracted'));
  for (const query of ['satellite', 'zephyr', 'Blocked', 'Budget followup']) {
    const result = await f.search.search(f.keyA, { query, mode: 'full_text', page_size: 8 });
    assert.ok(result.results.length, 'Did not find ' + query);
  }
  const nested = await f.search.search(f.keyA, { query: 'orchid rollout', match: 'all' });
  assert.ok(nested.results[0].citation_url.endsWith('#' + ids.text.replaceAll('-', '')));
  assert.equal(nested.results[0].heading, 'Decision log');
  assert.ok(f.requests.some(r => r.body.start_cursor === 'search-next'));
  assert.ok(f.requests.some(r => r.body.start_cursor === 'rows-next'));
  assert.ok(f.requests.some(r => r.query.includes('root-next')));
  assert.ok(f.requests.some(r => r.path.includes('/properties/')));
  assert.ok(f.requests.some(r => r.path.endsWith('/properties/rel%3Ax')));
});
test('phrase, stemming, prefix, dates, subtree filters, and hostile query syntax behave predictably', async t => {
  const f = await setup(t); await f.index();
  assert.ok((await f.search.search(f.keyA, { query: '" OR * NOT', mode: 'full_text' })).results.length === 0);
  assert.ok((await f.search.search(f.keyA, { query: 'orchid rollout', match: 'phrase' })).results.length);
  assert.ok((await f.search.search(f.keyA, { query: 'escalation', match: 'all' })).results.length);
  assert.ok((await f.search.search(f.keyA, { query: 'satell', prefix: true })).results.length);
  assert.equal((await f.search.search(f.keyA, { query: 'satellite', root_id: ids.source })).results.length, 0);
  assert.equal((await f.search.search(f.keyA, { query: 'orchid', updated_after: '2027-01-01T00:00:00.000Z' })).results.length, 0);
  await assert.rejects(f.search.search(f.keyA, { query: 'what is it' }), /subject/);
  assert.ok(queryTerms('What did we decide about Orchid?').expanded.includes('decision'));
});
test('customer indexes, context, and graph never expose another customer or unavailable relation target', async t => {
  const f = await setup(t); await f.index(); await f.index(f.keyB);
  const a = await f.search.context(f.keyA, { query: 'orchid', max_chars: 6000 });
  assert.ok(a.passages.length); assert.ok(!JSON.stringify(a).includes('other customer confidential'));
  const b = await f.search.context(f.keyB, { query: 'orchid', max_chars: 6000 });
  assert.ok(JSON.stringify(b).includes('other customer confidential')); assert.ok(!JSON.stringify(b).includes('Serena'));
  const map = await f.search.map(f.keyA, { limit: 20 });
  assert.equal(map.nodes.length, 5); assert.ok(!JSON.stringify(map).includes(ids.hidden)); assert.ok(!JSON.stringify(map).includes(ids.other));
  const related = await f.search.related(f.keyA, { page_id: ids.project });
  assert.ok(related.results.some(r => r.id === ids.row && r.relation === 'relation'));
  assert.ok(!JSON.stringify(related).includes('DO NOT EXPOSE'));
  assert.equal((await f.search.map(f.keyA, { root_id: ids.source, depth: 1 })).nodes.length, 3);
});
test('full-text context fits its complete serialized character budget and carries exact source quotes', async t => {
  const f = await setup(t); await f.index();
  for (const budget of [2000, 4000, 12000]) {
    const result = await f.search.context(f.keyA, { query: 'Engineering evidence', max_chars: budget, max_pages: 1 });
    assert.ok(result.passages.length); assert.ok(JSON.stringify(result).length <= budget);
    assert.ok(result.passages.every(p => p.url.startsWith('https://www.notion.so/') && p.citation));
    assert.ok(result.passages.every(p => f.blocks.get(ids.long).paragraph.rich_text[0].plain_text.includes(p.text)));
  }
});
test('deep page reading continues inside a truncated passage without losing its tail', async t => {
  const f = await setup(t); let cursor, sawTail = false, pages = 0;
  do {
    const result = await f.search.readPage(f.keyA, { page_id: ids.project, max_chars: 2000, start_cursor: cursor });
    assert.ok(JSON.stringify(result).length <= 2000);
    sawTail ||= JSON.stringify(result).includes('TAIL_SENTINEL');
    assert.notEqual(result.next_cursor, cursor || 'never'); cursor = result.next_cursor;
    if (++pages > 30) throw new Error('Page cursor did not advance.');
  } while (cursor);
  assert.ok(pages > 3); assert.ok(sawTail);
});
test('revoked pages and blocks are purged before any cached text is returned', async t => {
  const f = await setup(t); await f.index();
  f.removedBlocks.add(ids.text);
  const removedBlock = await f.search.search(f.keyA, { query: 'Serena' });
  assert.equal(removedBlock.results.length, 0); assert.equal(f.search.document(f.keyA, ids.root), undefined);
  f.revoked.add(ids.row);
  const revokedPage = await f.search.context(f.keyA, { query: 'legal signoff', max_chars: 4000 });
  assert.equal(revokedPage.passages.length, 0);
  assert.equal(f.search.document(f.keyA, ids.row), undefined);
});
test('changed text is omitted until it is refreshed; refreshed evidence uses the new source', async t => {
  const f = await setup(t); await f.index();
  f.blocks.set(ids.text, block(ids.text, 'paragraph', 'Orchid is postponed. Aisha now owns the checklist.'));
  const stale = await f.search.search(f.keyA, { query: 'Serena' }); assert.equal(stale.results.length, 0);
  await f.drain();
  assert.ok((await f.search.search(f.keyA, { query: 'Aisha' })).results.length);
  assert.equal((await f.search.search(f.keyA, { query: 'Serena' })).results.length, 0);
});
test('durable checkpoints resume with a new worker and full resync removes inaccessible pages', async t => {
  const f = await setup(t); f.search.enqueue(f.keyA); await f.tick(); f.restartWorker(); await f.drain();
  assert.equal(f.search.status(f.keyA).indexed_documents, 5);
  f.revoked.add(ids.row); await f.index(); assert.equal(f.search.document(f.keyA, ids.row), undefined);
  assert.ok(f.search.status(f.keyA).warnings.includes('inaccessible_resources_skipped'));
});
test('index coverage is explicit before indexing, and syntax/pagination cursors cannot cross queries', async t => {
  const f = await setup(t);
  const pending = await f.search.context(f.keyA, { query: 'orchid', max_chars: 2000 });
  assert.equal(pending.passages.length, 0); assert.equal(pending.coverage, 'index_pending');
  await f.drain();
  const first = await f.search.search(f.keyA, { query: 'Engineering', page_size: 1 });
  assert.ok(first.has_more);
  await assert.rejects(f.search.search(f.keyA, { query: 'orchid', page_size: 1, start_cursor: first.next_cursor }), /Cursor/);
  const next = await f.search.search(f.keyA, { query: 'Engineering', page_size: 1, start_cursor: first.next_cursor });
  assert.ok(next.results.length);
});
test('all new read tools are available to a read-only agent and disconnect erases the search cache', async t => {
  const f = await setup(t); await f.index(); const runner = createToolRunner(f.store, f.notion, f.keyA);
  assert.ok(runner.definitions.some(d => d.name === 'notion_get_context'));
  assert.ok(!runner.definitions.some(d => d.name === 'notion_create_page'));
  const evidence = await runner.run('notion_get_context', { query: 'satellite', max_chars: 3000 }); assert.ok(evidence.passages.length);
  f.search.purgeConnection(f.keyA.connection_id);
  assert.equal(f.search.status(f.keyA).indexed_documents, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM search_edges WHERE connection_id=?').get(f.keyA.connection_id).n, 0);
});
test('document reader caps recursion and splits Unicode safely', async t => {
  const f = await setup(t);
  const doc = await readDocument(f.notion, f.keyA, ids.root, 'page', { maxDepth: 1 });
  assert.ok(doc.warnings.includes('depth_limit'));
  const text = '🚀'.repeat(1500) + 'fin'; const pieces = splitPassages(text);
  assert.ok(pieces.every(p => p.text.length <= 1600));
  assert.ok(pieces.every(p => !/^[\uDC00-\uDFFF]/.test(p.text) && !/[\uD800-\uDBFF]$/.test(p.text)));
  assert.equal(normalizeId(ids.root.replaceAll('-', '')), ids.root);
  assert.equal(propertyPathId('f%5C%5C%3Ap'), 'f%5C%5C%3Ap');
  assert.equal(propertyPathId('Task owner'), 'Task%20owner');
  assert.throws(() => propertyPathId('%2E%2E'), /Invalid/);
});
