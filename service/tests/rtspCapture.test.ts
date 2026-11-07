import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { startRtspCapture, stopRtspCapture } from '../src/agents/common/rtspCapture';

function child() {
  return Object.assign(new EventEmitter(), {
    stderr: new PassThrough(), stdout: new PassThrough(),
    killed: false, kill() { this.killed = true; return true; },
  });
}

test('RTSP encodes credentials, bounds waits and redacts credentials split across chunks', async t => {
  const previous = { ...process.env };
  process.env.RTSP_URL = 'rtsp://camera.invalid/stream';
  process.env.RTSP_USERNAME = 'camera user';
  process.env.RTSP_PASSWORD = 'p@ss:word/part';
  const proc = child();
  const errors: string[] = [];
  let failures = 0;
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.join(' ')));
  t.mock.method(fs, 'mkdir', async () => undefined);
  const spawn = t.mock.method(childProcess, 'spawn', () => proc);
  try {
    await startRtspCapture('redaction-test', { onFailure: () => { failures++; } });
    const args = spawn.mock.calls[0].arguments[1] as string[];
    const url = new URL(args[args.indexOf('-i') + 1]);
    assert.equal(decodeURIComponent(url.username), 'camera user');
    assert.equal(decodeURIComponent(url.password), 'p@ss:word/part');
    assert.equal(args[args.indexOf('-timeout') + 1], '15000000');
    proc.stderr.write('Error opening rtsp://camera%20user:p%40ss%3A');
    proc.stderr.write('word%2Fpart@camera.invalid/stream\n');
    proc.emit('close', 196, null);
    assert.equal(failures, 1);
    assert.ok(errors.some(line => line.includes('[REDACTED]@camera.invalid')));
    assert.ok(errors.every(line => !/p%40ss|word%2Fpart|camera%20user/.test(line)));
  } finally { stopRtspCapture('redaction-test'); process.env = previous; }
});

test('stopping during startup prevents a late spawn; old close preserves replacement', async t => {
  process.env.RTSP_URL = 'rtsp://camera.invalid/stream';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let mkdirCalls = 0;
  t.mock.method(fs, 'mkdir', async () => { if (++mkdirCalls === 1) await held; });
  const children: ReturnType<typeof child>[] = [];
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const proc = child(); children.push(proc); return proc;
  });
  try {
    const starting = startRtspCapture('replacement-test');
    stopRtspCapture('replacement-test');
    release();
    await starting;
    assert.equal(spawn.mock.callCount(), 0);
    await startRtspCapture('replacement-test');
    stopRtspCapture('replacement-test');
    await startRtspCapture('replacement-test');
    children[0].emit('close', 255, 'SIGTERM');
    await startRtspCapture('replacement-test');
    assert.equal(spawn.mock.callCount(), 2);
    stopRtspCapture('replacement-test');
    assert.equal(children[1].killed, true);
  } finally { release(); stopRtspCapture('replacement-test'); delete process.env.RTSP_URL; }
});

test('spawn failure frees the capture for retry and reports failure only once', async t => {
  process.env.RTSP_URL = 'rtsp://camera.invalid/stream';
  t.mock.method(fs, 'mkdir', async () => undefined);
  t.mock.method(console, 'error', () => undefined);
  const children: ReturnType<typeof child>[] = [];
  t.mock.method(childProcess, 'spawn', () => { const proc = child(); children.push(proc); return proc; });
  let failures = 0;
  try {
    await startRtspCapture('spawn-test', { onFailure: () => { failures++; } });
    children[0].emit('error', new Error('ENOENT'));
    children[0].emit('close', -2, null);
    await startRtspCapture('spawn-test');
    assert.equal(failures, 1);
    assert.equal(children.length, 2);
  } finally { stopRtspCapture('spawn-test'); delete process.env.RTSP_URL; }
});
