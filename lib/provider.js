/**
 * The Antigravity LLM adapter: model catalog, exact-model metadata, and the
 * streaming request lifecycle.
 */
import { buildRequest, imageHandleText } from './convert.js';
import { translateStream } from './stream.js';
import { AuthError } from './auth.js';
import { HttpError } from './transport.js';

/** Models advertised when the account catalog cannot be fetched. */
const STATIC_MODELS = [
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, thinking: 'level' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1_048_576, maxOutputTokens: 65_535, thinking: 'budget' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', contextWindow: 250_000, maxOutputTokens: 64_000, thinking: 'budget' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 250_000, maxOutputTokens: 64_000, thinking: 'none' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', contextWindow: 131_072, maxOutputTokens: 32_768, thinking: 'none' },
];

const INTERNAL_MODEL = /^(chat_|tab_|tabjump|antigravity_)|-(?:tts|transcribe|image)$|-tiered$|embedding|lyria|banana/i;
const TEMPERATURE_REJECTED = /^(gemini-3\.8|gemini-4)|-lite(?:$|-)/i;

/** Bounds for inline image input: the backend accepts base64 parts in the request body. */
const MAX_REQUEST_IMAGES = 24;
const MAX_REQUEST_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_REQUEST_IMAGE_EDGE = 1568;
const MAX_REQUEST_IMAGE_BYTES_PER_IMAGE = 2 * 1024 * 1024;

/** Gemini 3 and later require a thought signature on replayed function calls. */
const SIGNATURE_REQUIRED_MODEL = /^(gemini-(?:3\.[0-9]|4))|^gemini-(?:3|4)-/;

/**
 * Request dimensions for one attachment: never enlarge, cap the long edge, and
 * bound the encoded bytes the attachment service produces.
 * @param {{width?: number, height?: number}} attachment
 */
function imageTargetOf(attachment) {
  const width = Number(attachment?.width);
  const height = Number(attachment?.height);
  const maxBytes = MAX_REQUEST_IMAGE_BYTES_PER_IMAGE;
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
    return { width: 1024, height: 1024, maxBytes };
  }
  const scale = Math.min(1, MAX_REQUEST_IMAGE_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), maxBytes };
}

