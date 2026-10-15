import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';

export const secret = (prefix = '') => prefix + randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export class Problem extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function seal(value, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
export function unseal(value, key, context) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]));
}
export function config(env = process.env) {
  const appUrl = new URL(env.APP_URL || 'http://127.0.0.1:3100');
  if (appUrl.pathname !== '/' || appUrl.search || appUrl.hash || appUrl.username || appUrl.password) throw new Error('APP_URL must be an origin only.');
  if (appUrl.protocol !== 'https:' && !(appUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname))) throw new Error('APP_URL requires HTTPS outside localhost.');
  const encryptionKey = Buffer.from(env.ENCRYPTION_KEY || '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 random bytes encoded in base64. Run node src/init.js.');
  return {
    appUrl: appUrl.origin, encryptionKey,
    clientId: env.NOTION_CLIENT_ID || '', clientSecret: env.NOTION_CLIENT_SECRET || '',
    notionVersion: '2026-03-11', notionBase: 'https://api.notion.com/v1',
    redirectUri: appUrl.origin + '/oauth/notion/callback',
    dbPath: env.DATABASE_PATH || './data/connector.sqlite',
    port: Number(env.PORT || appUrl.port || 3100), host: env.BIND_HOST || '127.0.0.1',
    allowedOrigins: (env.ALLOWED_ORIGINS || appUrl.origin).split(',').map(s => s.trim()),
    autoIndex: env.AUTO_INDEX !== 'false', syncIntervalMs: Math.max(60_000, Number(env.SYNC_INTERVAL_SECONDS || 300) * 1000),
    maxIndexedDocuments: Math.max(10, Math.min(20_000, Number(env.MAX_INDEXED_DOCUMENTS || 5000))),
    pluginIndexLimit: Math.max(10, Math.min(5000, Number(env.PLUGIN_INDEX_LIMIT || 100))),
    notionMinIntervalMs: 350,
    indexLimits: { maxBlocks: 3000, maxDepth: 24, maxCalls: 150 }
  };
}
