/**
 * Detect the installed Antigravity desktop version on Windows.
 *
 * The backend rejects clients below a minimum version with a synthetic
 * "no longer supported" response and sometimes changes request handling between
 * versions, so the request User-Agent should carry the version of the locally
 * installed application. When detection is unavailable, a conservative default
 * is used and can be overridden with the `clientVersion` config field.
 *
 * @module dsh-antigravity/client-version
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_CLIENT_VERSION = '2.32.0';
const CACHE_TTL_MS = 10 * 60_000;
const DETECT_TIMEOUT_MS = 5_000;

let cache;

function candidateExecutables() {
  if (process.platform !== 'win32') return [];
  const roots = [
    process.env.LOCALAPPDATA === undefined ? undefined : path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter((root) => typeof root === 'string' && root !== '');
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'antigravity', 'Antigravity.exe'));
    candidates.push(path.join(root, 'Antigravity', 'Antigravity.exe'));
  }
  return candidates;
}

function powershellVersionOf(executable) {
  const literal = executable.replace(/'/g, "''");
  const script = `$p='${literal}'; if (Test-Path -LiteralPath $p) { (Get-Item -LiteralPath $p).VersionInfo.ProductVersion }`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: DETECT_TIMEOUT_MS, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const match = /(\d+\.\d+\.\d+)/.exec(String(stdout ?? ''));
        resolve(match === null ? undefined : match[1]);
      },
    );
  });
}

async function detectWindowsVersion() {
  for (const candidate of candidateExecutables()) {
    if (!fs.existsSync(candidate)) continue;
    const version = await powershellVersionOf(candidate);
    if (version !== undefined) return version;
  }
  return undefined;
}

/**
 * Resolve the Antigravity version used in the request User-Agent.
 * @param {string | undefined} configured explicit `clientVersion` config value; empty means detect
 * @param {{info?: Function} | undefined} logger optional diagnostic sink
 * @returns {Promise<string>}
 */
export async function resolveClientVersion(configured, logger) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  if (cache !== undefined && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  let detected;
  try {
    detected = await detectWindowsVersion();
  } catch {
    detected = undefined;
  }
  const value = detected ?? DEFAULT_CLIENT_VERSION;
  cache = { at: Date.now(), value };
  if (detected !== undefined) logger?.info?.(`[antigravity] detected the installed Antigravity version ${detected}`);
  return value;
}

export { DEFAULT_CLIENT_VERSION };
