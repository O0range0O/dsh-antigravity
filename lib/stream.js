/**
 * Antigravity SSE frames -> harness `StreamChunk` protocol.
 *
 * Blocks are opened lazily on their first non-empty delta so a signature-only
 * trailing part never produces an empty text block: the Cloud Code backend
 * rejects empty text blocks when a Claude model's history is replayed.
 */

function mapFinishReason(finishReason, hasToolCalls) {
  switch (finishReason) {
    case 'MAX_TOKENS':
      return { kind: 'max-tokens' };
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return { kind: 'stop' };
    case 'MALFORMED_FUNCTION_CALL':
      return { kind: 'error', failure: { message: 'Antigravity returned MALFORMED_FUNCTION_CALL', code: 'MALFORMED_RESPONSE' } };
    case 'ERROR':
      return { kind: 'error', failure: { message: 'Antigravity reported a model error', code: 'SERVER' } };
    default:
      return hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' };
  }
}

function mapUsage(usageMetadata) {
  if (usageMetadata === null || typeof usageMetadata !== 'object') return undefined;
  const inputTokens = Number(usageMetadata.promptTokenCount ?? 0);
  const outputTokens = Number(usageMetadata.candidatesTokenCount ?? 0);
  const totalTokens = Number(usageMetadata.totalTokenCount ?? inputTokens + outputTokens);
  const usage = { inputTokens, outputTokens, totalTokens };
  if (Number.isFinite(usageMetadata.thoughtsTokenCount) && usageMetadata.thoughtsTokenCount > 0) usage.reasoningTokens = usageMetadata.thoughtsTokenCount;
  if (Number.isFinite(usageMetadata.cachedContentTokenCount) && usageMetadata.cachedContentTokenCount > 0) usage.cacheReadTokens = usageMetadata.cachedContentTokenCount;
  return usage;
}

/**
 * Translate one Antigravity SSE stream into harness chunks.
 * @param {AsyncIterable<object>} frames parsed `{response: {...}}` frames
 * @param {{provider: string, model: string, wireToOriginal?: Map<string,string>}} context
 * @returns {AsyncGenerator<object>}
 */
export async function* translateStream(frames, context) {
  const queue = [];
  let nextIndex = 0;
  let current;
  const signatures = [];
  let emittedToolCalls = 0;
  let usage;
  let finishReason;
  let trailingSignature;
  let pendingSignature;

  const push = (chunk) => queue.push(chunk);

  const closeCurrent = () => {
    if (current === undefined) return;
    if (current.started) {
      const block = current.type === 'text' ? { type: 'text', text: current.text } : { type: 'reasoning', text: current.text };
      push({ type: 'block-end', index: current.index, block });
      signatures[current.index] = current.signature ?? signatures[current.index];
    }
    current = undefined;
  };

  const switchTo = (type) => {
    if (current !== undefined && current.type !== type) closeCurrent();
    if (current === undefined) current = { index: nextIndex, type, text: '', signature: undefined, started: false };
    return current;
  };

  const appendText = (type, text) => {
    const block = switchTo(type);
    if (!block.started) {
      push({ type: 'block-start', index: block.index, blockType: type });
      block.started = true;
      nextIndex += 1;
    }
    block.text += text;
    push({ type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: block.index, text });
  };

  const attachSignature = (signature) => {
    if (typeof signature !== 'string' || signature === '') return undefined;
    trailingSignature = signature;
    if (current !== undefined) current.signature = signature;
    else pendingSignature = signature;
    return signature;
  };

  try {
    for await (const frame of frames) {
      const response = frame?.response ?? frame;
      if (response === undefined || response === null) continue;
      const candidate = Array.isArray(response.candidates) ? response.candidates[0] : undefined;
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        if (part === null || typeof part !== 'object') continue;
        const call = part.functionCall;
        if (call !== null && typeof call === 'object' && typeof call.name === 'string' && call.name !== '') {
          closeCurrent();
          const wireName = call.name;
          const name = context.wireToOriginal?.get(wireName) ?? wireName;
          const args = call.args ?? {};
          const argumentsJson = typeof args === 'string' ? args : JSON.stringify(args);
          const id = typeof call.id === 'string' && call.id !== '' ? call.id : `agy_call_${Date.now().toString(36)}_${nextIndex}`;
          push({ type: 'block-start', index: nextIndex, blockType: 'tool-call' });
          push({ type: 'tool-call-delta', index: nextIndex, id, name, argumentsDelta: argumentsJson });
          push({ type: 'block-end', index: nextIndex, block: { type: 'tool-call', id, name, arguments: argumentsJson } });
          signatures[nextIndex] = attachSignature(part.thoughtSignature) ?? undefined;
          pendingSignature = undefined;
          nextIndex += 1;
          emittedToolCalls += 1;
          continue;
        }
        if (typeof part.text === 'string') {
          const type = part.thought === true ? 'reasoning' : 'text';
          if (part.text !== '') appendText(type, part.text);
          if (part.thoughtSignature !== undefined) attachSignature(part.thoughtSignature);
          continue;
        }
        if (part.thoughtSignature !== undefined) attachSignature(part.thoughtSignature);
      }
      if (typeof candidate?.finishReason === 'string') finishReason = candidate.finishReason;
      if (response.usageMetadata !== undefined) usage = mapUsage(response.usageMetadata);
      while (queue.length > 0) yield queue.shift();
    }
  } catch (error) {
    closeCurrent();
    while (queue.length > 0) yield queue.shift();
    throw error;
  }

  closeCurrent();
  if (pendingSignature !== undefined && nextIndex > 0 && signatures[nextIndex - 1] === undefined) {
    signatures[nextIndex - 1] = pendingSignature;
    trailingSignature = trailingSignature ?? pendingSignature;
  }
  while (queue.length > 0) yield queue.shift();

  if (usage !== undefined) yield { type: 'usage', usage };
  if (nextIndex === 0 && (finishReason === undefined || finishReason === 'STOP')) {
    throw Object.assign(new Error('Antigravity completed the response without any content'), { llmCode: 'EMPTY_RESPONSE' });
  }
  const replayBlocks = [];
  for (let index = 0; index < nextIndex; index += 1) {
    signatures[index] ??= undefined;
    replayBlocks.push(signatures[index] === undefined ? null : { signature: signatures[index] });
  }
  const hasSignature = signatures.some((signature) => signature !== undefined);
  const replayState = hasSignature
    ? {
        response: {
          provider: context.provider,
          model: context.model,
          ...(trailingSignature !== undefined ? { signature: trailingSignature } : {}),
        },
        blocks: replayBlocks,
      }
    : undefined;
  yield {
    type: 'finish',
    reason: mapFinishReason(finishReason, emittedToolCalls > 0),
    ...(replayState !== undefined ? { replayState } : {}),
  };
}
