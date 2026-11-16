/**
 * Wire test with realistic tool schemas.
 *
 * Converts a tool catalog into Gemini `functionDeclarations`, sends a request
 * that must produce a tool call, then replays the tool result and checks that a
 * final answer arrives. The default catalog is `test/fixtures/tools.json`; pass
 * another JSON file to test a different catalog.
 *
 *   node test/real-tools.mjs [tools.json] [model]
 *
 * Requires a signed-in Antigravity installation (same as test/e2e.mjs).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Transport } from '../lib/transport.js';
import { AuthStore } from '../lib/auth.js';
import { AntigravityApi } from '../lib/api.js';
import { createAdapter } from '../lib/provider.js';
import { buildToolDeclarations } from '../lib/convert.js';

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

const toolsFile = process.argv[2] ?? fileURLToPath(new URL('./fixtures/tools.json', import.meta.url));
const model = process.argv[3] ?? 'gemini-3-flash';
const tools = JSON.parse(fs.readFileSync(toolsFile, 'utf8'));
console.log(`tools: ${tools.length} (${toolsFile})`);

const declarations = buildToolDeclarations(tools);
console.log(`declarations: ${declarations.declarations.length}; payload: ${JSON.stringify(declarations.declarations).length} bytes`);
for (const [original, wire] of declarations.originalToWire) {
  if (original !== wire) console.log(`  renamed ${original} -> ${wire}`);
}

async function main() {
  const transport = new Transport({ proxy: process.env.AGY_PROXY ?? '' });
  console.log(`route: ${await transport.describe()}`);
  const auth = new AuthStore({ transport });
  const api = new AntigravityApi({ transport, auth, logger: { warn: console.warn, info: () => {} } });
  const options = {
    displayName: 'Google Antigravity',
    endpoint: '',
    proxy: process.env.AGY_PROXY ?? '',
    clientVersion: '',
    project: '',
    tokenFile: '',
    catalogTtlMs: 300_000,
    requestTimeoutMs: 900_000,
    idleTimeoutMs: 300_000,
    extraModels: [],
  };
  const runtime = async () => ({ transport, auth, api });
  const adapter = createAdapter({ provider: 'antigravity', options, runtime, LlmAdapter: TestLlmAdapter, LlmError: TestLlmError, attribution: () => ({}), logger: { warn: console.warn, info: () => {} } });

  const prompt = 'Use the run_command tool to print the current working directory. Then answer with the tool result on one line. Do not invent the result.';
  const collect = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  };
  const first = await collect(adapter.stream({ provider: 'antigravity', model, reasoningEffort: 'low', tools, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }));
  const firstCalls = first.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').map((chunk) => chunk.block);
  const firstText = first.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  const firstFinish = first.find((chunk) => chunk.type === 'finish')?.reason;
  console.log(`\nturn 1 finish: ${JSON.stringify(firstFinish)}`);
  console.log(`turn 1 text: ${JSON.stringify(firstText.slice(0, 200))}`);
  console.log(`turn 1 tool calls: ${firstCalls.map((call) => `${call.name}(${call.arguments.slice(0, 120)})`).join(' | ') || 'none'}`);
  if (firstCalls.length === 0) throw new Error('model did not call a tool');
  const call = firstCalls[0];
  JSON.parse(call.arguments);

  const replayState = first.find((chunk) => chunk.type === 'finish')?.replayState;
  const assistantBlocks = first.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block);
  const second = await collect(adapter.stream({
    provider: 'antigravity',
    model,
    reasoningEffort: 'low',
    tools,
    messages: [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
      { role: 'assistant', content: assistantBlocks, source: { kind: 'model', provider: 'antigravity', model, ...(replayState !== undefined ? { replayState } : {}) } },
      { role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text: 'H:\\workspace' }] },
    ],
  }));
  const secondText = second.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  const secondFinish = second.find((chunk) => chunk.type === 'finish')?.reason;
  console.log(`\nturn 2 finish: ${JSON.stringify(secondFinish)}`);
  console.log(`turn 2 text: ${JSON.stringify(secondText.slice(0, 300))}`);
  if (secondText.trim() === '') throw new Error('second turn produced no text');
  transport.close();
  console.log('\nREAL TOOLS OK');
}

main().catch((error) => {
  console.error('\nREAL TOOLS FAILED:', error);
  process.exitCode = 1;
});
