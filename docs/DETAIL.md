# Google Antigravity models

Adds an `antigravity` model provider to DeepSeek Harness. Models are served by the same Google
Cloud Code Assist backend the Antigravity desktop application uses, so they draw on the subscription
and sign-in already present on the machine.

## What it does

- Advertises the account's real catalog (`fetchAvailableModels`): Gemini 3.x/2.5, Claude Sonnet/Opus,
  and GPT-OSS where the plan includes them. Models appear as the **Google Antigravity** group in the
  composer's model selector.
- Streams text and reasoning, maps harness tool definitions onto Gemini `functionDeclarations`,
  returns tool calls to the agent loop, and preserves thinking signatures for multi-turn tool use.
- **Quota chip**: a compact pill in the composer tool row shows the used percentage of the
  Antigravity 5-hour and weekly windows for the group that owns the selected model (Gemini vs
  Claude/GPT). Hovering lists every group with used percentage and reset time; clicking forces a
  refresh. It polls the host endpoint `/antigravity/quota` once a minute, which reads
  `v1internal:retrieveUserQuotaSummary` through the same credential and proxy as model requests and
  caches the result for 60 seconds. The endpoint authorizes the page through the connection's signed
  browser credential (or a per-process token injected into the authenticated index HTML).
- Works around a backend quirk: a `systemInstruction` containing certain first-person claims naming
  the harness product is answered with `429 RESOURCE_EXHAUSTED` instead of being executed. The
  adapter detects those paragraphs and delivers only them through the opening user turn (verbatim),
  keeping the rest of the prompt in `systemInstruction`; if an unknown prompt shape is still
  rejected, it retries once with the whole prompt as user content.

## Requirements

- Windows for automatic sign-in import (Credential Manager entry `gemini:antigravity`), or a refresh
  token supplied through `DSH_ANTIGRAVITY_REFRESH_TOKEN` / the `tokenFile` config on any platform.
- The Antigravity app installed and signed in (or the token above). The public OAuth client needed to
  refresh the token is extracted from the installed Antigravity binary at runtime; if that is not
  possible, set `DSH_ANTIGRAVITY_CLIENT_ID` / `DSH_ANTIGRAVITY_CLIENT_SECRET` or the matching config
  fields.
- A proxy or VPN in regions where Google geo-blocks the backend.

## Sign-in

1. On the first request the plugin reads `$DSH_HOME/antigravity/auth.json`; if absent it reads
   `DSH_ANTIGRAVITY_REFRESH_TOKEN`, then, on Windows, the Antigravity Credential Manager entry.
2. It stores the refresh token in `$DSH_HOME/antigravity/auth.json` and refreshes access tokens
   itself with Antigravity's public desktop OAuth client. The client pair is resolved from the
   environment, the config, a local cache, or the installed Antigravity binary; it is never stored in
   this repository.

If the grant was revoked, open Antigravity, sign in, and delete `$DSH_HOME/antigravity/auth.json`.

## Configuration

The loader row `llm-antigravity` accepts:

| Field | Default | Meaning |
|---|---|---|
| `displayName` | `Google Antigravity` | Group title in the model picker and settings. |
| `proxy` | auto | `''`/`auto`: environment, then the Windows system proxy. `direct`: never proxy (TUN/VPN captures it). Any other value: pinned `http://host:port` CONNECT proxy. |
| `proxyRefreshMs` | `15000` | How often auto mode re-reads the system proxy so switching the VPN client between TUN and system-proxy mode needs no restart. |
| `clientVersion` | auto | Antigravity version in the request User-Agent; empty detects the installed app on Windows and falls back to a conservative default. |
| `endpoint` | daily Cloud Code host | Override the API host. |
| `project` | discovered | Force the Cloud Code Assist managed project id. |
| `tokenFile` | `$DSH_HOME/antigravity/auth.json` | Refresh-token file read/written by the plugin. |
| `catalogTtlMs` | `300000` | Model-catalog cache lifetime. |
| `requestTimeoutMs` | `900000` | Whole-request deadline. |
| `idleTimeoutMs` | `300000` | Maximum silence between streamed chunks. |
| `retryMaxRetries` | `7` | Harness retries on throttling or transient failures. |
| `retryMaxDelayMs` | `30000` | Longest backoff between those retries. |
| `quotaTtlMs` | `60000` | How long the quota chip reuses one read. |
| `oauthClientId` / `oauthClientSecret` | auto | Public Antigravity OAuth client used for token refresh; extracted from the installed app when omitted. |
| `extraModels` | `[]` | Extra backend model ids to advertise beyond discovery. |

### Proxy behaviour in auto mode

Every request of the provider — OAuth token refresh, `loadCodeAssist`, model discovery, inference,
quota — goes through the same transport, so the route applies to all of them:

1. If the system proxy is enabled, requests are tunnelled through it (`CONNECT`); direct connections
   are not attempted while the proxy is up.
2. If the proxy is unreachable, requests fall back to a direct connection for 60 seconds (so a
   TUN-mode client still works) and then retry the proxy.
3. If a direct request is rejected with `User location is not supported`, the provider retries
   through the system proxy once and keeps that route for five minutes.

Diagnostics are appended to `$DSH_HOME/antigravity/plugin.log`. To prove that no request bypasses
the proxy, run `node test/proxy-audit.mjs`.

## Limitations

- This uses Google's internal Antigravity inference endpoint, which Google does not document or
  support for third-party clients. Treat it as an unofficial integration of your own subscription;
  Google can change or police it at any time.
- The backend geo-gates by client IP; a proxy/VPN is required in unsupported locations.
- Only text input is wired: images and files are projected to deterministic placeholders by the
  harness, exactly as for any text-only provider.
- No vision, no Google Search grounding, and no quota page beyond the chip.
- Model availability and per-model quotas are whatever the backend advertises; a listed model can
  still answer `429 RESOURCE_EXHAUSTED` when its own capacity is throttled.
- The system-prompt workaround moves a few paragraphs from the system channel to the first user
  message; the text is preserved verbatim, but those paragraphs are model-visible as user content.
- The quota chip reads the same unofficial endpoint as inference; percentages come from Google's
  `remainingFraction` per window and may lag the IDE by one refresh interval. Reload the page once
  after installing or updating the plugin so its Client module loads.
