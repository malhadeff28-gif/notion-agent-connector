import { readDocument, normalizeId, unavailable, endpoint, titleOf, propertyText, deleted } from './documents.js';
import { hash } from './security.js';

/** Durable, bounded, single-process indexing. One step checkpoints one discovery page or resource. */
export class IndexWorker {
  constructor(search) { this.search = search; this.db = search.db; this.busy = false; this.timer = null; this.stopping = false; }
  key(connection) { return { tenant_id: connection.tenant_id, connection_id: connection.id, role: 'read' }; }
  push(detail, task) {
    const id = normalizeId(task.id); if (!id) return;
    const marker = task.kind + ':' + id + ':' + (task.cursor || '');
    if (detail.seen[marker]) return;
    const cap = detail.limit || this.search.config.maxIndexedDocuments || 5000;
    if (detail.discovered >= cap * 2 || (task.kind !== 'query' && (detail.document_count || 0) >= cap)) { detail.warnings.push('workspace_discovery_limit'); return; }
    detail.seen[marker] = true; detail.queue.push({ ...task, id }); detail.discovered++;
    if (task.kind !== 'query') detail.document_count = (detail.document_count || 0) + 1;
  }
  checkpoint(key, detail, state = 'running') {
    detail.warnings = [...new Set(detail.warnings)].slice(0, 30);
    this.db.prepare('UPDATE search_jobs SET state=?,detail=?,updated_at=?,completed_at=CASE WHEN ? IN (?,?,?) THEN ? ELSE completed_at END WHERE connection_id=?').run(state, JSON.stringify(detail), Date.now(), state, 'complete', 'partial', 'failed', Date.now(), key.connection_id);
  }
  async refreshOne(connection, refresh) {
    const key = this.key(connection);
    try {
      const document = await readDocument(this.search.notion, key, refresh.page_id, refresh.kind, this.search.config.indexLimits);
      this.search.save(key, document);
      for (const child of document.discovered) this.search.enqueuePage(key, child.id, child.kind);
      this.db.prepare('DELETE FROM search_refresh WHERE connection_id=? AND page_id=? AND revision=?').run(key.connection_id, refresh.page_id, refresh.revision);
    } catch (e) {
      // If the connection was revoked while awaiting Notion, never recreate its cache.
      if (!this.db.prepare('SELECT active FROM connections WHERE id=?').get(key.connection_id)?.active) return;
      if (e.code?.startsWith('plugin_relay_')) return;
      if (unavailable(e)) {
        this.search.purgeDocument(key, refresh.page_id);
        this.db.prepare('DELETE FROM search_refresh WHERE connection_id=? AND page_id=? AND revision=?').run(key.connection_id, refresh.page_id, refresh.revision);
      } else {
        this.db.prepare('UPDATE search_refresh SET failures=failures+1,due=? WHERE connection_id=? AND page_id=? AND revision=?').run(Date.now() + Math.min(300_000, 2000 * 2 ** Math.min(refresh.failures, 7)), key.connection_id, refresh.page_id, refresh.revision);
      }
    }
  }
  async step(connection, job) {
    const key = this.key(connection), detail = JSON.parse(job.detail);
    if (detail.due > Date.now()) return false;
    try {
      if (!detail.search_done) {
        const response = await this.search.notion.request(key, '/search', 'POST', { page_size: 100, ...(detail.search_cursor ? { start_cursor: detail.search_cursor } : {}) }, true);
        for (const resource of response.results || []) {
          const kind = resource.object === 'data_source' ? 'data_source' : resource.object === 'database' ? 'database' : 'page';
          this.push(detail, { id: resource.id, kind });
        }
        const cursor = response.has_more ? response.next_cursor : null;
        if (cursor && (detail.cursors.includes(cursor) || detail.cursors.length >= 100)) { detail.warnings.push('search_discovery_incomplete'); detail.search_done = true; }
        else if (!cursor) { detail.search_done = true; if (response.has_more) detail.warnings.push('search_cursor_missing'); }
        else { detail.cursors.push(cursor); detail.search_cursor = cursor; }
        if (detail.search_done) {
          // Revalidate formerly indexed pages too: discovery can be eventually consistent.
          const known = this.db.prepare('SELECT page_id,kind FROM search_documents WHERE connection_id=?').all(key.connection_id);
          for (const d of known) this.push(detail, { id: d.page_id, kind: d.kind });
        }
      } else if (detail.queue.length) {
        const task = detail.queue[0];
        if (task.kind === 'query') {
          const response = await this.search.notion.request(key, '/data_sources/' + task.id + '/query', 'POST', { page_size: 100, ...(task.cursor ? { start_cursor: task.cursor } : {}) }, true);
          if (response.plugin_more_rows) detail.warnings.push('plugin_row_discovery_bounded');
          for (const row of response.results || []) this.push(detail, { id: row.id, kind: row.object === 'data_source' ? 'data_source' : 'page' });
          if (response.has_more && response.next_cursor) {
            const marker = 'query:' + task.id + ':' + response.next_cursor;
            if (detail.seen[marker]) detail.warnings.push('data_source_cursor_cycle');
            else this.push(detail, { id: task.id, kind: 'query', cursor: response.next_cursor });
          } else if (response.has_more) detail.warnings.push('data_source_cursor_missing');
        } else {
          let initial = null;
          const prior = this.search.document(key, task.id);
          if (task.kind === 'page' && prior?.edited_at && !this.search.notion.usesPlugin?.(key)) {
            initial = await this.search.notion.request(key, endpoint(task.kind, task.id));
            const meta = propertyText(initial.properties), title = titleOf(initial);
            if (!deleted(initial) && initial.last_edited_time === prior.edited_at && prior.metadata_hash === hash(JSON.stringify({ title, meta }))) {
              detail.processed++; detail.warnings.push(...JSON.parse(prior.warnings)); detail.queue.shift(); detail.failures = 0; detail.due = 0;
              this.checkpoint(key, detail, detail.queue.length ? 'running' : (detail.errors || detail.warnings.length ? 'partial' : 'complete')); return true;
            }
          }
          const document = await readDocument(this.search.notion, key, task.id, task.kind, this.search.config.indexLimits, initial);
          this.search.save(key, document); detail.processed++;
          if (document.warnings.length) detail.warnings.push(...document.warnings);
          for (const child of document.discovered) this.push(detail, child);
          if (task.kind === 'data_source') this.push(detail, { id: task.id, kind: 'query' });
        }
        detail.queue.shift();
      }
      detail.failures = 0; detail.due = 0; detail.last_error = null;
      const done = detail.search_done && !detail.queue.length;
      this.checkpoint(key, detail, done ? (detail.errors || detail.warnings.length ? 'partial' : 'complete') : 'running');
      return true;
    } catch (e) {
      if (!this.db.prepare('SELECT active FROM connections WHERE id=?').get(key.connection_id)?.active) return false;
      if (e.code?.startsWith('plugin_relay_')) {
        detail.last_error = e.code; detail.due = Date.now() + 1000;
        this.checkpoint(key, detail, 'queued'); return false;
      }
      detail.last_error = e.code || 'index_request_failed'; detail.failures++;
      if (detail.search_done && detail.queue.length && unavailable(e)) {
        const task = detail.queue.shift();
        this.search.purgeDocument(key, task.id); detail.errors++; detail.warnings.push('inaccessible_resources_skipped'); detail.failures = 0;
      } else if (detail.failures >= 3) {
        if (!detail.search_done) { this.checkpoint(key, detail, 'failed'); return true; }
        detail.queue.shift(); detail.errors++; detail.warnings.push('resources_failed_after_retry'); detail.failures = 0;
      }
      detail.due = detail.failures ? Date.now() + Math.min(30_000, 1000 * 2 ** detail.failures) : 0;
      this.checkpoint(key, detail, 'running'); return true;
    }
  }
  async tick() {
    if (this.busy || this.stopping) return false;
    this.busy = true;
    try {
      const refresh = this.db.prepare('SELECT r.*,c.tenant_id,c.provider FROM search_refresh r JOIN connections c ON c.id=r.connection_id WHERE c.active=1 AND r.due<=? ORDER BY r.due,r.rowid LIMIT 1').get(Date.now());
      if (refresh && (refresh.provider !== 'plugin' || this.search.notion.pluginBridge?.online({ connection_id: refresh.connection_id }))) { await this.refreshOne({ id: refresh.connection_id, tenant_id: refresh.tenant_id }, refresh); return true; }
      const jobs = this.db.prepare("SELECT j.*,c.tenant_id,c.provider FROM search_jobs j JOIN connections c ON c.id=j.connection_id WHERE c.active=1 AND j.state IN ('queued','running') ORDER BY j.updated_at LIMIT 50").all();
      for (const job of jobs) {
        if (job.provider === 'plugin' && !this.search.notion.pluginBridge?.online({ connection_id: job.connection_id })) continue;
        if (await this.step({ id: job.connection_id, tenant_id: job.tenant_id }, job)) return true;
      }
      return false;
    } finally { this.busy = false; }
  }
  schedule() {
    const interval = this.search.config.syncIntervalMs || 300_000;
    for (const c of this.db.prepare('SELECT id,tenant_id FROM connections WHERE active=1').all()) {
      if (this.search.notion.usesPlugin?.(this.key(c)) && !this.search.notion.pluginBridge?.online(this.key(c))) continue;
      const job = this.db.prepare('SELECT state,updated_at,completed_at FROM search_jobs WHERE connection_id=?').get(c.id);
      if (!job || (!['queued', 'running'].includes(job.state) && Date.now() - (job.completed_at || job.updated_at) >= interval)) this.search.enqueue(this.key(c));
    }
  }
  start() {
    if (this.timer) return;
    this.schedule();
    this.timer = setInterval(() => { try { this.schedule(); void this.tick().catch(() => {}); } catch {} }, 600);
    this.timer.unref();
  }
  async stop() {
    this.stopping = true; clearInterval(this.timer); this.timer = null;
    while (this.busy) await new Promise(r => setTimeout(r, 25));
  }
}
