import assert from 'node:assert/strict';
import test from 'node:test';
import { configureTestProviders } from './helpers/agentFixtures';

test('text and vision requests omit unsupported reasoning-model temperature settings', async t => {
  configureTestProviders();
  const { generateCompletion, generateVisionText } = await import('../src/ai');
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({
      id: 'synthetic-response', created_at: 1, model: 'synthetic',
      output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  for (const model of ['gpt-5.6-terra', 'gpt-6.1-sol', 'o3-mini', 'gpt-4o', 'gpt-5-chat-latest', 'custom-deployment']) {
    await generateCompletion({ model, messages: [{ role: 'user', content: 'synthetic test' }], temperature: 0 });
    assert.equal(requests.at(-1)!.temperature, ['gpt-4o', 'gpt-5-chat-latest', 'custom-deployment'].includes(model) ? 0 : undefined);
  }
  await generateVisionText({ model: 'gpt-5.6-terra', prompt: 'synthetic image', imageBase64: 'AA==', imageContentType: 'image/png', temperature: 0 });
  assert.equal(requests.at(-1)!.temperature, undefined);
});
