import { LlmAdapter, LlmError, attributionHeaders, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createPlugin } from './lib/plugin.js';

export const name = 'llm-antigravity';
export const inject = ['llm'];

export function apply(ctx, config = {}) {
  const dispose = createPlugin({ ctx, config, LlmAdapter, LlmError, attributionHeaders, resolveRetryPolicy });
  ctx.effect(function* () {
    yield () => dispose();
  }, 'llm-antigravity');
}
