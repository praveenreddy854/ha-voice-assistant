import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';

const requireModule = createRequire(__filename);
test('gesture startup, inference and camera failure clean up without overlapping work', async t => {
  const captures: Array<{ onFailure?: (message: string) => void }> = [];
  let stops = 0, actions = 0;
  const files: string[] = [];
  const previousEnvironment = { ...process.env };
  process.env.GESTURE_PYTHON = 'synthetic-python';
  delete process.env.GESTURE_ENABLED;
  const stubs = {
    '../src/agents/common/rtspCapture': {
      isRtspMode: () => true,
      startRtspCapture: async (_id: string, options: typeof captures[number]) => { captures.push(options); },
      stopRtspCapture: () => { stops++; },
    },
    '../src/ha': { callHAServiceDirect: async () => { actions++; return { success: true }; } },
  };
  const previous = new Map<string, NodeModule | undefined>();
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = requireModule.resolve(name);
    previous.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  }
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; killed: boolean; kill(): boolean }> = [];
  t.mock.method(childProcess, 'spawn', () => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      killed: false, kill() { this.killed = true; return true; },
    });
    children.push(proc); return proc;
  });
  t.mock.method(console, 'error', () => undefined);
  const monitor = requireModule('../src/gestureMonitor') as typeof import('../src/gestureMonitor');
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'readdirSync', () => files);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    monitor.startGestureMonitor();
    assert.equal(captures.length, 0, 'camera must wait for Python dependency imports');
    children[0].emit('close', 1);
    assert.equal(children[0].killed, true);
    t.mock.timers.tick(40000);
    assert.equal(captures.length, 0);
    monitor.startGestureMonitor();
    children[1].stderr.write('[gesture_detector] rea');
    children[1].stderr.write('dy\n');
    await setImmediate();
    assert.equal(captures.length, 1);
    files.push('frame.jpg');
    let requests = 0;
    children[1].stdin.on('data', () => { requests++; });
    t.mock.timers.tick(1000);
    await setImmediate();
    t.mock.timers.tick(3000);
    await setImmediate();
    assert.equal(requests, 1, 'slow inference must not overlap');
    children[1].stdout.write('{"gesture":"open_hand","confidence":1}\n');
    await setImmediate();
    assert.equal(actions, 1);
    captures[0].onFailure?.('camera timed out');
    assert.equal(children[1].killed, true);
    monitor.startGestureMonitor();
    children[2].stderr.write('[gesture_detector] ready\n');
    await setImmediate();
    assert.equal(captures.length, 2);
    const before = stops;
    children[1].emit('close', 1);
    assert.equal(stops, before, 'old detector cannot stop a replacement');
    assert.equal(actions, 1);
    monitor.stopGestureMonitor();
    monitor.startGestureMonitor();
    t.mock.timers.tick(30001);
    assert.equal(children[3].killed, true, 'startup timeout must kill an unready detector');
    assert.equal(captures.length, 2, 'startup timeout must not start camera capture');
    monitor.startGestureMonitor();
    children[4].stderr.write('[gesture_detector] ready\n');
    await setImmediate();
    t.mock.timers.tick(1000);
    await setImmediate();
    t.mock.timers.tick(5001);
    await setImmediate();
    assert.equal(children[4].killed, true, 'inference timeout must stop the detector');
    children[4].stdout.write('{"gesture":"open_hand"}\n');
    await setImmediate();
    assert.equal(actions, 1, 'a late inference result must not trigger a device action');
  } finally {
    monitor.stopGestureMonitor();
    delete requireModule.cache[requireModule.resolve('../src/gestureMonitor')];
    for (const [filename, value] of previous) {
      if (value) requireModule.cache[filename] = value; else delete requireModule.cache[filename];
    }
    process.env = previousEnvironment;
  }
});
