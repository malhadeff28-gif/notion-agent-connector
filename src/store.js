import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { secret, hash, seal, unseal, Problem } from './security.js';

export class Store {
  constructor(path, encryptionKey) {
    this.encryptionKey = encryptionKey;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      DROP TABLE IF EXISTS console_tickets;
      DROP TABLE IF EXISTS console_sessions;
      CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), workspace_id TEXT NOT NULL, workspace_name TEXT, tokens TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), connection_id TEXT REFERENCES connections(id), digest TEXT UNIQUE NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS oauth_states(digest TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), browser_digest TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connect_tickets(digest TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS writes(connection_id TEXT NOT NULL REFERENCES connections(id), request_key TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT, PRIMARY KEY(connection_id, request_key));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, key_id TEXT, connection_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('PRAGMA table_info(connections)').all().some(c => c.name === 'provider')) this.db.exec("ALTER TABLE connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'oauth'");
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
  provision(name) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO tenants VALUES(?,?)').run(id, name);
    return { tenant_id: id, ...this.issueKey(id, null, 'manage', 'Initial management key') };
  }
  issueKey(tenantId, connectionId, role, label) {
    const id = randomUUID(), value = secret(role === 'manage' ? 'ncm_' : 'nca_');
    this.db.prepare('INSERT INTO keys(id,tenant_id,connection_id,digest,role,label) VALUES(?,?,?,?,?,?)').run(id, tenantId, connectionId, hash(value), role, label);
    return { key_id: id, key: value, role, connection_id: connectionId };
  }
  authenticate(value, management = false) {
    const key = this.db.prepare('SELECT * FROM keys WHERE digest=? AND active=1').get(hash(value || ''));
    if (!key || (management ? key.role !== 'manage' : !['read', 'write'].includes(key.role))) throw new Problem(401, 'unauthorized', 'A valid ' + (management ? 'management' : 'agent') + ' key is required.');
    if (!management) this.connection(key.tenant_id, key.connection_id);
    return key;
  }
  authenticateRelay(value, connectionId) {
    const key = this.db.prepare('SELECT * FROM keys WHERE digest=? AND active=1').get(hash(value || ''));
    if (!key || !['manage', 'relay'].includes(key.role) || (key.role === 'relay' && key.connection_id !== connectionId)) throw new Problem(401, 'unauthorized', 'A valid key for this plugin relay is required.');
    this.connection(key.tenant_id, connectionId);
    return key;
  }
  connection(tenantId, id) {
    const row = this.db.prepare('SELECT * FROM connections WHERE id=? AND tenant_id=? AND active=1').get(id, tenantId);
    if (!row) throw new Problem(404, 'connection_not_found', 'Connection unavailable.');
    return row;
  }
  tokens(row) { return unseal(row.tokens, this.encryptionKey, row.tenant_id + ':' + row.id); }
  saveTokens(row, tokens) {
    this.db.prepare('UPDATE connections SET tokens=? WHERE id=? AND tenant_id=? AND active=1').run(seal(tokens, this.encryptionKey, row.tenant_id + ':' + row.id), row.id, row.tenant_id);
  }
  saveConnection(tenantId, grant) {
    if (!grant.access_token || !grant.workspace_id) throw new Problem(502, 'invalid_grant', 'Notion returned an incomplete authorization.');
    const id = randomUUID();
    const row = { id, tenant_id: tenantId };
    const tokens = seal({ access_token: grant.access_token, refresh_token: grant.refresh_token || null, bot_id: grant.bot_id }, this.encryptionKey, tenantId + ':' + id);
    this.db.prepare('INSERT INTO connections(id,tenant_id,workspace_id,workspace_name,tokens) VALUES(?,?,?,?,?)').run(id, tenantId, grant.workspace_id, grant.workspace_name || 'Notion workspace', tokens);
    return { connection_id: row.id, workspace_id: grant.workspace_id, workspace_name: grant.workspace_name || 'Notion workspace' };
  }
  createState(tenantId) {
    this.db.prepare('DELETE FROM oauth_states WHERE expires < ?').run(Date.now());
    const state = secret(), browser = secret();
    this.db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?)').run(hash(state), tenantId, hash(browser), Date.now() + 600_000);
    return { state, browser };
  }
  createTicket(tenantId) {
    this.db.prepare('DELETE FROM connect_tickets WHERE expires < ?').run(Date.now());
    const ticket = secret();
    this.db.prepare('INSERT INTO connect_tickets VALUES(?,?,?)').run(hash(ticket), tenantId, Date.now() + 600_000);
    return ticket;
  }
  consumeTicket(ticket) {
    const row = this.db.prepare('SELECT * FROM connect_tickets WHERE digest=?').get(hash(ticket));
    if (!row || row.expires < Date.now()) throw new Problem(400, 'invalid_connect_ticket', 'Connection link expired. Request a new link from your app.');
    this.db.prepare('DELETE FROM connect_tickets WHERE digest=?').run(hash(ticket));
    return row.tenant_id;
  }
  consumeState(state, browser) {
    const row = this.db.prepare('SELECT * FROM oauth_states WHERE digest=?').get(hash(state));
    if (!row || row.expires < Date.now() || row.browser_digest !== hash(browser)) throw new Problem(400, 'invalid_oauth_state', 'Authorization expired or started in a different browser. Start again.');
    this.db.prepare('DELETE FROM oauth_states WHERE digest=?').run(hash(state));
    return row.tenant_id;
  }
  log(key, action, outcome, connectionId = key.connection_id) {
    this.db.prepare('INSERT INTO audit(tenant_id,key_id,connection_id,action,outcome,at) VALUES(?,?,?,?,?,?)').run(key.tenant_id, key.id || null, connectionId || null, action, outcome, Date.now());
  }
  async once(connectionId, requestKey, fingerprint, operation) {
    const prior = this.db.prepare('SELECT * FROM writes WHERE connection_id=? AND request_key=?').get(connectionId, requestKey);
    if (prior) {
      if (prior.input_hash !== fingerprint) throw new Problem(409, 'idempotency_conflict', 'This idempotency key belongs to a different operation.');
      if (prior.result) return JSON.parse(prior.result);
      throw new Problem(409, 'write_outcome_unknown', 'The write is pending or its outcome is unknown. Read the target in Notion before taking further action.');
    }
    this.db.prepare('INSERT INTO writes(connection_id,request_key,input_hash) VALUES(?,?,?)').run(connectionId, requestKey, fingerprint);
    const result = await operation();
    this.db.prepare('UPDATE writes SET result=? WHERE connection_id=? AND request_key=?').run(JSON.stringify(result), connectionId, requestKey);
    return result;
  }
}
