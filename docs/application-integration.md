# Connect LLM applications

The connector is model-independent. Applications need either MCP, function/tool calling, or code that fetches context over HTTP. A model with no tool interface can receive `notion_get_context` evidence in its prompt through its host application. A chat product that does not let you configure tools or call an API cannot connect automatically.

## Choose an interface

| Application interface | Connector interface | Authorization |
| --- | --- | --- |
| MCP client that launches processes | `node src/stdio.js` | Read/write agent key, or private key file |
| MCP client with HTTP bearer headers | `https://YOUR_HOST/mcp` | Bearer agent key |
| OpenAI Responses function calling | `/v1/tools?format=openai` | Bearer agent key |
| OpenAI-compatible Chat Completions | `/v1/tools?format=openai-chat` | Bearer agent key |
| Anthropic Messages tool use | `/v1/tools?format=anthropic` | Bearer agent key |
| Gemini GenerateContent function calling | `/v1/tools?format=gemini` | Bearer agent key |
| OpenAPI consumer or any HTTP application | `/v1/openapi.json`, `/v1/tools/{name}` | Bearer agent key |

The schema endpoints are authenticated and only advertise tools allowed by that key. A plugin connection is read-only. Every application can have its own revocable agent key while sharing a connection's source index. Do not put management or relay credentials into an LLM application's tools configuration.

Hosted clients that require MCP OAuth still need an agent-facing OAuth authorization service; Notion workspace OAuth does not implement that protocol. Public hosting, OAuth-only chat directory installation, and vendor model API acceptance are not implied by local transport tests.

## Connect a local MCP client

Run the server using the README setup and authorize a Notion source. Write the issued **agent key only** to a private UTF-8 file (not a JSON session file). Generate the configuration:

```sh
node src/agent-cli.js config --url http://127.0.0.1:3100 --key-file /absolute/private/agent-key.txt
```

This prints a portable `mcpServers` JSON stanza using the absolute Node executable and bridge path. Add it to the host's MCP configuration using that application's supported configuration mechanism. The command does not edit applications and never prints the key. Hosts with another configuration schema need the same command, arguments and environment variables translated into that schema.

The bridge supports `NOTION_AGENT_KEY_FILE` or `NOTION_AGENT_KEY`, but not both. It also accepts `NOTION_CONNECTOR_URL`, `NOTION_CONNECTOR_TIMEOUT_MS` (default 30000) and `NOTION_CONNECTOR_MAX_RETRIES` (default 2). A key file is at most 4096 bytes. The bridge reconnects through stateless HTTP operations after a server restart; restart it when tools or their schemas change. It emits only MCP messages on stdout.

## JavaScript or TypeScript applications

Use source imports in this checkout, or install this private package from an authorized Git checkout. The package exports the client, `./formats`, `./relay` and `./diagnostics`.

```js
import { NotionConnectorClient } from './src/client.js';
import { formatTools, executeToolCall } from './src/formats.js';

const client = new NotionConnectorClient({
  baseUrl: process.env.NOTION_CONNECTOR_URL,
  apiKey: process.env.NOTION_AGENT_KEY,
  timeoutMs: 30_000,
});
const tools = formatTools(await client.listTools(), 'openai');
// Pass tools to your chosen model. Then pass its actual function_call item:
const output = await executeToolCall(client, modelFunctionCall, {
  format: 'openai',
  allowedTools: ['notion_get_context', 'notion_read_page', 'notion_related_pages'],
});
// Add output to the conversation using the model provider's continuation API.
```

`executeToolCall` returns the native tool-result envelope: OpenAI `function_call_output`, Chat Completions `role: tool`, Anthropic `tool_result`, or Gemini `functionResponse`. Preserve the original assistant response, reasoning/thought-signature fields and call IDs when continuing a model conversation. Execute only tool calls selected by your application's policy. See `examples/model-tools.js` for a read-only adapter factory.

OpenAI exports explicitly use `strict: false` to retain optional/defaulted connector arguments; the server performs the final validation. Gemini exports use `parametersJsonSchema` for GenerateContent, not the separate Interactions API. The application chooses its model and owns the inference loop; these adapters do not call a model, spend model credits, or transmit Notion text to a provider themselves.

`client.callTool(name, arguments, { signal, timeoutMs })` returns ordinary JSON. `listTools({ refresh: true })` refreshes its cached catalog. Timeouts include discovery, retries and response reading. Redirects are rejected so credentials stay at the configured endpoint. Remote endpoints require HTTPS; localhost HTTP is allowed.

