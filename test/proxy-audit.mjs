/**
 * Proxy audit: prove that every Antigravity request of one provider instance
 * leaves through the configured proxy.
 *
 * A local CONNECT proxy is started in front of the machine's real system proxy;
 * the provider is pointed at the local one. Every CONNECT target is recorded,
 * then the test performs a token refresh, project discovery, model discovery,
 * and one streamed inference turn. It fails unless all expected hosts were seen
 * through the proxy, and unless a dead proxy refuses instead of silently going
 * direct.
 *
 *   node test/proxy-audit.mjs [--direct-upstream]
 *
 * `--direct-upstream` skips the system proxy and lets the audit proxy dial the
 * targets itself (useful when TUN mode is on).
 */
import net from 'node:net';
import { Transport, resolveProxy } from '../lib/transport.js';
import { AuthStore } from '../lib/auth.js';
import { AntigravityApi } from '../lib/api.js';
import { createAdapter } from '../lib/provider.js';

class TestLlmError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.failure = { message, code };
    Object.assign(this, options);
  }
}

class TestLlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider };
  }
  providerRetryPolicy() {
    return undefined;
  }
}

const directUpstream = process.argv.includes('--direct-upstream');

/** Start a CONNECT proxy that forwards tunnels to `upstream` (null = direct). */
function startAuditProxy(upstream) {
  const seen = [];
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index === -1) {
        if (buffer.length > 64 * 1024) client.destroy();
        return;
      }
      client.removeListener('data', onData);
      const head = buffer.subarray(0, index).toString('latin1');
      const rest = buffer.subarray(index + 4);
      const line = head.split('\r\n')[0] ?? '';
      const match = /^CONNECT ([^:\s]+):(\d+)/.exec(line);
      if (match === null) {
        client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
        return;
      }
      const host = match[1];
      const port = Number(match[2]);
      seen.push(`${host}:${port}`);
      const open = upstream === null
        ? net.connect({ host, port })
        : net.connect({ host: upstream.host, port: upstream.port });
      let upstreamBuffer = Buffer.alloc(0);
      const onUpstreamData = (chunk) => {
        upstreamBuffer = Buffer.concat([upstreamBuffer, chunk]);
        const upIndex = upstreamBuffer.indexOf('\r\n\r\n');
        if (upIndex === -1) return;
        upstreamSocket.removeListener('data', onUpstreamData);
        const upHead = upstreamBuffer.subarray(0, upIndex).toString('latin1');
        const upRest = upstreamBuffer.subarray(upIndex + 4);
        if (!/^HTTP\/1\.[01] 200\b/.test(upHead)) {
          client.destroy();
          upstreamSocket.destroy();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (upRest.length > 0) client.write(upRest);
        if (rest.length > 0) upstreamSocket.write(rest);
        client.pipe(upstreamSocket);
        upstreamSocket.pipe(client);
      };
      const upstreamSocket = open;
      upstreamSocket.once('connect', () => {
        if (upstream === null) {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (rest.length > 0) upstreamSocket.write(rest);
          client.pipe(upstreamSocket);
          upstreamSocket.pipe(client);
          return;
        }
        upstreamSocket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      });
      upstreamSocket.on('data', onUpstreamData);
      upstreamSocket.once('error', () => client.destroy());
    };
    client.on('data', onData);
    client.once('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

async function main() {
  const systemProxy = directUpstream ? null : await resolveProxy('');
  if (!directUpstream && systemProxy === null) {
    throw new Error('no system proxy detected; pass --direct-upstream to audit against a TUN route');
  }
  const { server, seen, port } = await startAuditProxy(systemProxy);
  console.log(`audit proxy on 127.0.0.1:${port} -> ${systemProxy === null ? 'direct' : `system proxy ${systemProxy.label}`}`);

  const transport = new Transport({ proxy: `http://127.0.0.1:${port}` });
  const auth = new AuthStore({ transport });
  const logger = { warn: (...args) => console.warn('WARN', ...args), info: () => {} };
  const api = new AntigravityApi({ transport, auth, logger });
  const options = {
    displayName: 'Google Antigravity',
    endpoint: '',
    proxy: `http://127.0.0.1:${port}`,
    clientVersion: '2.32.0',
    project: '',
    tokenFile: '',
    catalogTtlMs: 300_000,
    requestTimeoutMs: 900_000,
    idleTimeoutMs: 300_000,
    extraModels: [],
  };
  const runtime = async () => ({ transport, auth, api });
  const adapter = createAdapter({ provider: 'antigravity', options, runtime, LlmAdapter: TestLlmAdapter, LlmError: TestLlmError, attribution: () => ({}), logger });

  // 1. OAuth refresh through the proxy (forces the token endpoint request).
  await auth.refreshNow();
  console.log('token refresh: ok');
  // 2. Project discovery through the proxy.
  console.log('project:', await api.projectId());
  // 3. Model discovery through the proxy.
  const models = await adapter.listModels('antigravity');
  console.log('models:', models.length);
  // 4. One streamed inference turn through the proxy.
  const info = await adapter.resolveModel('antigravity', 'gemini-3-flash');
  let text = '';
  for await (const chunk of adapter.stream({
    provider: 'antigravity',
    model: info.id,
    reasoningEffort: 'low',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PROXY OK' }] }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  console.log('stream text:', JSON.stringify(text));
  transport.close();
  server.close();

  const hosts = [...new Set(seen)];
  console.log('\nCONNECT targets through the proxy:');
  for (const host of hosts) console.log('  ' + host);
  const required = ['oauth2.googleapis.com', 'daily-cloudcode-pa.googleapis.com'];
  const missing = required.filter((host) => !hosts.some((target) => target.startsWith(host + ':')));
  if (missing.length > 0) throw new Error(`requests bypassed the proxy; missing hosts: ${missing.join(', ')}`);
  if (!text.includes('PROXY OK')) throw new Error(`unexpected stream text: ${text}`);

  // 5. A dead proxy must fail loudly instead of silently connecting directly.
  const dead = new Transport({ proxy: 'http://127.0.0.1:9' });
  let failed = false;
  try {
    await dead.requestText({ url: 'https://oauth2.googleapis.com/token', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1', timeoutMs: 20_000, idleTimeoutMs: 20_000 });
  } catch (error) {
    failed = true;
    console.log(`\ndead proxy correctly failed: ${error.name}: ${error.message.slice(0, 160)}`);
  } finally {
    dead.close();
  }
  if (!failed) throw new Error('a dead proxy silently succeeded; requests may bypass the proxy');
  console.log('\nPROXY AUDIT OK');
}

main().catch((error) => {
  console.error('\nPROXY AUDIT FAILED:', error);
  if (error.cause) console.error('cause:', error.cause);
  process.exitCode = 1;
});
