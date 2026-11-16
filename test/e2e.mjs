/**
 * End-to-end check of the Antigravity provider against the live backend.
 * Runs outside DSH: the adapter is constructed with stub LLM base/error classes,
 * so only the wire behaviour is exercised.
 *
 *   node test/e2e.mjs                     # auto proxy, gemini-3-flash
 *   node test/e2e.mjs claude              # auto proxy, claude-sonnet-4-6
 *   node test/e2e.mjs gemini-3.8-flash-high
 *   AGY_PROXY=direct node test/e2e.mjs    # force a direct connection (TUN)
 *   AGY_PROXY=http://127.0.0.1:7890 node test/e2e.mjs
 */
import { Transport } from '../lib/transport.js';
import { AuthStore } from '../lib/auth.js';
import { AntigravityApi } from '../lib/api.js';
import { createAdapter } from '../lib/provider.js';

class TestLlmError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.failure = { message, code };
    Object.assign(this, options);
  }
}

class TestLlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider };
  }
  providerRetryPolicy() {
    return undefined;
  }
}

const first = process.argv[2];
const MODEL = first === undefined ? 'gemini-3-flash' : first === 'claude' ? 'claude-sonnet-4-6' : first;
const TARGET = MODEL;
const PROXY = process.env.AGY_PROXY ?? '';

async function main() {
  const transport = new Transport({ proxy: PROXY });
  console.log(`proxy setting: ${PROXY === '' ? 'auto (env -> system)' : PROXY}`);
  console.log(`route: ${await transport.describe()}`);
  const auth = new AuthStore({ transport });
  const logger = { warn: (...args) => console.warn('WARN', ...args), info: (...args) => console.log(...args) };
  const api = new AntigravityApi({ transport, auth, logger });
  const options = {
    displayName: 'Google Antigravity',
    endpoint: '',
    proxy: PROXY,
    clientVersion: '2.32.0',
    project: '',
    tokenFile: '',
    catalogTtlMs: 300_000,
    requestTimeoutMs: 900_000,
    idleTimeoutMs: 300_000,
    extraModels: [],
  };
  const runtime = async () => ({ transport, auth, api });
  const adapter = createAdapter({ provider: 'antigravity', options, runtime, LlmAdapter: TestLlmAdapter, LlmError: TestLlmError, attribution: () => ({}), logger });

  const project = await api.projectId();
  console.log(`project: ${project}`);

  const models = await adapter.listModels('antigravity');
  console.log(`\nmodel catalog (${models.length}):`);
  for (const model of models) console.log(`  ${model.id.padEnd(28)} ${model.name}`);

  const info = await adapter.resolveModel('antigravity', TARGET);
  console.log(`\nresolved ${TARGET}: context=${info.context?.contextWindow} maxOutput=${info.defaultMaxTokens} efforts=${info.reasoning?.efforts?.map((e) => e.id).join('/') ?? 'none'}`);

  if (process.argv[2] !== 'models') {
    await textTurn(adapter, info);
    await toolTurn(adapter, info);
  }
  transport.close();
  console.log('\nE2E OK');
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function summarize(chunks) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  let usage;
  let finish;
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
    else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCalls.push(chunk.block);
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  return { text, reasoning, toolCalls, usage, finish, raw: chunks };
}

async function textTurn(adapter, info) {
  console.log('\n--- text turn ---');
  const chunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: info.id,
      system: 'You are terse. Follow the user instruction exactly.',
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: ANTIGRAVITY OK' }] }],
    }),
  );
  const result = summarize(chunks);
  console.log('text:', JSON.stringify(result.text));
  console.log('reasoning chars:', result.reasoning.length);
  console.log('usage:', JSON.stringify(result.usage));
  console.log('finish:', JSON.stringify(result.finish));
  console.log('blocks:', chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block.type).join(','));
  if (!result.text.includes('ANTIGRAVITY OK')) throw new Error(`unexpected text response: ${result.text}`);
  if (result.finish?.kind !== 'stop') throw new Error(`unexpected finish: ${JSON.stringify(result.finish)}`);
  if (!result.usage || result.usage.inputTokens <= 0) throw new Error('no usage reported');
}

async function toolTurn(adapter, info) {
  console.log('\n--- tool round trip ---');
  const tools = [
    {
      name: 'echo',
      description: 'Echo the given message back to the caller.',
      parameters: { type: 'object', properties: { message: { type: 'string', description: 'Text to echo' } }, required: ['message'] },
    },
  ];
  const firstChunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: info.id,
      reasoningEffort: 'low',
      tools,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Call the echo tool with message "hello from dsh", then reply with the tool result. Do not invent the result.' }],
        },
      ],
    }),
  );
  const firstResult = summarize(firstChunks);
  console.log('turn1 text:', JSON.stringify(firstResult.text.slice(0, 200)));
  console.log('turn1 finish:', JSON.stringify(firstResult.finish));
  console.log('turn1 tool calls:', firstResult.toolCalls.map((call) => `${call.name}(${call.arguments})`).join(', '));
  if (firstResult.toolCalls.length === 0) throw new Error('model did not call the echo tool');
  const call = firstResult.toolCalls[0];
  if (call.name !== 'echo') throw new Error(`unexpected tool name: ${call.name}`);

  const replayState = firstChunks.find((chunk) => chunk.type === 'finish')?.replayState;
  const assistantBlocks = firstChunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Call the echo tool with message "hello from dsh", then reply with the tool result. Do not invent the result.' }] },
    { role: 'assistant', content: assistantBlocks, source: { kind: 'model', provider: 'antigravity', model: info.id, ...(replayState !== undefined ? { replayState } : {}) } },
    { role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text: 'hello from dsh' }] },
  ];
  const secondChunks = await collect(
    adapter.stream({
      provider: 'antigravity',
      model: info.id,
      reasoningEffort: 'low',
      tools,
      messages,
    }),
  );
  const second = summarize(secondChunks);
  console.log('turn2 text:', JSON.stringify(second.text.slice(0, 300)));
  console.log('turn2 finish:', JSON.stringify(second.finish));
  if (second.text.trim() === '') throw new Error('second turn produced no text');
}

main().catch((error) => {
  console.error('\nE2E FAILED:', error);
  if (error.cause) console.error('cause:', error.cause);
  process.exitCode = 1;
});
