# Changelog

## 1.0.0 — 2026-11-16

First public release.

- Add an `antigravity` LLM provider backed by the Google Antigravity subscription: Gemini 3.x/2.5,
  Claude Sonnet/Opus, and GPT-OSS models, with the account's real catalog discovered at runtime.
- Stream text and reasoning, map harness tool schemas onto Gemini `functionDeclarations`, return tool
  calls to the agent loop, and preserve thinking signatures for multi-turn tool use.
- Reuse the Antigravity app's sign-in (Windows Credential Manager) or a refresh token supplied through
  `DSH_ANTIGRAVITY_REFRESH_TOKEN` / `tokenFile`; the public OAuth client is detected at runtime, no
  credentials are stored in the repository.
- Route every request through one proxy route (auto system proxy, environment, or pinned), with
  re-resolution at runtime and fallbacks in both directions.
- Add a quota chip to the composer showing used percentages of the 5-hour and weekly windows for the
  selected model's group, with a hover breakdown and click-to-refresh.
- Work around backend quirks: misleading `429` rejections of certain system-prompt paragraphs, and
  per-model throttling (longer retry policy).
- Ship a bundle manifest, ru/en locale strings, icon, plugin detail document, and live backend tests.
