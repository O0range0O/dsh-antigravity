import crypto from 'node:crypto';
import { resolveProxy, Transport } from './transport.js';
import { AuthStore } from './auth.js';
import { AntigravityApi } from './api.js';
import { createAdapter } from './provider.js';
import { createFileLogger } from './log-file.js';
import { QuotaCache, normalizeQuotaSummary } from './quota.js';
import { resolveClientVersion } from './client-version.js';

export const PROVIDER = 'antigravity';
export const SETTINGS_NAMESPACE = 'llm-antigravity';
export const QUOTA_PATH = '/antigravity/quota';
export const VERSION = '1.1.0';

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function nonEmptyString(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** Normalize the raw loader-row config into plain provider options. */
export function normalizeOptions(config = {}) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  return {
    displayName: nonEmptyString(raw.displayName, 'Google Antigravity'),
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
    proxy: typeof raw.proxy === 'string' ? raw.proxy : '',
    proxyRefreshMs: positiveInt(raw.proxyRefreshMs, 15_000),
    clientVersion: typeof raw.clientVersion === 'string' ? raw.clientVersion.trim() : '',
    project: typeof raw.project === 'string' ? raw.project : '',
    tokenFile: typeof raw.tokenFile === 'string' ? raw.tokenFile : '',
    catalogTtlMs: positiveInt(raw.catalogTtlMs, 300_000),
    requestTimeoutMs: positiveInt(raw.requestTimeoutMs, 900_000),
    idleTimeoutMs: positiveInt(raw.idleTimeoutMs, 300_000),
    retryMaxRetries: nonNegativeInt(raw.retryMaxRetries, 7),
    retryMaxDelayMs: positiveInt(raw.retryMaxDelayMs, 30_000),
    quotaTtlMs: positiveInt(raw.quotaTtlMs, 60_000),
    oauthClientId: typeof raw.oauthClientId === 'string' ? raw.oauthClientId.trim() : '',
    oauthClientSecret: typeof raw.oauthClientSecret === 'string' ? raw.oauthClientSecret.trim() : '',
    extraModels: Array.isArray(raw.extraModels)
      ? raw.extraModels.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
      : [],
  };
}

/**
 * Register the Antigravity provider on one agent context.
 * @returns {() => void} disposer that unregisters the route and closes the pool.
 */
