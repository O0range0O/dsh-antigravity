/**
 * Google OAuth identity for the Antigravity provider.
 *
 * The provider reuses the Antigravity IDE's own sign-in: the desktop app stores
 * its OAuth grant in the Windows Credential Manager entry `gemini:antigravity`
 * (a JSON blob with an access token and a refresh token). When that is absent,
 * a refresh token supplied through the environment or the plugin's token file is
 * used instead. Access tokens are refreshed against Google's token endpoint
 * through the same proxy the model requests use.
 *
 * The public OAuth client used for that refresh is resolved at runtime by
 * `./oauth-client.js`; no client credentials are stored in this repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpError } from './transport.js';
import { resolveOAuthClients, saveOAuthClient } from './oauth-client.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_MARGIN_MS = 120_000;
const CREDENTIAL_TARGET = 'gemini:antigravity';

/** Failure raised by the credential layer; the provider maps it onto LlmError codes. */
export class AuthError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = 'AuthError';
    this.llmCode = code;
    this.cause = options.cause;
  }
}

/** Default token file: `$DSH_HOME/antigravity/auth.json` or `~/.dsh/antigravity/auth.json`. */
export function defaultAuthFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'antigravity', 'auth.json');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file stays inside the user profile.
  }
}

/**
 * Read a refresh token supplied through the environment, for platforms where
 * the Windows Credential Manager import does not apply and for automation.
 * The variable is `DSH_ANTIGRAVITY_REFRESH_TOKEN` (falling back to
 * `ANTIGRAVITY_REFRESH_TOKEN`); it may contain the bare token or a JSON object
 * with `refreshToken` / `refresh_token` and optional `email`.
 * @returns {{refreshToken: string, email?: string} | undefined}
 */
export function readRefreshTokenFromEnvironment() {
  const raw = process.env.DSH_ANTIGRAVITY_REFRESH_TOKEN ?? process.env.ANTIGRAVITY_REFRESH_TOKEN;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      const refreshToken = typeof parsed.refreshToken === 'string'
        ? parsed.refreshToken
        : typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '';
      if (refreshToken === '') return undefined;
      return { refreshToken, ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}) };
    } catch {
      return undefined;
    }
  }
  return { refreshToken: value };
}

