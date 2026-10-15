import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
// A real read-only check. It does not create or modify Notion content.
if (!process.env.AGENT_KEY) throw new Error('Set AGENT_KEY to an issued customer agent key.');
const base = process.env.APP_URL || 'http://127.0.0.1:3100';
const client = new Client({ name: 'notion-live-smoke', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + process.env.AGENT_KEY } }
  }));
  console.log('Tools:', (await client.listTools()).tools.map(t => t.name).join(', '));
  const result = await client.callTool({ name: 'notion_search', arguments: { page_size: 5 } });
  if (result.isError) throw new Error(result.content[0].text);
  const data = JSON.parse(result.content[0].text);
  console.log('Read check succeeded. Visible results:', data.results.length, 'More results:', data.has_more);
  // Deliberately omit customer page contents and credentials from terminal output.
} finally { await client.close(); }
