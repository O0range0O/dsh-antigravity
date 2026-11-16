/**
 * Proxy-aware HTTP/SSE transport for the Antigravity provider.
 *
 * DSH's host process is Node, so it never inherits Chromium's proxy handling,
 * and the Antigravity backend geo-gates inference by client IP. This module
 * therefore routes every request through a proxy the same way the Antigravity
 * IDE's Chromium half would:
 *
 *   1. explicit `proxy` config (`http://host:port`, or `direct`);
 *   2. otherwise HTTPS_PROXY / HTTP_PROXY / ALL_PROXY;
 *   3. otherwise the current user's Windows system proxy (Internet Settings).
 *
 * In auto mode the route is re-resolved periodically and on failures, so the
 * operator can switch their VPN client between "system proxy" and "TUN" mode
 * while DSH keeps running:
 *  - an unreachable proxy falls back to a direct connection (TUN captures it);
 *  - a direct connection rejected for location retries through the system proxy.
 *
 * Only `http://host:port` CONNECT proxies are supported, which covers local
 * Clash/sing-box/Xray style clients.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';

const CONNECT_TIMEOUT_MS = 20_000;
const MAX_CONNECT_RESPONSE_BYTES = 64 * 1024;
const SYSTEM_PROXY_TTL_MS = 5_000;
const DIRECT_FALLBACK_MS = 60_000;
const PROXY_FALLBACK_MS = 300_000;

/** A provider HTTP failure with the status Google returned. */
export class HttpError extends Error {
  constructor(message, status, { body = '', retryAfterMs, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
}

/** A transport-level failure (DNS, TCP, TLS, proxy tunnel), not an HTTP status. */
export class NetworkError extends Error {
  constructor(message, { route, cause } = {}) {
    super(message);
    this.name = 'NetworkError';
    this.route = route;
    this.cause = cause;
  }
}

/** Parse `host:port`, `http://host:port` and `http://user:pass@host:port` forms. */
export function parseProxyUrl(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value === '') return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  if (url.protocol !== 'http:') {
    throw new Error(`unsupported proxy protocol "${url.protocol}" (only http:// CONNECT proxies are supported)`);
  }
  return {
    host: url.hostname,
    port: Number(url.port || 80),
    auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined,
    label: `${url.hostname}:${url.port || 80}`,
  };
}

function proxyKey(proxy) {
  return proxy === null ? 'direct' : `${proxy.host}:${proxy.port}`;
}

function runPowerShell(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (error, stdout) => resolve({ error, stdout: String(stdout ?? '') }),
    );
  });
}

let windowsProxyCache;
async function windowsSystemProxy() {
  const now = Date.now();
  if (windowsProxyCache !== undefined && now - windowsProxyCache.at < SYSTEM_PROXY_TTL_MS) return windowsProxyCache.value;
  const script = [
    "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue;",
    'if($p -and $p.ProxyEnable -eq 1){[string]$p.ProxyServer}else{""}',
  ].join(' ');
  const { stdout } = await runPowerShell(script);
  const raw = stdout.trim();
  let value = null;
  if (raw !== '') {
    // ProxyServer is either "host:port" or "http=host:port;https=host:port".
    const match = /(?:https?=)?([A-Za-z0-9.\-_]+):(\d{1,5})/.exec(raw);
    if (match) value = `http://${match[1]}:${match[2]}`;
  }
  windowsProxyCache = { at: now, value };
  return value;
}

/**
 * Resolve the proxy the provider should prefer.
 * @param {string | undefined} explicit
 *   `''`/`auto`: environment then Windows system proxy; `direct`/`none`/`off`: never;
 *   otherwise a proxy URL.
 * @returns {Promise<{host:string, port:number, auth?:string, label:string} | null>}
 */
