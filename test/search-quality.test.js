import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ids } from './fixtures/workspace.js';

test('representative plain-language questions retrieve the expected evidence from the fixture workspace', async t => {
  const f = await setup(t); await f.index();
  const cases = [
    ['Who handles satellite escalations?', 'Marisol'],
    ['What did we decide about the orchid rollout?', 'approved after the reliability review'],
    ['Which project has a deadline and is blocked?', 'Blocked'],
    ['Find the passwordless migration decision', 'zephyr'],
    ['Who owns the release checklist?', 'Serena']
  ];
  for (const [query, expected] of cases) {
    const result = await f.search.context(f.keyA, { query, max_chars: 8000, max_pages: 4 });
    assert.ok(result.passages.some(p => p.text.includes(expected)), 'Missing expected evidence for: ' + query);
  }
});
test('misspelled project names produce live-checked suggestions without cross-customer names', async t => {
  const f = await setup(t); await f.index(); await f.index(f.keyB);
  const result = await f.search.search(f.keyA, { query: 'Orchdi' });
  assert.equal(result.results.length, 0);
  assert.ok(result.suggested_queries.some(s => s.page_id === ids.row));
  assert.ok(!JSON.stringify(result.suggested_queries).includes('Another customer'));
});
test('an incremental refresh avoids crawling unchanged page blocks', async t => {
  const f = await setup(t); await f.index();
  f.requests.splice(0); await f.index();
  assert.ok(f.requests.some(r => r.path === '/pages/' + ids.root));
  assert.ok(!f.requests.some(r => r.path === '/blocks/' + ids.root + '/children'));
  assert.ok(f.requests.some(r => r.path.endsWith('/query')));
});
