import { config } from './security.js';
import { Store } from './store.js';
process.umask(0o077);
const name = process.argv.slice(2).join(' ').trim();
if (!name) throw new Error('Usage: pnpm provision "Customer name"');
const cfg = config(), store = new Store(cfg.dbPath, cfg.encryptionKey);
console.log(JSON.stringify(store.provision(name), null, 2));
store.close();
