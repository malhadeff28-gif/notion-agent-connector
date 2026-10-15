import { config } from './security.js';
import { Store } from './store.js';
import { Notion } from './notion.js';
import { createApp } from './app.js';
import { IndexWorker } from './sync.js';

process.umask(0o077);
const cfg = config();
const store = new Store(cfg.dbPath, cfg.encryptionKey);
const app = createApp(store, new Notion(store, cfg), cfg);
const worker = new IndexWorker(app.search);
if (cfg.autoIndex) worker.start();
app.server.requestTimeout = 30_000;
app.server.headersTimeout = 10_000;
app.server.listen(cfg.port, cfg.host, () => console.error('Notion agent connector listening at ' + cfg.appUrl));
const stop = () => {
  app.server.close(async () => { await app.closeMcp(); await worker.stop(); store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