function runPowerShellFile(scriptFile, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

/**
 * Read the Antigravity desktop app credential from the Windows Credential Manager.
 * @returns {Promise<{refreshToken: string, accessToken?: string, expiresAt?: number, email?: string}>}
 */
export async function readWindowsCredential(target = CREDENTIAL_TARGET) {
  if (process.platform !== 'win32') {
    throw new AuthError(
      'automatic Antigravity sign-in import reads the Windows Credential Manager and is only available on Windows. '
      + 'On other platforms provide the OAuth refresh token yourself: set DSH_ANTIGRAVITY_REFRESH_TOKEN, or point the '
      + 'plugin\'s tokenFile config field at a JSON file such as {"refreshToken":"<token>"}',
      'MISSING_CREDENTIAL',
    );
  }
  const script = fileURLToPath(new URL('./read-windows-credential.ps1', import.meta.url));
  const { error, stdout, stderr } = await runPowerShellFile(script);
  if (error) {
    throw new AuthError(
      `cannot read the Antigravity credential "${target}" from the Windows Credential Manager: ${stderr.trim() || error.message}. `
      + 'Sign in inside the Antigravity app once, or supply the refresh token through DSH_ANTIGRAVITY_REFRESH_TOKEN / the tokenFile config',
      'MISSING_CREDENTIAL',
      { cause: error },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new AuthError(`the Antigravity credential "${target}" is not valid JSON`, 'INVALID_CREDENTIAL', { cause });
  }
  const token = parsed?.token ?? parsed;
  const refreshToken = typeof token?.refresh_token === 'string' ? token.refresh_token : '';
  if (refreshToken === '') {
    throw new AuthError(`the Antigravity credential "${target}" carries no refresh token; open Antigravity and sign in again`, 'MISSING_CREDENTIAL');
  }
  const expiry = token?.expiry ?? token?.expiry_date ?? token?.expires_at;
  const expiresAt = typeof expiry === 'number' ? (expiry < 1e12 ? expiry * 1000 : expiry) : expiry ? Date.parse(expiry) : undefined;
  return {
    refreshToken,
    accessToken: typeof token?.access_token === 'string' ? token.access_token : undefined,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    email: typeof parsed?.id_token_email === 'string' ? parsed.id_token_email : undefined,
  };
}

/** Owns the access token used by one provider instance. */
export class AuthStore {
  constructor({ tokenFile, transport, logger, oauthClientId, oauthClientSecret } = {}) {
    this.file = tokenFile && tokenFile.trim() !== '' ? tokenFile.trim() : defaultAuthFile();
    this.transport = transport;
    this.logger = logger;
    this.oauthClientId = oauthClientId;
    this.oauthClientSecret = oauthClientSecret;
    this.state = readJsonFile(this.file);
    this.pending = undefined;
    this.clients = undefined;
  }

  get email() {
    return this.state?.email;
  }

  /** Return a usable access token, importing and refreshing as needed. */
  accessToken(signal) {
    if (this.pending === undefined) {
      this.pending = this.#ensureAccessToken(signal).finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  /** Force one refresh, used after the provider sees a 401. */
  async refreshNow(signal) {
    this.pending = undefined;
    if (typeof this.state?.refreshToken !== 'string' || this.state.refreshToken === '') {
      await this.#loadFromOs();
    }
    return await this.#refresh(signal);
  }

  async #ensureAccessToken(signal) {
    if (this.state?.accessToken && typeof this.state.expiresAt === 'number' && Date.now() < this.state.expiresAt - REFRESH_MARGIN_MS) {
      return this.state.accessToken;
    }
    if (typeof this.state?.refreshToken !== 'string' || this.state.refreshToken === '') {
      await this.#loadFromOs();
    }
    return await this.#refresh(signal);
  }

  async #loadFromOs() {
    const fromEnvironment = readRefreshTokenFromEnvironment();
    const imported = fromEnvironment ?? await readWindowsCredential();
    if (imported.accessToken && imported.expiresAt && Date.now() < imported.expiresAt - REFRESH_MARGIN_MS) {
      this.state = {
        version: 1,
        refreshToken: imported.refreshToken,
        accessToken: imported.accessToken,
        expiresAt: imported.expiresAt,
        email: imported.email,
        source: fromEnvironment === undefined ? 'windows-credential-manager' : 'environment',
        updatedAt: new Date().toISOString(),
      };
      writeJsonFile(this.file, this.state);
      return;
    }
    this.state = {
      version: 1,
      refreshToken: imported.refreshToken,
      email: this.state?.email ?? imported.email,
      source: fromEnvironment === undefined ? 'windows-credential-manager' : 'environment',
      updatedAt: new Date().toISOString(),
    };
    writeJsonFile(this.file, this.state);
  }

  async #oauthClients() {
    if (this.clients === undefined) {
      this.clients = await resolveOAuthClients({
        clientId: this.oauthClientId,
        clientSecret: this.oauthClientSecret,
        logger: this.logger,
      });
    }
    return this.clients;
  }

  async #refresh(signal) {
    const refreshToken = this.state?.refreshToken;
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      throw new AuthError('no Antigravity refresh token is stored; open Antigravity and sign in once', 'MISSING_CREDENTIAL');
    }
    const clients = await this.#oauthClients();
    if (clients.length === 0) {
      throw new AuthError(
        'no Antigravity OAuth client is available to refresh the sign-in. Install the Antigravity app, or set '
        + 'DSH_ANTIGRAVITY_CLIENT_ID and DSH_ANTIGRAVITY_CLIENT_SECRET (or the oauthClientId/oauthClientSecret config fields)',
        'MISSING_CREDENTIAL',
      );
    }
    let rejected;
    for (const client of clients) {
      const result = await this.#requestRefresh(client, refreshToken, signal);
      if (result.token !== undefined) {
        saveOAuthClient(client);
        this.#storeToken(result, refreshToken);
        return result.token;
      }
      rejected = result.error;
      // invalid_client/unauthorized_client mean the wrong public client was
      // guessed; another candidate may work. Every other failure is final.
      if (result.retryAnotherClient !== true) throw result.error;
    }
    throw rejected ?? new AuthError('Google rejected every known Antigravity OAuth client', 'INVALID_CREDENTIAL');
  }

  #storeToken(result, previousRefreshToken) {
    this.state = {
      ...this.state,
      version: 1,
      accessToken: result.token,
      expiresAt: Date.now() + result.expiresInSeconds * 1000,
      refreshToken: result.refreshToken ?? previousRefreshToken,
      updatedAt: new Date().toISOString(),
    };
    writeJsonFile(this.file, this.state);
  }

  async #requestRefresh(client, refreshToken, signal) {
    const body = new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString();
    let response;
    try {
      response = await this.transport.requestText({
        url: TOKEN_URL,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal,
        timeoutMs: 60_000,
        idleTimeoutMs: 30_000,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AuthError(`cannot reach Google's token endpoint (${cause.message})`, 'TRANSPORT', { cause });
    }
    if (response.status === 200) {
      let parsed;
      try {
        parsed = JSON.parse(response.text);
      } catch (cause) {
        throw new AuthError('Google token refresh returned malformed JSON', 'INVALID_CREDENTIAL', { cause });
      }
      const accessToken = parsed?.access_token;
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new AuthError('Google token refresh returned no access token', 'INVALID_CREDENTIAL');
      }
      const expiresInSeconds = Number(parsed.expires_in ?? 3599);
      return {
        token: accessToken,
        expiresInSeconds: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3599,
        ...(typeof parsed.refresh_token === 'string' && parsed.refresh_token !== '' ? { refreshToken: parsed.refresh_token } : {}),
      };
    }

    let reason = response.text.slice(0, 400);
    let errorCode;
    try {
      const parsed = JSON.parse(response.text);
      reason = parsed?.error_description ?? parsed?.error ?? reason;
      errorCode = typeof parsed?.error === 'string' ? parsed.error : undefined;
    } catch {
      // Keep the raw body excerpt.
    }
    const cause = new HttpError(reason, response.status, { body: response.text });
    if (errorCode === 'invalid_grant') {
      throw new AuthError(
        'the stored Antigravity sign-in was revoked by Google; open Antigravity and sign in again to refresh it',
        'INVALID_CREDENTIAL',
        { cause },
      );
    }
    if (errorCode === 'invalid_client' || errorCode === 'unauthorized_client') {
      return {
        retryAnotherClient: true,
        error: new AuthError(`Google rejected the Antigravity OAuth client (${errorCode}): ${reason}`, 'INVALID_CREDENTIAL', { cause }),
      };
    }
    throw new AuthError(`Google token refresh failed with HTTP ${response.status}: ${reason}`, 'INVALID_CREDENTIAL', { cause });
  }
}
