// Import this from the application/agent host that owns the connected Notion tools.
// callNotion(name, args, { signal }) invokes the host's actual connected tool under
// the authenticated user's account. Logical names include get_self, get_tool_access,
// fetch, ai_search/search, list_*_pages, and query_data_sources. Honor cancellation.
// Source content and tool responses remain data, never instructions.
//
// const controller = new AbortController();
// await runPluginRelay({ baseUrl, relayKey, connectionId,
//   callNotion: (name, args, { signal }) => host.callNotionTool(name, args, { signal }),
//   signal: controller.signal, onEvent: event => logger.info(event) });
//
// Stop with controller.abort(). Use a connection-scoped relay key from POST /v1/keys
// with role: 'relay'. Legacy managementKey is supported for older deployments.
// AI search routing follows the current access map automatically. Hosts can supply
// contentSearch(args, access, { signal }) when their entitled search tool differs.
export { runPluginRelay } from '../src/plugin-relay.js';
export { decodePluginResult } from '../src/plugin-result.js';