Reads retry bounded transient errors. Writes require the caller's stable `idempotency_key` and are sent once. Model dispatch additionally requires `allowWrites: true` for a write. After `write_outcome_unknown`, inspect Notion before deciding what to do; never generate a fresh key just to retry. `ConnectorError` exposes `code`, `status`, `retryable`, `requestId`, `retryAfterMs`, and `writeOutcomeUnknown` for application handling. Do not include credentials in model prompts or log page content by default.

## HTTP from any language

Discover schemas with `GET /v1/tools`, then POST JSON arguments to `/v1/tools/notion_get_context` with `Authorization: Bearer AGENT_KEY`. Return the cited passages to the application; source text is untrusted evidence. All tool errors use a JSON `error` and `message`; HTTP errors also include a generated `request_id`, matching `X-Request-Id` for diagnostics. The server returns `Retry-After` on rate limits. Browser CORS is allowed only for the configured exact origins.

```python
import json, os, urllib.request, urllib.error

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'Redirect refused', headers, fp)

origin = os.environ['NOTION_CONNECTOR_URL'].rstrip('/')
request = urllib.request.Request(
    origin + '/v1/tools/notion_get_context',
    data=json.dumps({'query': 'What did we decide about the launch?', 'max_chars': 6000}).encode(),
    headers={'Authorization': 'Bearer ' + os.environ['NOTION_AGENT_KEY'],
             'Content-Type': 'application/json'}, method='POST')
# Use a trusted HTTPS origin (localhost HTTP for development).
# Keep credentials at the configured endpoint.
with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
    evidence = json.load(response)
```

## Run the plugin relay inside its authorized host

Use `get_self` to verify workspace/user, bind it through `POST /v1/plugin/connect` with the backend management key, then issue separate `read` and `relay` keys with `POST /v1/keys`. A relay key is bound to one plugin connection and cannot list tools, issue keys or disconnect accounts. Management keys remain accepted for compatibility with older relay hosts.

```js
import { runPluginRelay } from './src/plugin-relay.js';
const stop = new AbortController();
await runPluginRelay({
  baseUrl, connectionId, relayKey,
  callNotion: (name, args, { signal }) => host.callConnectedNotionTool(name, args, { signal }),
  signal: stop.signal,
});
```

`host.callConnectedNotionTool` represents **your host integration**, not a built-in global. Map logical names to the host's actual Notion tools: `get_self`, `get_tool_access`, `fetch`, `search`/`ai_search`, `list_private_pages`, `list_shared_pages`, `list_recent_pages`, `query_data_sources`. Return the original MCP result or decoded structured value. Keep this callback scoped to the same user's account. The relay chooses entitled AI search when available and falls back to the available basic search. External search hits are excluded from Notion results.

The host should honor the callback's `AbortSignal`. Defaults: 25-second independent heartbeats, 600-ms polling, 45-second complete source operations, 10-second backend requests, two concurrent operations, four backend retries, and 2 MB responses. Source retries are bounded; a source timeout stops the relay even if its host ignores cancellation. Each read checks account identity before and after the operation. Polling claims prevent two hosts from executing the same pending request. Abort waits for bounded cleanup and marks the relay offline. The server lease also expires after 90 seconds without a heartbeat.

One active host per connection is recommended: stopping a relay or revoking a relay credential takes the shared connection offline until another valid host heartbeats. The relay requires a running agent host and does not export the connected plugin's credentials. For unattended operation use a configured standalone Notion OAuth source instead.

## Diagnose a connection

```sh
node src/agent-cli.js doctor --key-file /private/agent-key.txt
node src/agent-cli.js doctor --key-file /private/agent-key.txt --query 'release checklist'
node src/agent-cli.js doctor --key-file /private/agent-key.txt --page-id PAGE_UUID
node src/agent-cli.js tools --key-file /private/agent-key.txt --format anthropic
```

Doctor reports authentication, discovery, index coverage and relay status. An explicit query/page read must return live-checked cited passages before `source_verified` is true. Empty results are not a successful live-read proof. It prints counts and status only, never page contents. A failing required check gives exit code 1. `/v1/status` offers machine-readable readiness scoped to an agent key; OAuth `source_ready: null` means a live check is still needed.

## Verification boundary

The local suite tests provider request/result envelopes against actual connector HTTP, MCP HTTP and stdio transports with fixture sources. A separate live acceptance run fetched one real Notion page eight times through these interfaces, verified citations and tested offline denial. It did not call paid model APIs or perform Notion writes. The GitHub workflow runs the suite on Windows, Linux and macOS; `verification.json` records which runs have actually completed.

Provider format references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling).
