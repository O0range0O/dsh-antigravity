/**
 * Google Antigravity (Cloud Code Assist `v1internal`) API client.
 *
 * Endpoints verified against the Antigravity desktop application and the
 * open-source Antigravity client reimplementations:
 *  - `POST /v1internal:loadCodeAssist`        entitlement + managed project
 *  - `POST /v1internal:fetchAvailableModels`  model catalog + quota
 *  - `POST /v1internal:streamGenerateContent?alt=sse`  inference
 *
 * Inference is driven by the *inference* header profile (Antigravity browser
 * User-Agent plus a JSON `Client-Metadata`); management calls use the CLI
 * profile and enum-safe metadata.
 */
import { HttpError, httpErrorFromResponse } from './transport.js';

export const DEFAULT_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const FALLBACK_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const LIVE_FALLBACK_ENDPOINT = 'https://autopush-cloudcode-pa.sandbox.googleapis.com';

const CHROME = 'Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36';

/** The location rejection the backend returns when the egress IP is geo-blocked. */
const LOCATION_HINT =
  'The Antigravity backend geo-gates inference by the client IP. Configure the "proxy" field of the '
  + 'llm-antigravity plugin (for example "http://127.0.0.1:7890") or enable a VPN, then retry.';

/** Recognise the geo-block response on either failure status. */
export function isLocationError(error) {
  if (!(error instanceof HttpError)) return false;
  const text = `${error.message} ${error.body ?? ''}`;
  if (error.status === 400) return /User location is not supported/i.test(text);
  if (error.status === 403) return /(location|country|region)/i.test(text);
  return false;
}

function platformName() {
  if (process.platform === 'win32') return 'WINDOWS';
  if (process.platform === 'darwin') return 'MACOS';
  return 'LINUX';
}

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

