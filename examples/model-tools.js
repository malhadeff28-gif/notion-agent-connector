// No provider SDK is required. The application owns model calls and conversation
// state; this adapter executes only the calls the application chooses to allow.
import { NotionConnectorClient } from '../src/client.js';
import { formatTools, executeToolCall } from '../src/formats.js';

export async function notionTools({ baseUrl, apiKey, format = 'openai', allowedTools, signal }) {
  const client = new NotionConnectorClient({ baseUrl, apiKey });
  const definitions = (await client.listTools({ signal })).filter(t => t.read_only && (!allowedTools || allowedTools.includes(t.name)));
  const names = definitions.map(t => t.name);
  return {
    tools: formatTools(definitions, format),
    execute: call => executeToolCall(client, call, { format, allowedTools: names, signal }),
  };
}

// Example inside your OpenAI Responses API loop:
// const notion = await notionTools({ baseUrl, apiKey });
// const response = await model.responses.create({ model: chosenModel, input, tools: notion.tools });
// const outputs = [];
// for (const call of response.output.filter(item => item.type === 'function_call')) {
//   outputs.push(await notion.execute(call));
// }
// Continue with the ORIGINAL model output and these outputs. Preserve all provider
// reasoning items, thought signatures, and call IDs. Bound your tool loop and stop
// on errors. Never execute text as code. Only send workspace evidence to a model
// provider the application's user has chosen.