export function createPlugin({ ctx, config, LlmAdapter, LlmError, attributionHeaders, resolveRetryPolicy, version = VERSION }) {
  const options = normalizeOptions(config);
  const fileLogger = createFileLogger();
  const safeLog = (level, message) => {
    try {
      fileLogger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](message);
    } catch {
      // Logging must never break provider registration.
    }
    try {
      const logger = ctx.logger;
      if (logger !== undefined && typeof logger[level] === 'function') logger[level](message);
    } catch {
      // Logging must never break provider registration.
    }
  };
  const logger = {
    warn: (message) => safeLog('warn', message),
    info: (message) => safeLog('info', message),
    error: (message) => safeLog('error', message),
  };

  let runtimePromise;
  let disposed = false;

  const runtime = () => {
    if (runtimePromise === undefined) {
      runtimePromise = (async () => {
        const transport = new Transport({
          proxy: options.proxy,
          refreshMs: options.proxyRefreshMs,
          logger,
        });
        transport.assertUsable();
        const auth = new AuthStore({
          tokenFile: options.tokenFile,
          transport,
          logger,
          oauthClientId: options.oauthClientId,
          oauthClientSecret: options.oauthClientSecret,
        });
        const clientVersion = await resolveClientVersion(options.clientVersion, logger);
        const api = new AntigravityApi({
          transport,
          auth,
          endpoint: options.endpoint,
          clientVersion,
          project: options.project,
          timeoutMs: options.requestTimeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          logger,
        });
        const route = await transport.describe();
        logger.info(`[antigravity] transport ready: ${route}${auth.email ? `; signed in as ${auth.email}` : ''}`);
        const quota = new QuotaCache({
          ttlMs: options.quotaTtlMs,
          logger,
          load: async () => normalizeQuotaSummary(await api.quotaSummary(), { email: auth.email }),
        });
        const resolveAttachments = () => {
          try {
            return ctx.get('attachments');
          } catch {
            return undefined;
          }
        };
        return { transport, auth, api, quota, resolveAttachments };
      })().catch((error) => {
        runtimePromise = undefined;
        logger.warn(`[antigravity] transport setup failed: ${error.message}`);
        throw error;
      });
    }
    return runtimePromise;
  };

  const attribution = () => {
    try {
      return typeof attributionHeaders === 'function' ? attributionHeaders() : {};
    } catch {
      return {};
    }
  };

  // Antigravity throttles per model and reports it as 429 RESOURCE_EXHAUSTED,
  // usually without a retryDelay. The default harness policy gives up after
  // ~15 s of backoff, which is shorter than a typical one-minute capacity
  // window, so this route retries longer before surfacing the failure.
  let retryPolicy;
  try {
    const retryConfig = {
      mode: 'normal',
      maxRetries: options.retryMaxRetries,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 1000, maxDelayMs: options.retryMaxDelayMs, jitterRatio: 0.2 },
    };
    retryPolicy = typeof resolveRetryPolicy === 'function' ? resolveRetryPolicy(retryConfig, 'llm-antigravity.retryPolicy') : retryConfig;
  } catch (error) {
    logger.warn(`[antigravity] cannot resolve the retry policy: ${error.message}`);
  }

  logger.info(
    `[antigravity] plugin v${version} applied; proxy setting="${options.proxy === '' ? 'auto' : options.proxy}"; displayName="${options.displayName}"`,
  );
  logger.info(
    `[antigravity] retry policy: maxRetries=${retryPolicy?.maxRetries ?? 'default'} maxDelayMs=${retryPolicy?.maxDelayMs ?? 'default'}`,
  );

  const adapter = createAdapter({ provider: PROVIDER, options, runtime, LlmAdapter, LlmError, attribution, logger, retryPolicy });
  const disposeAdapter = ctx.llm.registerAdapter([PROVIDER], adapter);

  let disposeDirectory;
  try {
    disposeDirectory = ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER,
        displayName: options.displayName,
        settingsNs: ctx.fiber?.entry?.options?.id ?? SETTINGS_NAMESPACE,
        settingsPath: [],
      },
    ]);
  } catch (error) {
    logger.warn(`[antigravity] cannot declare the provider in the settings directory: ${error.message}`);
  }

  logger.info(`[antigravity] provider "${PROVIDER}" registered as "${options.displayName}"`);

  // Browser widget data: one authenticated, cached read per minute. Plain page
  // fetches carry no peer identity (only the connection's own /api channel
  // does), so the route resolves the signed browser cookie through the
  // connection service and also accepts a per-process token injected into the
  // authenticated index HTML. The web layer mounts after this plugin on a cold
  // boot, so the route waits for `webServer` instead of probing once.
  const quotaToken = crypto.randomBytes(24).toString('base64url');
  let lastQuotaLogAt = 0;
  const wireQuotaEndpoint = (webServer) => {
    const disposeRoute = webServer.register({
      kind: 'exact',
      path: QUOTA_PATH,
      resource: async (request, peer) => {
        const json = (status, body) => new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
        const url = new URL(request.url, 'http://localhost');
        let admittedPeer = peer;
        // Plain browser fetches reach a registered route without a Peer; the
        // signed browser cookie is resolved by the connection service instead.
        if (admittedPeer === undefined || admittedPeer?.principal?.kind !== 'owner') {
          const connection = ctx.get('connection');
          if (connection !== undefined && typeof connection.admit === 'function') {
            try {
              const admission = connection.admit({ headers: request.headers });
              if (admission !== undefined && admission.peer !== undefined) admittedPeer = admission.peer;
            } catch (error) {
              logger.warn(`[antigravity] quota endpoint peer admission failed: ${error.message}`);
            }
          }
        }
        const principal = admittedPeer?.principal?.kind;
        const presented = request.headers.get('x-antigravity-quota') ?? url.searchParams.get('token') ?? '';
        const viaToken = presented !== '' && presented === quotaToken;
        const trusted = principal === 'owner' || viaToken;
        if (!trusted) {
          const seen = ['origin', 'sec-fetch-site', 'host']
            .map((name) => `${name}=${request.headers.get(name) === null ? '-' : String(request.headers.get(name)).slice(0, 60)}`)
            .join(' ');
          logger.warn(`[antigravity] quota endpoint rejected a request (peer=${principal ?? 'none'}, token=${presented === '' ? 'absent' : 'invalid'}; ${seen})`);
          return json(403, { ok: false, error: { code: 'FORBIDDEN', message: 'the Antigravity quota endpoint requires the authenticated page' } });
        }
        const now = Date.now();
        if (now - lastQuotaLogAt > 10 * 60_000) {
          lastQuotaLogAt = now;
          logger.info(`[antigravity] quota endpoint request (peer=${principal ?? 'none'}, via=${viaToken ? 'token' : 'cookie'})`);
        }
        try {
          const { quota } = await runtime();
          const data = await quota.get({ force: url.searchParams.get('refresh') === '1' });
          return json(200, { ok: true, data });
        } catch (error) {
          logger.warn(`[antigravity] quota read failed: ${error.message}`);
          return json(200, { ok: false, error: { code: error?.llmCode ?? 'QUOTA_UNAVAILABLE', message: error?.message ?? String(error) } });
        }
      },
    });
    const disposeTap = typeof webServer.tapIndex === 'function'
      ? webServer.tapIndex((html) => {
        const script = `<script>window.__DSH_ANTIGRAVITY_QUOTA__=${JSON.stringify({ token: quotaToken })};</script>`;
        return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`;
      })
      : undefined;
    logger.info(`[antigravity] quota endpoint registered at ${QUOTA_PATH}`);
    return () => {
      try {
        disposeRoute();
      } catch {
        // Already removed by the owning fiber.
      }
      try {
        disposeTap?.();
      } catch {
        // Already removed by the owning fiber.
      }
    };
  };
  try {
    ctx.inject(['webServer'], (child) => {
      try {
        child.effect(() => wireQuotaEndpoint(child.webServer));
      } catch (error) {
        logger.warn(`[antigravity] cannot register the quota endpoint: ${error.message}`);
      }
    });
  } catch (error) {
    logger.warn(`[antigravity] cannot wait for the web server: ${error.message}`);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    logger.info('[antigravity] plugin disposed');
    try {
      disposeAdapter();
    } catch {
      // Already disposed by the owning fiber.
    }
    try {
      disposeDirectory?.();
    } catch {
      // Already disposed by the owning fiber.
    }
    runtimePromise?.then(({ transport }) => transport.close()).catch(() => {});
  };
}
