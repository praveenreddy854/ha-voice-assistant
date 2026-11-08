import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const workflow = readFileSync(new URL('../workflows/ai-review-required.yml', import.meta.url), 'utf8');
const script = workflow.split('// BEGIN REVIEW POLICY (tested without network or credentials)')[1].split('// END REVIEW POLICY')[0];
const evaluate = vm.runInNewContext(`(${script.trim()})`);
const sha = 'a'.repeat(40);
test('actual PR60 trusted summary passes for its reviewed commit only', () => {
  const fixture = JSON.parse(readFileSync(new URL('./codex-pr60-fixture.json', import.meta.url), 'utf8'));
  assert.equal(evaluate(fixture, 'bee3840bbaa57fd4040690ebe245256d41c6e8cd').state, 'success');
  assert.equal(evaluate(fixture, sha).state, 'pending');
});
function comment(review: Record<string, unknown> = {}, patch: Record<string, unknown> = {}) {
  return {
    id: 1, updated_at: '2026-11-08T00:00:00Z',
    user: { id: 199175422, type: 'Bot', login: 'chatgpt-codex-connector[bot]' },
    performed_via_github_app: { id: 1144995, slug: 'chatgpt-codex-connector' },
    body: '<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ' + JSON.stringify({ code_review: { commit_sha: sha, status: 'completed', has_any_findings: false, has_unresolved_findings: false, ...review } }) + ' -->',
    ...patch,
  };
}
test('completed trusted review for latest commit passes', () => assert.equal(evaluate([comment()], sha).state, 'success'));
test('resolved findings pass', () => assert.equal(evaluate([comment({has_any_findings:true})], sha).state, 'success'));
test('no review or stale commit stays blocked', () => {
  assert.equal(evaluate([], sha).state, 'pending');
  assert.equal(evaluate([comment({commit_sha:'b'.repeat(40)})], sha).state, 'pending');
});
test('copied marker from a human or other app cannot pass', () => {
  assert.equal(evaluate([comment({}, {user:{id:123,type:'User',login:'maintainer'}})], sha).state, 'pending');
  assert.equal(evaluate([comment({}, {performed_via_github_app:{id:42,slug:'other'}})], sha).state, 'pending');
  assert.equal(evaluate([comment({}, {performed_via_github_app:null})], sha).state, 'pending');
});
test('unresolved, missing and inconsistent flags fail closed', () => {
  assert.equal(evaluate([comment({has_any_findings:true,has_unresolved_findings:true})], sha).state, 'failure');
  assert.equal(evaluate([comment({has_unresolved_findings:null})], sha).state, 'failure');
  assert.equal(evaluate([comment({has_unresolved_findings:true})], sha).state, 'failure');
});
test('malformed or duplicate metadata fails closed', () => {
  assert.equal(evaluate([comment({}, {body:'<!-- codex-pull-request-review-summary -->'})], sha).state, 'failure');
  const c = comment(); c.body += c.body;
  assert.equal(evaluate([c], sha).state, 'failure');
});
test('incomplete review stays blocked', () => assert.equal(evaluate([comment({status:'in_progress'})], sha).state, 'pending'));
test('newer bot state replaces previous completed review', () => {
  const newest = comment({status:'in_progress'}, {id:2,updated_at:'2026-11-08T01:00:00Z'});
  assert.equal(evaluate([comment(),newest], sha).state, 'pending');
});
test('quoted marker is not accepted as an actual summary', () => {
  const c = comment(); c.body = '> ' + c.body;
  assert.equal(evaluate([c], sha).state, 'pending');
});