export class AntigravityApi {
  /**
   * @param {{transport: import('./transport.js').Transport, auth: import('./auth.js').AuthStore,
   *   endpoint?: string, clientVersion?: string, project?: string, timeoutMs?: number,
   *   idleTimeoutMs?: number, logger?: {warn?: Function, info?: Function}}} options
   */
  constructor(options) {
    this.transport = options.transport;
    this.auth = options.auth;
    this.endpoint = (options.endpoint && options.endpoint.trim() !== '' ? options.endpoint.trim() : DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.clientVersion = options.clientVersion && options.clientVersion.trim() !== '' ? options.clientVersion.trim() : '2.32.0';
    this.configuredProject = options.project && options.project.trim() !== '' ? options.project.trim() : '';
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.logger = options.logger;
    this.projectPromise = undefined;
    this.catalog = undefined;
    this.catalogAt = 0;
  }

  /** Antigravity browser User-Agent used for inference. */
  get inferenceUserAgent() {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${this.clientVersion} ${CHROME}`;
  }

  /** Antigravity CLI User-Agent used for management RPCs. */
  get cliUserAgent() {
    return `antigravity/${this.clientVersion} (aidev_client; os_type=${osName()}; arch=amd64; auth_method=consumer)`;
  }

  inferenceHeaders(accessToken, attribution = {}) {
    return {
      ...attribution,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': this.inferenceUserAgent,
      'x-goog-api-client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'client-metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform: platformName(), pluginType: 'GEMINI' }),
    };
  }

  managementHeaders(accessToken, attribution = {}) {
    return {
      ...attribution,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': this.cliUserAgent,
    };
  }

  /** Enum-safe client metadata for `loadCodeAssist`/`onboardUser`. */
  static managementMetadata() {
    return { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
  }

  async #postJson(path, body, { signal, attribution } = {}) {
    const attempt = async (token) =>
      await this.transport.requestText({
        url: `${this.endpoint}${path}`,
        method: 'POST',
        headers: this.managementHeaders(token, attribution),
        body: JSON.stringify(body ?? {}),
        signal,
        timeoutMs: 120_000,
        idleTimeoutMs: 120_000,
      });
    let token = await this.auth.accessToken(signal);
    let response = await attempt(token);
    if (response.status === 401) {
      token = await this.auth.refreshNow(signal);
      response = await attempt(token);
    }
    if (response.status < 200 || response.status > 299) {
      const error = httpErrorFromResponse(response.status, response.headers, response.text);
      if (isLocationError(error) && this.transport.markLocationBlocked()) {
        const retried = await attempt(token);
        if (retried.status < 200 || retried.status > 299) throw httpErrorFromResponse(retried.status, retried.headers, retried.text);
        try {
          return JSON.parse(retried.text);
        } catch (cause) {
          throw new HttpError(`Antigravity ${path} returned malformed JSON`, retried.status, { body: retried.text, cause });
        }
      }
      throw error;
    }
    try {
      return JSON.parse(response.text);
    } catch (cause) {
      throw new HttpError(`Antigravity ${path} returned malformed JSON`, response.status, { body: response.text, cause });
    }
  }

  /** Resolve the Cloud Code Assist managed project used by the `project` field. */
  async projectId(signal) {
    if (this.configuredProject !== '') return this.configuredProject;
    if (this.projectPromise === undefined) {
      this.projectPromise = this.#loadProject(signal).catch((error) => {
        this.projectPromise = undefined;
        throw error;
      });
    }
    return await this.projectPromise;
  }

  async #loadProject(signal) {
    let response;
    try {
      response = await this.#postJson('/v1internal:loadCodeAssist', { metadata: AntigravityApi.managementMetadata() }, { signal });
    } catch (error) {
      if (error instanceof HttpError && error.status >= 500) {
        this.logger?.warn?.(`[antigravity] loadCodeAssist failed on ${this.endpoint}: ${error.message}`);
      }
      throw error;
    }
    const project = response?.cloudaicompanionProject;
    const id = typeof project === 'string' ? project : typeof project?.id === 'string' ? project.id : '';
    if (id !== '') return id;
    this.logger?.warn?.('[antigravity] loadCodeAssist returned no managed project; using the consumer default');
    return 'aicode-consumers';
  }

  /**
   * Fetch the model catalog for this account.
   * @returns {Promise<Map<string, object>>}
   */
  async availableModels(signal) {
    const payload = await this.#postJson('/v1internal:fetchAvailableModels', {}, { signal });
    const models = new Map();
    for (const [id, info] of Object.entries(payload?.models ?? {})) {
      if (info === null || typeof info !== 'object') continue;
      models.set(id, { id, ...info });
    }
    this.catalog = models;
    this.catalogAt = Date.now();
    return models;
  }

  /**
   * Fetch the subscription quota summary (5-hour and weekly windows per group).
   * @returns {Promise<object>} raw `retrieveUserQuotaSummary` body
   */
  async quotaSummary(signal) {
    return await this.#postJson('/v1internal:retrieveUserQuotaSummary', {}, { signal });
  }

  get cachedModels() {
    return this.catalog;
  }

  get cachedAt() {
    return this.catalogAt;
  }

  #sseOnce(body, token, { signal, attribution } = {}) {
    const url = `${this.endpoint}/v1internal:streamGenerateContent?alt=sse`;
    return this.transport.sse({
      url,
      method: 'POST',
      headers: this.inferenceHeaders(token, attribution),
      body: JSON.stringify(body),
      signal,
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
    });
  }

  /**
   * Stream one inference request, translating the outer SSE envelope.
   * @param {object} body complete `v1internal` request envelope
   * @param {{signal?: AbortSignal, attribution?: object}} options
   * @returns {AsyncGenerator<object>}
   */
  async *stream(body, { signal, attribution } = {}) {
    let token = await this.auth.accessToken(signal);
    try {
      for await (const payload of this.#sseOnce(body, token, { signal, attribution })) yield this.#parseFrame(payload);
      return;
    } catch (error) {
      if (error instanceof HttpError && error.status === 401 && signal?.aborted !== true) {
        token = await this.auth.refreshNow(signal);
        for await (const payload of this.#sseOnce(body, token, { signal, attribution })) yield this.#parseFrame(payload);
        return;
      }
      if (isLocationError(error) && this.transport.markLocationBlocked()) {
        // The route was switched (direct <-> system proxy); one fresh attempt.
        for await (const payload of this.#sseOnce(body, token, { signal, attribution })) yield this.#parseFrame(payload);
        return;
      }
      if (error instanceof HttpError && error.status >= 500 && this.endpoint === DEFAULT_ENDPOINT) {
        // The daily endpoint is down; the other hosts serve the same API.
        const previous = this.endpoint;
        this.endpoint = FALLBACK_ENDPOINT;
        try {
          for await (const payload of this.#sseOnce(body, token, { signal, attribution })) yield this.#parseFrame(payload);
          return;
        } catch (retryError) {
          this.endpoint = previous;
          throw retryError;
        }
      }
      throw this.#decorate(error);
    }
  }

  #parseFrame(payload) {
    try {
      return JSON.parse(payload);
    } catch (cause) {
      throw new HttpError('Antigravity stream returned a malformed SSE frame', 200, { body: payload, cause });
    }
  }

  #decorate(error) {
    if (!(error instanceof HttpError)) return error;
    if (isLocationError(error)) {
      const decorated = new HttpError(`${error.message} ${LOCATION_HINT}`, error.status, error);
      decorated.locationBlocked = true;
      return decorated;
    }
    return error;
  }
}
