import { Problem } from './security.js';

export class Notion {
  constructor(store, config, fetcher = fetch) { this.store = store; this.config = config; this.fetcher = fetcher; this.refreshes = new Map(); this.nextCalls = new Map(); }
  usesPlugin(key) { return this.store.connection(key.tenant_id, key.connection_id).provider === 'plugin'; }
  async oauth(body, endpoint = 'token') {
    if (!this.config.clientId || !this.config.clientSecret) throw new Problem(503, 'notion_not_configured', 'Configure the public Notion connection credentials first.');
    let response;
    try {
      response = await this.fetcher(this.config.notionBase + '/oauth/' + endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: 'Basic ' + Buffer.from(this.config.clientId + ':' + this.config.clientSecret).toString('base64'), 'Content-Type': 'application/json', 'Notion-Version': this.config.notionVersion },
        body: JSON.stringify(body)
      });
    } catch { throw new Problem(502, 'notion_unavailable', 'Notion authorization could not be reached.'); }
    if (!response.ok) throw new Problem(502, 'notion_oauth_failed', 'Notion authorization failed. Reconnect the workspace if necessary.');
    return response.json();
  }
  async refresh(key, oldAccessToken) {
    const id = key.connection_id;
    if (this.refreshes.has(id)) return this.refreshes.get(id);
    const operation = (async () => {
      const row = this.store.connection(key.tenant_id, id), tokens = this.store.tokens(row);
      if (tokens.access_token !== oldAccessToken) return; // Another request already rotated it.
      if (!tokens.refresh_token) throw new Problem(401, 'reconnect_required', 'Reconnect this Notion workspace.');
      const grant = await this.oauth({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      if (!grant.access_token || !grant.refresh_token) throw new Problem(502, 'invalid_refresh', 'Notion returned an incomplete token refresh.');
      this.store.saveTokens(row, { ...tokens, access_token: grant.access_token, refresh_token: grant.refresh_token });
    })();
    this.refreshes.set(id, operation);
    try { return await operation; } finally { this.refreshes.delete(id); }
  }
  async request(key, path, method = 'GET', body, retryRead = false) {
    if (this.usesPlugin(key)) {
      if (!this.pluginBridge) throw new Problem(503, 'plugin_bridge_unavailable', 'Plugin bridge is unavailable.');
      return this.pluginBridge.request(key, path, method, body);
    }
    let refreshed = false, rateRetries = 0;
    while (true) {
      const tokens = this.store.tokens(this.store.connection(key.tenant_id, key.connection_id));
      let response;
      try {
        const now = Date.now(), next = Math.max(now, this.nextCalls.get(key.connection_id) || now);
        this.nextCalls.set(key.connection_id, next + (this.config.notionMinIntervalMs || 0));
        if (next > now) await new Promise(r => setTimeout(r, next - now));
        this.store.connection(key.tenant_id, key.connection_id);
        response = await this.fetcher(this.config.notionBase + path, {
          method, redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json', 'Notion-Version': this.config.notionVersion },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch {
        throw new Problem(502, method === 'GET' || retryRead ? 'notion_unavailable' : 'write_outcome_unknown', method === 'GET' || retryRead ? 'Notion could not be reached.' : 'Write outcome unknown. Read the target before trying another write.');
      }
      if (response.status === 401 && !refreshed) { await this.refresh(key, tokens.access_token); refreshed = true; continue; }
      if (response.status === 429 && (method === 'GET' || retryRead) && rateRetries++ < 2) {
        const seconds = Number(response.headers.get('Retry-After') || 1);
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 5) { await new Promise(r => setTimeout(r, seconds * 1000)); continue; }
      }
      if (!response.ok) {
        const codes = { 401: 'reconnect_required', 403: 'notion_permission_denied', 404: 'notion_resource_not_found', 429: 'notion_rate_limited' };
        throw new Problem(response.status, codes[response.status] || 'notion_request_failed', 'Notion rejected this request (HTTP ' + response.status + '). Check page sharing, schema, and connection capabilities.');
      }
      return response.json();
    }
  }
}
