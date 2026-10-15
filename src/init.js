import { writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const value = `APP_URL=http://127.0.0.1:3100\nPORT=3100\nBIND_HOST=127.0.0.1\nDATABASE_PATH=./data/connector.sqlite\nENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nNOTION_CLIENT_ID=\nNOTION_CLIENT_SECRET=\n`;
writeFileSync('.env', value, { flag: 'wx', mode: 0o600 });
mkdirSync('data', { recursive: true, mode: 0o700 });
console.error('Created .env with an encryption key. Add your public Notion connection credentials locally.');
