# dsh-antigravity

A **DeepSeek Harness** bundle that adds a
**Google Antigravity** model provider: the Gemini, Claude, and GPT-OSS models served to the
Antigravity desktop application by your Antigravity subscription.

The plugin reuses the sign-in that the Antigravity app already stores on this machine and talks to
the same Cloud Code Assist backend the IDE uses. It also adds a **quota chip** to the composer that
shows how much of the 5-hour and weekly limits you have used.

Maintained by [O0range0O](https://github.com/O0range0O).

> **Unofficial integration.** It targets an internal Google endpoint that is not documented or
> supported for third-party clients. Use it only with your own subscription, and expect Google to
> change or restrict it at any time. See [Disclaimer](#disclaimer).

## Features

- **Models**: the account's actual catalog via `fetchAvailableModels` — Gemini 3.x/2.5, Claude
  Sonnet/Opus, GPT-OSS where the plan includes them. They appear in the normal model picker under
  **Google Antigravity**.
- **Vision**: images attached to a message and images returned by tools are sent inline to models the
  backend marks as image-capable (Gemini and Claude families); over-budget images keep a
  deterministic text placeholder instead of failing the request.
- **Efforts like the DeepSeek route**: `off`, `low`, `high`, and `max`, mapped onto Gemini thinking
  levels or thinking budgets (and disabled thinking where the provider allows it).
- **Model switching**: tool history produced by another provider carries no Gemini thought
  signatures; for Gemini 3+ those function calls are replayed with the documented
  `skip_thought_signature_validator` sentinel so the switch does not fail.
- **Streaming**: text and reasoning deltas, usage reporting, tool calls mapped from harness
  `ToolSchema` to Gemini `functionDeclarations`, and thinking-signature replay for multi-turn tool use.
- **Quota chip**: used percentage of the 5-hour and weekly windows for the selected model's group,
  hover breakdown for every group with reset times, click to refresh, automatic refresh once a minute.
- **Proxy aware**: every request — OAuth refresh, discovery, inference, quota — goes through one
  proxy route. Auto mode follows `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`, then the Windows system
  proxy, re-resolves while running, and falls back in both directions (unreachable proxy → direct;
  geo-blocked direct → system proxy). The Antigravity backend geo-gates by client IP, so a proxy or
  VPN is required in unsupported regions.
- **Long retries**: per-model `429 RESOURCE_EXHAUSTED` throttling is retried for about 90 seconds
  before an error that names alternative models.
- **Diagnostics**: a small log at `$DSH_HOME/antigravity/plugin.log` records the transport route,
  catalog size, sign-in state, quota reads, and request failures.

## Requirements

- DeepSeek Harness `>= 0.2.2-rc.3 < 1.0.0` (the plugin's peer range) with the bundled Web GUI.
- **Windows** for automatic sign-in import (the Antigravity app stores its OAuth grant in the
  Windows Credential Manager entry `gemini:antigravity`).
  On macOS/Linux, or when you prefer not to reuse the app's login, supply a refresh token yourself
  through `DSH_ANTIGRAVITY_REFRESH_TOKEN` or the `tokenFile` config (see [Sign-in](#sign-in)).
- The Antigravity desktop app installed and signed in **or** a refresh token in the environment.
  The public OAuth client needed to refresh that token is read from the installed Antigravity
  binary at runtime; if it is not found, set `DSH_ANTIGRAVITY_CLIENT_ID` and
  `DSH_ANTIGRAVITY_CLIENT_SECRET` (or the matching config fields).
- A working proxy/VPN when Google geo-blocks your location.

## Install

Download `dsh-antigravity-1.0.0.zip` from the
[latest release](https://github.com/O0range0O/dsh-antigravity/releases) and unpack it, or clone this
repository. The bundle is a plain directory; install it with DeepSeek Harness' own plugin manager.

From the GUI:

1. **Plugins → Add plugin**
2. Choose the cloned directory (the one containing `package.json`)
3. Refresh the page once so the Client module (quota chip) loads.

From an agent session with the `plugin_manager` tool:

```
plugin_manager install_bundle target=<absolute path to this directory>
```

Do not copy files into `$DSH_HOME` by hand — the plugin manager links the directory into the current
profile and records the bundle selection.

## Use

1. Open the model selector in the composer and pick a model under **Google Antigravity**.
2. The quota chip beside the model controls shows `5h X% · wk Y%` (used). Hover for all groups and
   reset times; click to refresh.
3. Text-only models (`GPT-OSS`) show attached images as deterministic placeholders; Gemini and Claude
   models receive them inline and can describe or read them.
4. Selecting the model for a session is enough — nothing else needs configuring.

## Sign-in

The plugin never ships credentials. It resolves them at runtime, in this order:

1. `$DSH_HOME/antigravity/auth.json` (its own token cache, written after the first import).
2. `DSH_ANTIGRAVITY_REFRESH_TOKEN` (or `ANTIGRAVITY_REFRESH_TOKEN`): a bare refresh token or a JSON
   object such as `{"refreshToken":"1//...","email":"you@example.com"}`.
3. The Windows Credential Manager entry `gemini:antigravity`, written by the Antigravity app.

Access tokens are refreshed with Antigravity's public desktop OAuth client and cached in
`$DSH_HOME/antigravity/auth.json` (mode `0600` where the platform supports it). The public OAuth
client pair itself is resolved at runtime — environment variables, then config fields, then a local
cache, then extracted from the installed Antigravity binary — so this repository contains no client
credentials. To force a new import, delete `$DSH_HOME/antigravity/auth.json`; if Google revoked the
grant, open Antigravity and sign in again.

## Configuration

The bundle's patch inserts one loader row, `llm-antigravity`. Its `config` accepts:

| Field | Default | Meaning |
|---|---|---|
| `displayName` | `Google Antigravity` | Group title in the model picker and settings. |
| `proxy` | auto | `''`/`auto`: environment, then the Windows system proxy. `direct`: never proxy (TUN/VPN captures traffic). Any other value: pinned `http://host:port` CONNECT proxy. |
| `proxyRefreshMs` | `15000` | How often auto mode re-reads the system proxy. |
| `clientVersion` | auto | Antigravity version used in the request `User-Agent`; empty detects the installed app on Windows and falls back to a conservative default. Set explicitly if the backend starts rejecting the detected version. |
| `endpoint` | daily Cloud Code host | Override the API host. |
| `project` | discovered | Force the Cloud Code Assist managed project id. |
| `tokenFile` | `$DSH_HOME/antigravity/auth.json` | Where the refresh token is read from and cached. |
| `catalogTtlMs` | `300000` | Model-catalog cache lifetime. |
| `requestTimeoutMs` | `900000` | Whole-request deadline. |
| `idleTimeoutMs` | `300000` | Maximum silence between streamed chunks. |
| `retryMaxRetries` | `7` | Harness retries on throttling or transient failures. |
| `retryMaxDelayMs` | `30000` | Longest backoff between those retries. |
| `quotaTtlMs` | `60000` | How long the quota chip reuses one quota read. |
| `oauthClientId` / `oauthClientSecret` | auto | Public Antigravity OAuth client used for token refresh; detected from the installed app when omitted. |
| `extraModels` | `[]` | Extra backend model ids to advertise beyond discovery. |

Edit the row in the profile's `cordis.patch.yml` (or through the plugin's config surface); the patch
layer is preserved across upgrades.

## Troubleshooting

- **`429 RESOURCE_EXHAUSTED` with a long retry chain** — Google throttles per model. The plugin
  retries for about 90 seconds; if it still fails, wait a minute or switch to another model
  (for example Gemini 3.8 Flash (Medium) / Gemini 3 Flash / Claude Sonnet 4.6).
- **`User location is not supported`** — the backend geo-gates by client IP. Configure `proxy` or
  enable the same VPN the Antigravity IDE uses. Auto mode normally finds the system proxy already.
- **Prompt rejection (`429` right after a prompt that mentions the harness)** — some first-person
  system-prompt phrases are rejected by the backend with a misleading quota error. The adapter
  detects them and delivers those paragraphs through the opening user turn instead; unknown shapes
  are retried once as user content.
- **No quota chip** — refresh the page once after installing (the Client module loads with the
  page). The chip also needs the plugin to be enabled; hover over a grey chip to see the error.
- **Model request fails right after boot** — the VPN/proxy client may still be starting. Retry once;
  the transport re-resolves the route automatically.
- **Logs** — `$DSH_HOME/antigravity/plugin.log`.

## Tests

Live checks against the real backend (they use the local machine's Antigravity sign-in, no credentials
in the repo):

```
node test/e2e.mjs                     # catalog, text turn, tool round-trip
node test/e2e.mjs claude              # same on claude-sonnet-4-6
node test/real-tools.mjs              # tool-schema conversion + tool round-trip
node test/proxy-audit.mjs             # every request goes through the configured proxy
node test/quota-api.mjs               # quota summary normalization + live read
node test/image-convert.mjs           # offline: image parts, signature fallback, effort mapping
```

Set `AGY_PROXY=direct` to force a direct connection (TUN mode) or `AGY_PROXY=http://host:port` to pin
a proxy.

## Security and privacy

- The repository contains no credentials, tokens, email addresses, machine paths, or proxy ports.
  The public OAuth client pair is not stored here: it is read from the installed Antigravity
  application (or from environment/config) and cached locally under `$DSH_HOME/antigravity/`.
- The plugin reads this machine's Antigravity sign-in and keeps the refreshed token under
  `$DSH_HOME/antigravity/auth.json`; it never transmits it anywhere except Google's OAuth endpoint.
- The quota HTTP route is served on the local Web host and authorizes the page through the
  connection's signed browser credential (or a per-process token injected into the authenticated
  index HTML); other local requests are rejected.
- Requests go to `https://daily-cloudcode-pa.googleapis.com` (and Google's OAuth endpoint) with the
  Antigravity client identity, through your configured proxy.

## Disclaimer

This project is not affiliated with Google or DeepSeek. Antigravity's inference endpoint is a
private API: it may violate Google's terms of service, and accounts that automate it can be
restricted. It is provided for personal use with your own subscription, without warranty.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 O0range0O.
