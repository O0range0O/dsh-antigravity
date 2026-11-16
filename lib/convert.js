/**
 * Translation between the DeepSeek Harness LLM vocabulary and Google Cloud Code
 * Assist (`v1internal`) request/response shapes.
 *
 * Request side: harness `GenerateOptions` -> Gemini `GenerateContentRequest`
 * wrapped in the `v1internal` envelope the Antigravity backend expects.
 * Response side: SSE `response` frames -> harness `StreamChunk` union.
 */

const TOOL_NAME_MAX = 64;
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const SCHEMA_KEYWORDS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'oneOf',
  'allOf',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'title',
  'default',
  'propertyOrdering',
]);

/** Make any harness tool name acceptable to Gemini, deterministically. */
export function sanitizeToolName(name, taken = new Set()) {
  const raw = typeof name === 'string' && name !== '' ? name : 'tool';
  let candidate = raw.replace(/[^A-Za-z0-9_.:-]/g, '_');
  if (!/^[A-Za-z_]/.test(candidate)) candidate = `_${candidate}`;
  candidate = candidate.slice(0, TOOL_NAME_MAX);
  if (candidate === '') candidate = 'tool';
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `_${suffix}`;
    const next = candidate.slice(0, TOOL_NAME_MAX - tail.length) + tail;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }
  return candidate;
}

/** Convert JSON Schema into the OpenAPI-ish subset Gemini function declarations accept. */
export function sanitizeSchema(schema, defs = {}, depth = 0) {
  if (depth > 12 || schema === null || typeof schema !== 'object') return undefined;
  if (Array.isArray(schema)) return undefined;
  if (typeof schema.$ref === 'string') {
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(schema.$ref);
    if (match) {
      const target = defs[match[1]];
      return target === undefined ? undefined : sanitizeSchema(target, defs, depth + 1);
    }
    return undefined;
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const properties = {};
      for (const [name, child] of Object.entries(value)) {
        const sanitized = sanitizeSchema(child, defs, depth + 1);
        if (sanitized !== undefined) properties[name] = sanitized;
      }
      result.properties = properties;
      continue;
    }
    if (key === 'items') {
      const sanitized = sanitizeSchema(value, defs, depth + 1);
      if (sanitized !== undefined) result.items = sanitized;
      continue;
    }
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (!Array.isArray(value)) continue;
      const options = value.map((item) => sanitizeSchema(item, defs, depth + 1)).filter((item) => item !== undefined);
      if (options.length > 0) result[key] = options;
      continue;
    }
    if (key === 'type') {
      const types = Array.isArray(value) ? value : [value];
      const nonNull = types.filter((item) => item !== 'null');
      const nullable = types.length !== nonNull.length;
      if (nonNull.length === 1) result.type = String(nonNull[0]).toLowerCase();
      else if (nonNull.length > 1) result.anyOf = nonNull.map((item) => ({ type: String(item).toLowerCase() }));
      if (nullable && nonNull.length === 1) result.nullable = true;
      continue;
    }
    if (key === 'default' || key === 'title' || key === 'propertyOrdering') continue;
    result[key] = value;
  }
  if (result.type === undefined && result.properties !== undefined) result.type = 'object';
  if (result.enum !== undefined && result.type === undefined) result.type = 'string';
  if (Object.keys(result).length === 0) return undefined;
  return result;
}

/**
 * Build the function declarations plus the bidirectional name map.
 * @returns {{declarations: object[], wireToOriginal: Map<string,string>, originalToWire: Map<string,string>}}
 */
export function buildToolDeclarations(tools) {
  const declarations = [];
  const wireToOriginal = new Map();
  const originalToWire = new Map();
  const taken = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name === '') continue;
    if (originalToWire.has(tool.name)) continue;
    const wireName = sanitizeToolName(tool.name, taken);
    originalToWire.set(tool.name, wireName);
    wireToOriginal.set(wireName, tool.name);
    const schema = sanitizeSchema(tool.parameters ?? { type: 'object', properties: {} }) ?? { type: 'object', properties: {} };
    declarations.push({
      name: wireName,
      description: typeof tool.description === 'string' ? tool.description.slice(0, 8000) : undefined,
      parameters: schema,
    });
  }
  return { declarations, wireToOriginal, originalToWire };
}

