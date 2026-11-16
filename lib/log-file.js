/**
 * Minimal append-only diagnostic log for the Antigravity provider.
 *
 * DSH's product profiles mount no console exporter for `ctx.logger`, so proxy
 * route changes and sign-in problems would otherwise be invisible. The file
 * lives beside the cached sign-in under `$DSH_HOME/antigravity/` and rotates at
 * ~512 KiB so it cannot grow without bound.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 512 * 1024;

function defaultLogFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'antigravity', 'plugin.log');
}

/** Create a best-effort file logger; every failure is swallowed. */
export function createFileLogger(file = defaultLogFile()) {
  let disabled = false;
  const write = (level, message) => {
    if (disabled) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        // Missing file or an unlucky race: append will create it.
      }
      const text = typeof message === 'string' ? message : String(message);
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${level} ${text}\n`, 'utf8');
    } catch {
      disabled = true;
    }
  };
  return {
    file,
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  };
}
