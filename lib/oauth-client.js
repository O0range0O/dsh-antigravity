/**
 * Resolve the public OAuth client used to refresh the Antigravity grant.
 *
 * The repository intentionally stores no OAuth client credentials: GitHub blocks
 * publishing embedded Google client secrets, and they are not the user's data
 * anyway. The pair is resolved at runtime, in this order:
 *
 *  1. `DSH_ANTIGRAVITY_CLIENT_ID` + `DSH_ANTIGRAVITY_CLIENT_SECRET`;
 *  2. the `oauthClientId` / `oauthClientSecret` config fields;
 *  3. `$DSH_HOME/antigravity/oauth-client.json` (written after a successful
 *     discovery and refresh);
 *  4. the Antigravity desktop installation itself: its `language_server`
 *     binary embeds the public client pair, so it is extracted locally and
 *     validated by the refresh call (the first pair Google accepts is cached).
 *
 * @module dsh-antigravity/oauth-client
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIENT_ID_PATTERN = /[0-9]{6,}-[a-z0-9]{15,}\.apps\.googleusercontent\.com/g;
const CLIENT_SECRET_PREFIX = 'GOCSPX-';
/** Google client secrets embed a fixed-length suffix; neighbouring Go strings are concatenated in the binary. */
const CLIENT_SECRET_BODY_LENGTH = 28;
const CHUNK_SIZE = 8 * 1024 * 1024;
const OVERLAP = 256;
const MAX_CANDIDATES = 16;
const CACHE_VERSION = 1;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** `$DSH_HOME/antigravity/oauth-client.json` — the discovered pair cache. */
export function oauthClientCacheFile() {
  return path.join(dshHome(), 'antigravity', 'oauth-client.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file stays inside the user profile.
  }
}

/** Persist the pair that Google accepted, so discovery runs once. */
export function saveOAuthClient(pair) {
  if (typeof pair?.clientId !== 'string' || typeof pair?.clientSecret !== 'string') return;
  writeJson(oauthClientCacheFile(), {
    version: CACHE_VERSION,
    clientId: pair.clientId,
    clientSecret: pair.clientSecret,
    source: pair.source ?? 'discovered',
    updatedAt: new Date().toISOString(),
  });
}

/** Read the cached pair, if any. */
export function loadOAuthClient() {
  const cached = readJson(oauthClientCacheFile());
  if (cached?.version !== CACHE_VERSION) return undefined;
  if (typeof cached.clientId !== 'string' || typeof cached.clientSecret !== 'string') return undefined;
  return { clientId: cached.clientId, clientSecret: cached.clientSecret, source: 'cache' };
}

function candidateBinaries() {
  if (process.platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA === undefined ? undefined : path.join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter((root) => typeof root === 'string' && root !== '');
    return roots.flatMap((root) => [
      path.join(root, 'antigravity', 'resources', 'bin', 'language_server.exe'),
      path.join(root, 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    ]);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
      path.join(os.homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
    ];
  }
  return [
    path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server'),
    '/opt/antigravity/resources/bin/language_server',
  ];
}

/** Collect fixed-length Google client secrets from a chunk of latin1 text. */
function collectSecrets(text, into) {
  const prefix = CLIENT_SECRET_PREFIX;
  const total = prefix.length + CLIENT_SECRET_BODY_LENGTH;
  let index = text.indexOf(prefix);
  while (index !== -1) {
    const candidate = text.slice(index, index + total);
    if (candidate.length === total && /^[A-Za-z0-9_-]+$/.test(candidate.slice(prefix.length)) && !into.includes(candidate)) {
      into.push(candidate);
    }
    index = text.indexOf(prefix, index + prefix.length);
  }
}

/** Stream the binary and collect embedded OAuth client ids and secrets. */
function extractFromBinary(file) {
  const ids = [];
  const secrets = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let position = 0;
    let carry = '';
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, CHUNK_SIZE, position);
      if (bytes <= 0) break;
      const text = carry + buffer.toString('latin1', 0, bytes);
      for (const match of text.match(CLIENT_ID_PATTERN) ?? []) {
        if (!ids.includes(match) && ids.length < 8) ids.push(match);
      }
      collectSecrets(text, secrets);
      carry = text.slice(-OVERLAP);
      position += bytes;
    }
  } catch {
    return { ids: [], secrets: [] };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
  return { ids, secrets: secrets.slice(0, 8) };
}

function explicitPair(clientId, clientSecret, source) {
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return undefined;
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (id === '' || secret === '') return undefined;
  return { clientId: id, clientSecret: secret, source };
}

/**
 * List OAuth client candidates to try, most trustworthy first.
 * @param {{clientId?: string, clientSecret?: string, logger?: {info?: Function, warn?: Function}}} options
 * @returns {Promise<Array<{clientId: string, clientSecret: string, source: string}>>}
 */
export async function resolveOAuthClients(options = {}) {
  const logger = options.logger;
  const candidates = [];
  const seen = new Set();
  const push = (pair) => {
    if (pair === undefined) return;
    const key = `${pair.clientId}\u0000${pair.clientSecret}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(pair);
  };

  push(explicitPair(
    process.env.DSH_ANTIGRAVITY_CLIENT_ID,
    process.env.DSH_ANTIGRAVITY_CLIENT_SECRET,
    'environment',
  ));
  push(explicitPair(options.clientId, options.clientSecret, 'config'));
  push(loadOAuthClient());

  if (candidates.length === 0) {
    for (const binary of candidateBinaries()) {
      if (!fs.existsSync(binary)) continue;
      const { ids, secrets } = extractFromBinary(binary);
      if (secrets.length === 0) continue;
      for (const clientId of ids) {
        for (const clientSecret of secrets) {
          push({ clientId, clientSecret, source: 'antigravity-install' });
          if (candidates.length >= MAX_CANDIDATES) break;
        }
        if (candidates.length >= MAX_CANDIDATES) break;
      }
      if (candidates.length > 0) {
        logger?.info?.(`[antigravity] read the public OAuth client from ${binary}`);
        break;
      }
    }
  }

  if (candidates.length === 0) {
    logger?.warn?.(
      '[antigravity] no OAuth client available: install Antigravity, or set DSH_ANTIGRAVITY_CLIENT_ID and '
      + 'DSH_ANTIGRAVITY_CLIENT_SECRET (or the oauthClientId/oauthClientSecret config fields)',
    );
  }
  return candidates;
}
