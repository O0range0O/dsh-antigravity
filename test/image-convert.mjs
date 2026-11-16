/** Offline checks for image conversion, reasoning efforts, and signature fallback. */
import assert from 'node:assert/strict';
import { buildRequest, thinkingConfig } from '../lib/convert.js';

const tool = { name: 'run_command', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };

// Retained image becomes an inlineData part; the tool-result image lands in the
// same user turn as its functionResponse.
const withImage = buildRequest({
  provider: 'antigravity',
  model: 'gemini-3-flash',
  project: 'project',
  tools: [tool],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in the image?' },
        { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 480, height: 140 } },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'run_command', arguments: '{"command":"pwd"}' }] },
    {
      role: 'tool',
      toolCallId: 'call-1',
      source: { kind: 'tool', callId: 'call-1' },
      content: [
        { type: 'text', text: '/tmp' },
        { type: 'image', attachment: { attachmentId: 'img-2', mediaType: 'image/jpeg', width: 20, height: 10 } },
      ],
    },
  ],
  images: new Map([
    ['img-1', { mediaType: 'image/png', data: Buffer.from([1, 2, 3]) }],
    ['img-2', { mediaType: 'image/jpeg', data: Buffer.from([4, 5]) }],
  ]),
  projectedImageText: new Map([['img-3', '[image 1x1 image/png — attachment img-3]']]),
  signatureFallback: true,
});
const [first, second, third] = withImage.request.contents;
assert.equal(first.role, 'user');
assert.deepEqual(first.parts[1], { inlineData: { mimeType: 'image/png', data: 'AQID' } });
assert.equal(second.parts[0].functionCall.name, 'run_command');
assert.equal(second.parts[0].thoughtSignature, 'skip_thought_signature_validator');
assert.equal(third.role, 'user');
assert.equal(third.parts[0].functionResponse.name, 'run_command');
assert.equal(third.parts[1].inlineData.mimeType, 'image/jpeg');
assert.equal(third.parts[1].inlineData.data, 'BAU=');

// A projected (over-budget) image keeps a deterministic text stand-in.
const projected = buildRequest({
  provider: 'antigravity',
  model: 'gemini-3-flash',
  project: 'project',
  messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-3', mediaType: 'image/png', width: 1, height: 1 } }] }],
  projectedImageText: new Map([['img-3', '[image 1x1 image/png — attachment img-3]']]),
});
assert.deepEqual(projected.request.contents[0].parts, [{ text: '[image 1x1 image/png — attachment img-3]' }]);

// Real signatures win over the fallback sentinel.
const signed = buildRequest({
  provider: 'antigravity',
  model: 'gemini-3-flash',
  project: 'project',
  messages: [{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-1', name: 'run_command', arguments: '{}' }],
    source: { kind: 'model', provider: 'antigravity', model: 'gemini-3-flash', replayState: { response: { signature: 'real-sig' }, blocks: [{ signature: 'real-sig' }] } },
  }],
  signatureFallback: true,
});
assert.equal(signed.request.contents[0].parts[0].thoughtSignature, 'real-sig');

// DeepSeek-style effort vocabulary mapped per model family.
assert.deepEqual(thinkingConfig('gemini-3-flash', 'off'), { thinkingLevel: 'minimal' });
assert.deepEqual(thinkingConfig('gemini-3-flash', 'low'), { thinkingLevel: 'low' });
assert.deepEqual(thinkingConfig('gemini-3-flash', 'max'), { thinkingLevel: 'high' });
assert.deepEqual(thinkingConfig('gemini-3-flash', 'medium'), { thinkingLevel: 'high' });
assert.deepEqual(thinkingConfig('gemini-2.5-pro', 'off'), { thinkingBudget: 0 });
assert.deepEqual(thinkingConfig('gemini-2.5-pro', 'max'), { thinkingBudget: 32768 });
assert.equal(thinkingConfig('claude-sonnet-4-6', 'off'), undefined);
assert.deepEqual(thinkingConfig('claude-sonnet-4-6', 'low'), { thinkingBudget: 4096 });
assert.equal(thinkingConfig('gpt-oss-120b-medium', 'max'), undefined);

console.log('IMAGE CONVERT OK');