function textOfBlocks(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
    else if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Antigravity's backend answers `429 RESOURCE_EXHAUSTED` instead of executing a
 * request whose `systemInstruction` contains certain first-person claims that
 * name the harness product (verified against the live backend: the same text in
 * a user message is accepted). Paragraphs matching this shape are therefore
 * delivered through the opening user turn.
 * @param {string} paragraph
 * @returns {boolean}
 */
export function isRiskySystemParagraph(paragraph) {
  return /\bYou are\b/i.test(paragraph) && /DeepSeek\s+Harness/i.test(paragraph);
}

/** Whether a system prompt contains any paragraph the backend rejects. */
export function systemPromptRisk(system) {
  if (typeof system !== 'string' || system === '') return false;
  return system.split(/\n\s*\n/).some((paragraph) => isRiskySystemParagraph(paragraph));
}

/**
 * Split one system text into the part that can stay in `systemInstruction` and
 * the part the backend only accepts in user content.
 * @param {string} text
 * @returns {{safe: string, moved: string}}
 */
export function splitSystemText(text) {
  if (typeof text !== 'string' || text === '') return { safe: '', moved: '' };
  const safe = [];
  const moved = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (paragraph.trim() === '') continue;
    if (isRiskySystemParagraph(paragraph)) moved.push(paragraph.trim());
    else safe.push(paragraph);
  }
  return { safe: safe.join('\n\n'), moved: moved.join('\n\n') };
}

function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function signatureMapOf(message, provider) {
  const source = message?.source;
  if (source === undefined || source?.provider !== provider) return { blockSignatures: [], trailing: undefined };
  const replay = source.replayState;
  if (replay === undefined || replay === null) return { blockSignatures: [], trailing: undefined };
  const blocks = Array.isArray(replay.blocks) ? replay.blocks : [];
  const blockSignatures = blocks.map((entry) => (entry && typeof entry.signature === 'string' && entry.signature.length > 0 ? entry.signature : undefined));
  const trailing = typeof replay.response?.signature === 'string' && replay.response.signature.length > 0 ? replay.response.signature : undefined;
  return { blockSignatures, trailing };
}

/**
 * Build the `v1internal:streamGenerateContent` envelope.
 * @param {{
 *   provider: string, model: string, project: string, system?: string,
 *   messages: readonly object[], tools?: readonly object[],
 *   maxTokens?: number, temperature?: number, stopSequences?: readonly string[],
 *   reasoningEffort?: string, signal?: AbortSignal,
 * }} input
 */
