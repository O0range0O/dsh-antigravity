# Changelog

## 1.1.0 — 2026-11-16

Parity release: the Antigravity route now behaves like a first-class provider inside the harness.

- Image input: user attachments and tool-result images are read through the harness attachment
  service and sent inline to vision-capable models (Gemini, Claude). Images over the inline budget
  (24 images, 2 MB each after resize, long edge 1568 px) keep a deterministic placeholder.
- DeepSeek-style reasoning efforts `off`/`low`/`high`/`max` replace `low`/`medium`/`high`;
  `medium` selections from existing sessions are treated as `high`.
- Tool history from another provider replays with the documented
  `skip_thought_signature_validator` sentinel on Gemini 3+, so switching models mid-session no
  longer fails with "missing thought_signature".
- Model metadata advertises the `image` input modality only for models the backend marks as
  image-capable; text-only routes keep the harness placeholder projection.
- New offline regression test `test/image-convert.mjs`.

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