export async function resolveProxy(explicit) {
  const value = typeof explicit === 'string' ? explicit.trim() : '';
  if (value !== '') {
    if (/^(direct|none|off)$/i.test(value)) return null;
    return parseProxyUrl(value);
  }
  const env = process.env;
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (fromEnv) {
    try {
      return parseProxyUrl(fromEnv);
    } catch {
      // Ignore a malformed environment value and fall through to the OS setting.
    }
  }
  if (process.platform === 'win32') {
    const detected = await windowsSystemProxy();
    if (detected) {
      try {
        return parseProxyUrl(detected);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function openTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length > MAX_CONNECT_RESPONSE_BYTES) {
        fail(new Error('proxy CONNECT response is too large'));
        return;
      }
      const index = buffer.indexOf('\r\n\r\n');
      if (index === -1) return;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      const head = buffer.subarray(0, index).toString('latin1');
      const rest = buffer.subarray(index + 4);
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
        fail(new Error(`proxy ${proxy.label} rejected CONNECT ${host}:${port}: ${head.split('\r\n')[0] ?? 'no status line'}`));
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setTimeout(0);
      if (rest.length > 0) socket.unshift(rest);
      socket.pause();
      resolve(socket);
    };
    const onError = (error) => fail(new Error(`cannot reach proxy ${proxy.label}: ${error.message}`, { cause: error }));
    timer = setTimeout(() => fail(new Error(`proxy ${proxy.label} CONNECT timed out`)), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`);
    });
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function openTlsSocket(proxy, host, port) {
  if (proxy === null) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'], timeout: CONNECT_TIMEOUT_MS });
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('secureConnect', () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once('error', fail);
      socket.once('timeout', () => fail(new Error(`TLS handshake with ${host} timed out`)));
    });
  }
  return openTunnel(proxy, host, port).then(
    (tunnel) =>
      new Promise((resolve, reject) => {
        const socket = tls.connect({ socket: tunnel, servername: host, ALPNProtocols: ['http/1.1'] });
        socket.once('secureConnect', () => resolve(socket));
        socket.once('error', (error) => {
          tunnel.destroy();
          reject(error);
        });
      }),
  );
}

/** `https.Agent` that opens every connection through the local CONNECT proxy. */
class ProxyAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: true, maxSockets: 6, maxFreeSockets: 2 });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const host = options.host ?? 'localhost';
    const port = Number(options.port ?? 443);
    openTlsSocket(this.proxy, host, port).then(
      (socket) => {
        socket.setNoDelay(true);
        callback(null, socket);
      },
      (error) => callback(error),
    );
  }
}

/**
 * One outbound connection pool whose route follows the proxy setting.
 *
 * `proxy: ''` / `undefined` selects auto mode; `'direct'`/`'none'`/`'off'`
 * disables the proxy; any other string is a fixed `http://host:port` proxy.
 */
export class Transport {
  /**
   * @param {{proxy?: string, refreshMs?: number, logger?: {warn?: Function, info?: Function}}} [options]
   */
  constructor(options = {}) {
    const raw = typeof options.proxy === 'string' ? options.proxy.trim() : '';
    this.mode = raw !== '' && !/^(auto|system)$/i.test(raw) ? (/^(direct|none|off)$/i.test(raw) ? 'direct' : 'fixed') : 'auto';
    this.fixedRaw = raw;
    this.fixedProxy = undefined;
    this.fixedError = undefined;
    if (this.mode === 'fixed') {
      try {
        this.fixedProxy = parseProxyUrl(raw);
      } catch (error) {
        this.fixedError = error;
      }
    }
    this.refreshMs = Number.isFinite(options.refreshMs) && options.refreshMs > 0 ? options.refreshMs : 15_000;
    this.logger = options.logger;
    this.resolved = { at: 0, proxy: this.mode === 'direct' ? null : undefined };
    this.directUntil = 0;
    this.proxyUntil = 0;
    this.directAgent = undefined;
    this.proxyAgent = undefined;
    this.agentKey = '';
    this.closed = false;
    this.lastRoute = undefined;
  }

  /** Describe the route currently in effect, for diagnostics. */
  async describe() {
    const proxy = await this.resolveEffective();
    return proxy === null ? 'direct' : `proxy ${proxy.label}`;
  }

  /** The route key without side effects (best effort); used for change detection. */
  currentRouteKey() {
    if (this.agentKey !== '') return this.agentKey;
    return this.mode === 'direct' ? 'direct' : 'unknown';
  }

  /** Fail before dispatch when the configured proxy URL itself is invalid. */
  assertUsable() {
    if (this.fixedError !== undefined) throw new NetworkError(`invalid proxy setting "${this.fixedRaw}": ${this.fixedError.message}`, { route: this.fixedRaw });
  }

  async resolveEffective(force = false) {
    this.assertUsable();
    if (this.mode === 'direct') return null;
    if (this.mode === 'fixed') return this.fixedProxy;
    const now = Date.now();
    if (!force && now < this.directUntil) return null;
    if (!force && now < this.proxyUntil) {
      const proxy = await this.#systemProxy(false);
      return proxy ?? null;
    }
    const fresh = force || now - this.resolved.at >= this.refreshMs || this.resolved.proxy === undefined;
    if (!fresh) return this.resolved.proxy ?? null;
    const previousKey = this.agentKey;
    const proxy = await this.#systemProxy(true);
    this.resolved = { at: Date.now(), proxy };
    if (previousKey !== '' && previousKey !== proxyKey(proxy)) {
      this.logger?.info?.(`[antigravity] proxy route changed to ${proxy === null ? 'direct' : proxy.label}`);
    }
    return proxy ?? null;
  }

  async #systemProxy(forceEnvironment = false) {
    if (forceEnvironment) {
      const env = process.env;
      const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
      if (fromEnv) {
        try {
          return parseProxyUrl(fromEnv);
        } catch {
          // Fall through to the Windows setting.
        }
      }
    }
    if (process.platform === 'win32') {
      try {
        const raw = await windowsSystemProxy();
        return raw === null ? null : parseProxyUrl(raw);
      } catch {
        return null;
      }
    }
    return null;
  }

  #agentFor(proxy) {
    const key = proxyKey(proxy);
    if (key === this.agentKey && (proxy === null ? this.directAgent !== undefined : this.proxyAgent !== undefined)) {
      return proxy === null ? this.directAgent : this.proxyAgent;
    }
    this.directAgent?.destroy();
    this.proxyAgent?.destroy();
    this.directAgent = undefined;
    this.proxyAgent = undefined;
    this.agentKey = key;
    if (proxy === null) {
      this.directAgent = new https.Agent({ keepAlive: true, maxSockets: 6, maxFreeSockets: 2 });
      return this.directAgent;
    }
    this.proxyAgent = new ProxyAgent(proxy);
    return this.proxyAgent;
  }

  /** Turn a proxy rejection or location rejection into a different route. */
  markLocationBlocked() {
    if (this.mode !== 'auto') return false;
    const now = Date.now();
    if (proxyKey(this.resolved.proxy ?? null) === 'direct' || now < this.directUntil) {
      this.directUntil = 0;
      this.proxyUntil = now + PROXY_FALLBACK_MS;
      this.resolved = { at: 0, proxy: undefined };
      this.logger?.warn?.('[antigravity] the direct route was location-blocked; retrying through the system proxy');
      return true;
    }
    this.proxyUntil = 0;
    this.directUntil = now + DIRECT_FALLBACK_MS;
    this.resolved = { at: 0, proxy: undefined };
    this.logger?.warn?.('[antigravity] the proxy route was location-blocked; retrying with a direct connection');
    return true;
  }

  #isConnectionFailure(error) {
    if (error instanceof NetworkError) return true;
    const code = error?.code ?? '';
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) return true;
    const message = String(error?.message ?? '');
    return /proxy .* (?:connect|reach|CONNECT|timed out)|socket hang up/i.test(message);
  }

  async #noteConnectionFailure(proxy) {
    if (this.mode !== 'auto' || proxy === null) return false;
    this.proxyUntil = 0;
    this.directUntil = Date.now() + DIRECT_FALLBACK_MS;
    this.resolved = { at: 0, proxy: undefined };
    this.logger?.warn?.(`[antigravity] proxy ${proxy.label} is unreachable; using a direct connection until it recovers`);
    return true;
  }

  /**
   * Open a request and hand back the streaming response once headers arrive.
   * @returns {Promise<import('node:http').IncomingMessage>}
   */
  async open(options) {
    if (this.closed) throw new NetworkError('the Antigravity transport is closed');
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proxy = await this.resolveEffective();
      const agent = this.#agentFor(proxy);
      try {
        this.lastRoute = proxyKey(proxy);
        return await this.#openOnce(options, agent, proxy);
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) throw error;
        if (!this.#isConnectionFailure(error)) throw error;
        const changed = await this.#noteConnectionFailure(proxy);
        if (!changed) throw error;
      }
    }
    throw lastError;
  }

  async #openOnce({ url, method = 'POST', headers = {}, body, signal, timeoutMs = 600_000, idleTimeoutMs = 300_000 }, agent, proxy) {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new Error(`unsupported URL protocol "${target.protocol}" (https only)`);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const deadline = setTimeout(() => controller.abort(new Error(`request to ${target.host} timed out after ${timeoutMs}ms`)), timeoutMs);
    const requestOptions = {
      method,
      host: target.hostname,
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      headers: { host: target.host, 'accept-encoding': 'identity', ...headers },
      agent,
      signal: controller.signal,
    };
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    if (payload !== undefined) requestOptions.headers['content-length'] = String(payload.byteLength);

    return await new Promise((resolve, reject) => {
      const request = https.request(requestOptions, (response) => {
        clearTimeout(deadline);
        response.setEncoding('utf8');
        // Idle detection sits on the socket: an event listener on `response`
        // would switch the stream to flowing mode and drop the chunks that
        // arrive before the async iterator attaches.
        const socket = response.socket ?? request.socket;
        if (socket !== undefined && socket !== null) {
          const endIdle = () => socket.setTimeout(0);
          socket.setTimeout(idleTimeoutMs, () => {
            request.destroy(new Error(`stream from ${target.host} idle for ${idleTimeoutMs}ms`));
          });
          response.once('end', endIdle);
          response.once('close', endIdle);
          response.once('error', endIdle);
        }
        resolve(response);
      });
      request.once('error', (error) => {
        clearTimeout(deadline);
        if (signal?.aborted) {
          const aborted = new Error('request aborted by the caller');
          aborted.name = 'AbortError';
          reject(aborted);
          return;
        }
        reject(new NetworkError(error?.message ?? 'request failed', { route: proxyKey(proxy), cause: error }));
      });
      if (payload !== undefined) request.write(payload);
      request.end();
      if (signal) signal.addEventListener('abort', () => request.destroy(new Error('request aborted')), { once: true });
    });
  }

  /** Read a complete response body as text. */
  async requestText({ url, method = 'POST', headers = {}, body, signal, timeoutMs, idleTimeoutMs }) {
    const response = await this.open({ url, method, headers, body, signal, timeoutMs, idleTimeoutMs });
    let text = '';
    for await (const chunk of response) text += chunk;
    return { status: response.statusCode ?? 0, headers: response.headers, text };
  }

  /** Stream Server-Sent-Events payload strings (the raw `data:` value). */
  async *sse({ url, method = 'POST', headers = {}, body, signal, timeoutMs, idleTimeoutMs }) {
    const response = await this.open({ url, method, headers, body, signal, timeoutMs, idleTimeoutMs });
    const status = response.statusCode ?? 0;
    if (status < 200 || status > 299) {
      let text = '';
      for await (const chunk of response) text += chunk;
      throw httpErrorFromResponse(status, response.headers, text);
    }
    let buffer = '';
    let dataLines = [];
    for await (const chunk of response) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (dataLines.length > 0) {
            const payload = dataLines.join('\n');
            dataLines = [];
            if (payload !== '[DONE]') yield payload;
          }
          continue;
        }
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length > 0) {
      const payload = dataLines.join('\n');
      if (payload !== '[DONE]') yield payload;
    }
  }

  close() {
    this.closed = true;
    this.directAgent?.destroy();
    this.proxyAgent?.destroy();
  }
}

/** Build the provider error for a non-2xx Google RPC response. */
export function httpErrorFromResponse(status, headers, text) {
  let message = text?.trim() || `HTTP ${status}`;
  let retryAfterMs;
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    if (error) {
      const parts = [error.message, error.status ? `(${error.status})` : ''].filter(Boolean);
      if (parts.length > 0) message = parts.join(' ');
      const details = Array.isArray(error.details) ? error.details : [];
      for (const detail of details) {
        if (typeof detail?.retryDelay === 'string') {
          const match = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay);
          if (match) retryAfterMs = Math.ceil(Number(match[1]) * 1000);
        }
      }
    }
  } catch {
    // Non-JSON bodies keep their raw text.
  }
  const retryHeader = headers?.['retry-after'];
  if (retryAfterMs === undefined && typeof retryHeader === 'string' && /^\d+$/.test(retryHeader)) {
    retryAfterMs = Number(retryHeader) * 1000;
  }
  return new HttpError(message, status, { body: text, retryAfterMs });
}

export { http };