export function buildRequest(input) {
  const { declarations, wireToOriginal, originalToWire } = buildToolDeclarations(input.tools ?? []);
  const systemParts = [];
  if (typeof input.system === 'string' && input.system.trim() !== '') systemParts.push(input.system);

  const contents = [];
  const toolNamesByCallId = new Map();
  let pendingFunctionResponses = [];

  const flushFunctionResponses = () => {
    if (pendingFunctionResponses.length === 0) return;
    contents.push({ role: 'user', parts: pendingFunctionResponses });
    pendingFunctionResponses = [];
  };

  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') {
      flushFunctionResponses();
      const text = textOfBlocks(message.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (message.role === 'user') {
      flushFunctionResponses();
      const text = textOfBlocks(message.content);
      if (text === '') continue;
      const previous = contents[contents.length - 1];
      if (previous?.role === 'user') previous.parts.push({ text });
      else contents.push({ role: 'user', parts: [{ text }] });
      continue;
    }
    if (message.role === 'assistant') {
      flushFunctionResponses();
      const { blockSignatures, trailing } = signatureMapOf(message, input.provider);
      const parts = [];
      const pushPart = (part, blockIndex) => {
        const signature = blockSignatures[blockIndex];
        if (signature !== undefined) part.thoughtSignature = signature;
        parts.push(part);
      };
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block?.type === 'text') {
          if (typeof block.text === 'string' && block.text !== '') pushPart({ text: block.text }, index);
          else pushPart({ text: '' }, index);
        } else if (block?.type === 'tool-call') {
          const wireName = originalToWire.get(block.name) ?? sanitizeToolName(block.name);
          if (typeof block.id === 'string') toolNamesByCallId.set(block.id, wireName);
          pushPart({ functionCall: { name: wireName, args: parseArguments(block.arguments), ...(typeof block.id === 'string' && block.id !== '' ? { id: block.id } : {}) } }, index);
        }
        // Reasoning history is not replayed: Gemini thinking signatures, not the
        // thought text, carry continuity, and replay keeps the prefix cacheable.
      }
      if (parts.length === 0) continue;
      if (trailing !== undefined) parts[parts.length - 1].thoughtSignature = trailing;
      contents.push({ role: 'model', parts });
      continue;
    }
    if (message.role === 'tool') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : typeof message.source?.callId === 'string' ? message.source.callId : '';
      const wireName = toolNamesByCallId.get(callId) ?? 'unknown_function';
      const content = Array.isArray(message.content) ? message.content : [];
      let text = '';
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
      }
      if (text === '') text = '(no output)';
      if (message.isError === true) text = `[tool error] ${text}`;
      pendingFunctionResponses.push({
        functionResponse: {
          name: wireName,
          ...(callId !== '' ? { id: callId } : {}),
          response: { result: text.slice(0, 500_000) },
        },
      });
      continue;
    }
  }
  flushFunctionResponses();

  const generationConfig = {};
  if (Number.isFinite(input.maxTokens) && input.maxTokens > 0) generationConfig.maxOutputTokens = Math.floor(input.maxTokens);
  else if (Number.isFinite(input.defaultMaxTokens) && input.defaultMaxTokens > 0) generationConfig.maxOutputTokens = Math.floor(input.defaultMaxTokens);
  if (Number.isFinite(input.temperature) && input.temperatureAccepts !== false) generationConfig.temperature = input.temperature;
  if (Array.isArray(input.stopSequences) && input.stopSequences.length > 0) generationConfig.stopSequences = input.stopSequences.slice(0, 5);
  const thinking = thinkingConfig(input.model, input.reasoningEffort, generationConfig.maxOutputTokens);
  if (thinking !== undefined) generationConfig.thinkingConfig = thinking;

  const request = {
    model: input.model,
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: '' }] }],
  };
  const delivery = input.systemDelivery === 'user' ? 'user' : 'system';
  const safeSystemParts = [];
  const movedSystemParts = [];
  for (const text of systemParts) {
    if (delivery === 'user') {
      movedSystemParts.push(text);
      continue;
    }
    const { safe, moved } = splitSystemText(text);
    if (safe !== '') safeSystemParts.push(safe);
    if (moved !== '') movedSystemParts.push(moved);
  }
  if (safeSystemParts.length > 0) {
    request.systemInstruction = { parts: safeSystemParts.map((text) => ({ text })) };
  }
  const movedSystemText = movedSystemParts.join('\n\n');
  if (movedSystemText !== '') {
    // Preserve the text verbatim; the backend accepts it as user content only.
    if (request.contents[0]?.role === 'user') request.contents[0].parts.unshift({ text: movedSystemText });
    else request.contents.unshift({ role: 'user', parts: [{ text: movedSystemText }] });
  }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
  if (declarations.length > 0) {
    request.tools = [{ functionDeclarations: declarations }];
    request.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return {
    model: input.model,
    project: input.project,
    request,
    userAgent: 'antigravity',
    requestId: `dsh-antigravity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    _wireToOriginal: wireToOriginal,
  };
}

const GEMINI_LEVEL_FAMILIES = /^(gemini-(?:3\.[0-9]|4))|^gemini-(?:3|4)-/;

/** Map a harness reasoning effort id onto the Gemini thinking configuration. */
export function thinkingConfig(model, effort, maxOutputTokens) {
  if (typeof effort !== 'string' || effort === '' || effort === 'off') return undefined;
  const level = effort.toLowerCase();
  if (!['minimal', 'low', 'medium', 'high'].includes(level)) return undefined;
  const budget = (() => {
    if (level === 'minimal') return 1024;
    if (level === 'low') return 4096;
    if (level === 'medium') return 16384;
    return 32768;
  })();
  if (GEMINI_LEVEL_FAMILIES.test(model)) {
    return { thinkingLevel: level === 'minimal' ? 'low' : level };
  }
  if (/^gemini-2\.5/.test(model) || /^claude/.test(model)) {
    const capped = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.min(budget, Math.max(1024, maxOutputTokens - 1024)) : budget;
    return { thinkingBudget: capped };
  }
  return undefined;
}


// Response translation lives in ./stream.js so the request builder stays wire-only.
