#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NotionConnectorClient, validateConnectorUrl } from './client.js';
import { diagnose } from './diagnostics.js';
import { formatTools } from './formats.js';

const help = `Notion connector application utilities (Node 24+)
  node src/agent-cli.js doctor [--query TEXT | --page-id UUID]
  node src/agent-cli.js tools [--format json-schema|openai|openai-chat|anthropic|gemini]
  node src/agent-cli.js config [--key-file PATH]
  node src/agent-cli.js call TOOL_NAME   # JSON arguments on stdin

Options: --url ORIGIN, --key-file PATH, --timeout MILLISECONDS
Credentials: NOTION_AGENT_KEY or NOTION_AGENT_KEY_FILE (plain key file).
config prints a portable mcpServers stanza with a private key-file reference;
it does not edit installed applications. Doctor never prints source content.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, 'key-file': { type: 'string' }, query: { type: 'string' }, 'page-id': { type: 'string' },
    format: { type: 'string', default: 'json-schema' }, timeout: { type: 'string', default: '30000' }, help: { type: 'boolean' }
  } });
  const [command, tool] = positionals;
  if (values.help || !command) { process.stdout.write(help); }
  else {
    const baseUrl = validateConnectorUrl(values.url || process.env.NOTION_CONNECTOR_URL || 'http://127.0.0.1:3100').toString();
    const keyFile = values['key-file'] || process.env.NOTION_AGENT_KEY_FILE;
    if (command === 'config') {
      const env = { NOTION_CONNECTOR_URL: baseUrl, NOTION_AGENT_KEY_FILE: keyFile ? resolve(keyFile) : '/ABSOLUTE/PATH/TO/private-agent-key.txt' };
      process.stdout.write(JSON.stringify({ mcpServers: { 'notion-agent-search': { command: process.execPath, args: [fileURLToPath(new URL('./stdio.js', import.meta.url))], env } } }, null, 2) + '\n');
    } else {
      const apiKey = keyFile ? readFileSync(keyFile, 'utf8').trim() : process.env.NOTION_AGENT_KEY;
      const timeoutMs = Number(values.timeout);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('invalid_timeout');
      const client = new NotionConnectorClient({ baseUrl, apiKey, timeoutMs });
      let result;
      if (command === 'doctor') {
        if (values.query && values['page-id']) throw new Error('choose_query_or_page');
        result = await diagnose(client, { query: values.query, pageId: values['page-id'] });
        if (!result.ok) process.exitCode = 1;
      } else if (command === 'tools') result = formatTools(await client.listTools(), values.format);
      else if (command === 'call' && tool) {
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 256_000) throw new Error('arguments_too_large'); chunks.push(chunk); }
        result = await client.callTool(tool, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } else throw new Error('unknown_command');
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.code || 'configuration_or_request_failed', message: 'Check the connector URL, agent key, command options, and service status. Use --help for usage.' }) + '\n');
  process.exitCode = 1;
}
