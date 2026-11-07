import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import axios from 'axios';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getAllTraces, telemetrySpanExporter } from '../src/tracing/agentTraceStore';

test('offline controls fail and translation errors retain sanitized diagnostic evidence', async t => {
  process.env.AI_MODEL_HOME_ASSISTANT = 'synthetic-translator';
  process.env.HOME_ASSISTANT_DEVICES = 'lb1';
  process.env.AZURE_OPENAI_API_KEY = 'synthetic-secret-key';
  const sdk = new NodeSDK({ autoDetectResources: false, spanProcessors: [new SimpleSpanProcessor(telemetrySpanExporter)] });
  sdk.start();
  const requireModule = createRequire(__filename);
  let plan = { url_path: 'switch/turn_on', entity_id: 'switch.lb1' };
  let modelError: Error | undefined;
  let invalidJson = false, restored = false, state = 'unavailable';
  const previous = new Map<string, NodeModule | undefined>();
  const stubs = {
    '../src/ai': { generateCompletion: async () => {
      if (modelError) throw modelError;
      return invalidJson ? 'invalid json' : JSON.stringify(plan);
    } },
    '../src/memory': { retrieveMemories: async () => [], formatMemoryContext: () => '' },
  };
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = requireModule.resolve(name); previous.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  }
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(axios, 'get', async (url: string) => {
    const entity = { entity_id: 'switch.lb1', state, attributes: { friendly_name: 'LB1', restored } };
    return { status: 200, data: url.endsWith('/api/states') ? [entity] : entity };
  });
  const post = t.mock.method(axios, 'post', async () => ({ status: 200, data: [] }));
  try {
    const { executeHACommand } = requireModule('../src/ha') as typeof import('../src/ha');
    const offline = await executeHACommand('Turn on LB1');
    assert.equal(offline.success, false);
    assert.match(offline.message, /LB1 is unavailable/);
    assert.equal(post.mock.callCount(), 0);
    state = 'on'; restored = true;
    assert.equal((await executeHACommand('Turn on LB1')).success, false);
    assert.equal(post.mock.callCount(), 0);
    restored = false;
    assert.equal((await executeHACommand('Turn on LB1')).success, true);
    assert.equal(post.mock.callCount(), 1, 'empty HA responses remain valid for online controls');
    plan = { url_path: 'states/switch.lb1', entity_id: 'switch.lb1' };
    state = 'unavailable';
    const query = await executeHACommand('What is LB1 state?');
    assert.equal(query.success, true);
    assert.match(query.message, /unavailable/);
    invalidJson = true;
    assert.match((await executeHACommand('Read LB1')).message, /response_parse/);
    invalidJson = false;
    modelError = Object.assign(new Error('Unknown deployment; key synthetic-secret-key; rtsp://user:password@camera.invalid'), { statusCode: 404 });
    const provider = await executeHACommand('Read LB1');
    assert.equal(provider.success, false);
    assert.match(provider.message, /model_request, HTTP 404/);
    const failures = getAllTraces().flatMap(trace => trace.events).filter(event => event.type === 'ha.translation.failed');
    assert.deepEqual(failures.map(event => event.data?.stage).sort(), ['model_request', 'response_parse']);
    assert.equal(failures.find(event => event.data?.stage === 'model_request')?.data?.statusCode, 404);
    assert.doesNotMatch(JSON.stringify(failures), /synthetic-secret-key|user:password/);
    assert.equal(post.mock.callCount(), 1);
  } finally {
    for (const [filename, value] of previous) {
      if (value) requireModule.cache[filename] = value; else delete requireModule.cache[filename];
    }
    await sdk.shutdown();
  }
});