function prettifyName(id) {
  return id
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => (/^[0-9]/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function thinkingStyleFor(id) {
  if (/^claude/.test(id)) return 'budget';
  if (/^gemini-2\.5/.test(id)) return 'budget';
  if (/^gemini-3/.test(id) || /^gemini-4/.test(id)) return 'level';
  return 'none';
}

function defaultContextFor(id) {
  if (/^claude/.test(id)) return 250_000;
  if (/^gpt-oss/.test(id)) return 131_072;
  return 1_048_576;
}

function defaultOutputFor(id) {
  if (/^claude/.test(id)) return 64_000;
  if (/^gpt-oss/.test(id)) return 32_768;
  return 65_536;
}

function descriptorFromApi(id, raw, extra = {}) {
  return {
    id,
    name: typeof raw.displayName === 'string' && raw.displayName !== '' ? raw.displayName : extra.name ?? prettifyName(id),
    description: typeof raw.modelProvider === 'string' && raw.modelProvider !== 'MODEL_PROVIDER_GOOGLE' ? raw.modelProvider.replace(/^MODEL_PROVIDER_/, '') : undefined,
    contextWindow: Number(raw.maxTokens) > 0 ? Number(raw.maxTokens) : defaultContextFor(id),
    maxOutputTokens: Number(raw.maxOutputTokens) > 0 ? Number(raw.maxOutputTokens) : defaultOutputFor(id),
    thinking: raw.supportsThinking === true ? thinkingStyleFor(id) : 'none',
    supportsImages: raw.supportsImages === true,
  };
}

function descriptorFromId(id) {
  const known = STATIC_MODELS.find((model) => model.id === id);
  if (known !== undefined) return { ...known };
  return {
    id,
    name: prettifyName(id),
    description: undefined,
    contextWindow: defaultContextFor(id),
    maxOutputTokens: defaultOutputFor(id),
    thinking: thinkingStyleFor(id),
    supportsImages: false,
  };
}

function effortsFor(descriptor) {
  if (descriptor.thinking === 'none') return undefined;
  // Mirror the DeepSeek route's effort vocabulary so a session keeps the same
  // choices when it switches models.
  return {
    efforts: [
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ],
    defaultEffort: 'high',
  };
}

function modalitiesFor(descriptor) {
  return descriptor.supportsImages === true ? ['text', 'image'] : ['text'];
}

function modelInfoOf(provider, descriptor) {
  return {
    provider,
    id: descriptor.id,
    name: descriptor.name,
    ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
    inputModalities: modalitiesFor(descriptor),
  };
}

function contextWindowMessage(text) {
  const patterns = [
    /input token count exceeds the maximum/i,
    /exceeds the maximum number of tokens/i,
    /token count.*exceeds/i,
    /context (?:window|length).{0,40}(?:exceed|overflow)/i,
    /request is too large/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Create the adapter instance for one provider route.
 * @param {{
 *   provider: string,
 *   options: object,
 *   runtime: () => Promise<{auth: import('./auth.js').AuthStore, api: import('./api.js').AntigravityApi}>,
 *   LlmAdapter: new () => object,
 *   LlmError: new (message: string, code: string, options?: object) => Error,
 *   attribution: () => Record<string, string>,
 *   logger: {warn?: Function, info?: Function},
 * }} dependencies
 */
export function createAdapter(dependencies) {
  const { provider, options, runtime, LlmAdapter, LlmError, attribution, logger, retryPolicy } = dependencies;

  return new (class AntigravityAdapter extends LlmAdapter {
    cachedCatalog;
    catalogAt = 0;
    catalogPromise;
    userSystemFallback = false;

    providerInfo(route) {
      if (route !== provider) throw new LlmError(`unexpected provider route "${route}"`, 'INVALID_ADAPTER');
      return { id: provider, name: options.displayName };
    }

    providerRetryPolicy() {
      return retryPolicy;
    }

    async listModels(route) {
      if (route !== provider) throw new LlmError(`unexpected provider route "${route}"`, 'INVALID_ADAPTER');
      const catalog = await this.#catalog();
      return catalog.map((descriptor) => modelInfoOf(provider, descriptor));
    }

    async resolveModel(route, model, signal) {
      if (route !== provider) throw new LlmError(`unexpected provider route "${route}"`, 'INVALID_ADAPTER');
      const descriptor = await this.#descriptorFor(model, signal);
      const reasoning = effortsFor(descriptor);
      return {
        provider,
        id: descriptor.id,
        name: descriptor.name,
        ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
        inputModalities: modalitiesFor(descriptor),
        context: { contextWindow: descriptor.contextWindow },
        defaultMaxTokens: descriptor.maxOutputTokens,
        ...(reasoning !== undefined ? { reasoning } : {}),
      };
    }

    async prepareCall(route, model, signal) {
      const info = await this.resolveModel(route, model, signal);
      return { model: info, stream: (callOptions) => this.#generate(callOptions, info) };
    }

    stream(callOptions) {
      return this.#generate(callOptions);
    }

    async #catalog(force = false) {
      if (!force && Array.isArray(this.cachedCatalog) && Date.now() - this.catalogAt < options.catalogTtlMs) {
        return this.cachedCatalog;
      }
      if (this.catalogPromise === undefined) {
        this.catalogPromise = this.#loadCatalog().finally(() => {
          this.catalogPromise = undefined;
        });
      }
      return await this.catalogPromise;
    }

    async #loadCatalog() {
      let descriptors;
      try {
        const { api } = await runtime();
        const raw = await api.availableModels();
        descriptors = [];
        for (const [id, info] of raw.entries()) {
          if (INTERNAL_MODEL.test(id)) continue;
          if (typeof info.displayName !== 'string' && !/^(gemini|claude|gpt)/.test(id)) continue;
          descriptors.push(descriptorFromApi(id, info));
        }
        if (descriptors.length === 0) throw new Error('the account catalog is empty');
        logger.info?.(`[antigravity] model catalog: ${descriptors.length} models via ${api.endpoint}`);
      } catch (error) {
        logger.warn?.(`[antigravity] model discovery failed (${error.message}); advertising the built-in model list`);
        descriptors = STATIC_MODELS.map((model) => ({ ...model, description: undefined, supportsImages: false }));
      }
      const seen = new Set(descriptors.map((model) => model.id));
      for (const id of options.extraModels) {
        if (id === '' || seen.has(id)) continue;
        seen.add(id);
        descriptors.push(descriptorFromId(id));
      }
      this.cachedCatalog = descriptors;
      this.catalogAt = Date.now();
      return descriptors;
    }

    async #descriptorFor(model, signal) {
      const catalog = await this.#catalog();
      const found = catalog.find((descriptor) => descriptor.id === model);
      if (found !== undefined) return found;
      const descriptor = descriptorFromId(model);
      try {
        const { api } = await runtime();
        const raw = api.cachedModels;
        const info = raw?.get(model);
        if (info !== undefined) return descriptorFromApi(model, info);
      } catch {
        // Fall through to the derived descriptor.
      }
      void signal;
      return descriptor;
    }

    /**
     * Read user and tool-result images through the harness attachment service.
     * Images beyond the inline budget keep a deterministic text stand-in.
     */
    async #prepareImages(messages, signal) {
      const occurrences = [];
      for (const message of Array.isArray(messages) ? messages : []) {
        const content = Array.isArray(message?.content) ? message.content : [];
        const images = content.filter((block) => block?.type === 'image');
        if (images.length === 0) continue;
        if (message.role !== 'user' && message.role !== 'tool') {
          throw new LlmError('Antigravity accepts images only in user messages and tool results', 'UNSUPPORTED_CONTENT');
        }
        for (const block of images) occurrences.push(block.attachment ?? {});
      }
      if (occurrences.length === 0) return undefined;
      const { resolveAttachments } = await runtime();
      const store = typeof resolveAttachments === 'function' ? resolveAttachments() : undefined;
      if (typeof store?.readImageRequest !== 'function') {
        throw new LlmError('Image input needs the harness attachment service, which is unavailable on this route', 'UNSUPPORTED_CONTENT');
      }
      const images = new Map();
      const projectedImageText = new Map();
      let totalBytes = 0;
      for (const attachment of occurrences) {
        const id = attachment?.attachmentId;
        if (typeof id !== 'string' || id === '' || images.has(id) || projectedImageText.has(id)) continue;
        if (images.size >= MAX_REQUEST_IMAGES || totalBytes >= MAX_REQUEST_IMAGE_BYTES) {
          projectedImageText.set(id, imageHandleText(attachment));
          continue;
        }
        let version;
        try {
          version = await store.readImageRequest(attachment, imageTargetOf(attachment), signal);
        } catch (error) {
          throw new LlmError(`cannot read image attachment: ${error?.message ?? String(error)}`, 'UNSUPPORTED_CONTENT', { cause: error });
        }
        const bytes = Number(version?.bytes) > 0 ? Number(version.bytes) : Buffer.byteLength(version?.data ?? '');
        totalBytes += bytes;
        images.set(id, version);
      }
      return { images, projectedImageText };
    }

    async *#generate(callOptions, preparedInfo) {
      const signal = callOptions.signal;
      if (signal?.aborted === true) throw new LlmError('Antigravity request aborted', 'ABORTED');
      let info = preparedInfo;
      if (info === undefined) {
        try {
          info = await this.resolveModel(provider, callOptions.model, signal);
        } catch (error) {
          throw this.#toLlmError(error, signal);
        }
      }
      let api;
      let project;
      try {
        ({ api } = await runtime());
        project = await api.projectId(signal);
      } catch (error) {
        throw this.#toLlmError(error, signal);
      }
      let preparedImages;
      try {
        preparedImages = await this.#prepareImages(callOptions.messages, signal);
      } catch (error) {
        throw this.#toLlmError(error, signal);
      }

      // The backend rejects some first-person system prompts with a misleading
      // 429; the converter already moves known-risky paragraphs into the opening
      // user turn. If an unknown prompt shape is still rejected, retry once with
      // the whole system prompt delivered as user content.
      let delivery = this.userSystemFallback ? 'user' : 'system';
      let attempt = 0;
      for (;;) {
        const envelope = buildRequest({
          provider,
          model: callOptions.model,
          project,
          system: callOptions.system,
          systemDelivery: delivery,
          messages: callOptions.messages,
          tools: callOptions.tools,
          maxTokens: callOptions.maxTokens,
          defaultMaxTokens: info.defaultMaxTokens,
          temperature: callOptions.temperature,
          temperatureAccepts: !TEMPERATURE_REJECTED.test(callOptions.model),
          stopSequences: callOptions.stop,
          reasoningEffort: callOptions.reasoningEffort,
          images: preparedImages?.images,
          projectedImageText: preparedImages?.projectedImageText,
          signatureFallback: SIGNATURE_REQUIRED_MODEL.test(callOptions.model),
        });
        const hadSystemInstruction = envelope.request.systemInstruction !== undefined;
        const { _wireToOriginal, ...wireRequest } = envelope;
        const frames = api.stream(wireRequest, { signal, attribution: attribution() });
        let produced = false;
        try {
          for await (const chunk of translateStream(frames, { provider, model: callOptions.model, wireToOriginal: _wireToOriginal })) {
            produced = true;
            yield chunk;
          }
          return;
        } catch (error) {
          const canRetryAsUser = !produced
            && attempt === 0
            && delivery === 'system'
            && hadSystemInstruction
            && error instanceof HttpError
            && error.status === 429;
          if (canRetryAsUser) {
            attempt = 1;
            delivery = 'user';
            this.userSystemFallback = true;
            logger.warn?.('[antigravity] the backend rejected the systemInstruction; retrying with the prompt delivered as user content');
            continue;
          }
          const mapped = this.#toLlmError(error, signal);
          logger.warn?.(`[antigravity] ${callOptions.model} request failed: ${mapped.code} ${mapped.message.slice(0, 400)}`);
          throw mapped;
        }
      }
    }

    #toLlmError(error, signal) {
      if (error instanceof LlmError) return error;
      if (error !== null && typeof error === 'object' && typeof error.llmCode === 'string') {
        return new LlmError(error.message, error.llmCode, { cause: error });
      }
      if (error instanceof AuthError) {
        return new LlmError(error.message, error.llmCode, { cause: error });
      }
      if (error instanceof HttpError) {
        const text = `${error.message} ${error.body ?? ''}`;
        if (error.status === 400) {
          const code = contextWindowMessage(text) ? 'CONTEXT_WINDOW_EXCEEDED' : 'HTTP_400';
          return new LlmError(error.message, code, { cause: error, status: error.status });
        }
        if (error.status === 401 || error.status === 403) {
          return new LlmError(error.message, 'AUTH', { cause: error, status: error.status });
        }
        if (error.status === 404) return new LlmError(error.message, 'UNKNOWN_MODEL', { cause: error, status: error.status });
        if (error.status === 429) {
          const hint =
            'Antigravity is throttling or out of capacity for this model right now. Retry in about a minute, '
            + 'or pick another model (for example Gemini 3.8 Flash (Medium), Gemini 3 Flash, or Claude Sonnet 4.6).';
          return new LlmError(`${error.message} ${hint}`, 'RATE_LIMIT', {
            cause: error,
            status: error.status,
            ...(error.retryAfterMs !== undefined ? { providerRetryAfterMs: error.retryAfterMs } : {}),
          });
        }
        if (error.status >= 500) return new LlmError(error.message, 'SERVER', { cause: error, status: error.status });
        return new LlmError(error.message, `HTTP_${error.status}`, { cause: error, status: error.status });
      }
      if (signal?.aborted === true) return new LlmError('Antigravity request aborted', 'ABORTED', { cause: error });
      const name = error?.name ?? '';
      if (name === 'AbortError' || name === 'AbortSignal') return new LlmError('Antigravity request aborted', 'ABORTED', { cause: error });
      if (/timed out|timeout/i.test(error?.message ?? '')) return new LlmError(error.message, 'TIMEOUT', { cause: error });
      return new LlmError(`Antigravity transport failed: ${error?.message ?? String(error)}`, 'TRANSPORT', { cause: error });
    }
  })();
}
