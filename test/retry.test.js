'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  retry,
  retryAsync,
  RetryError,
  exponentialBackoff,
  fullJitter,
  decorrelatedJitter,
} = require('../retry');

test('retry: succeeds on first try without delay', async () => {
  let calls = 0;
  const result = await retryAsync(async () => { calls++; return 42; });
  assert.equal(result, 42);
  assert.equal(calls, 1);
});

test('retry: retries up to maxAttempts then throws RetryError', async () => {
  let calls = 0;
  await assert.rejects(
    retryAsync(async () => { calls++; throw new Error('boom'); }, { maxAttempts: 3, baseMs: 1, maxMs: 5 }),
    (err) => err instanceof RetryError && err.attempts === 3 && /exhausted/.test(err.message)
  );
  assert.equal(calls, 3);
});

test('retry: retryOn predicate can stop retries', async () => {
  let calls = 0;
  await assert.rejects(
    retryAsync(
      async () => { calls++; const e = new Error('nope'); e.code = 'FATAL'; throw e; },
      { maxAttempts: 5, baseMs: 1, retryOn: (err) => err.code !== 'FATAL' }
    ),
    (err) => err.attempts === 1
  );
  assert.equal(calls, 1);
});

test('retry: exponentialBackoff grows', () => {
  assert.equal(exponentialBackoff(1, { baseMs: 100, maxMs: 10000 }), 100);
  assert.equal(exponentialBackoff(2, { baseMs: 100, maxMs: 10000 }), 200);
  assert.equal(exponentialBackoff(3, { baseMs: 100, maxMs: 10000 }), 400);
  assert.equal(exponentialBackoff(10, { baseMs: 100, maxMs: 10000 }), 10000); // capped
});

test('retry: fullJitter returns value in [0, exp]', () => {
  for (let i = 0; i < 50; i++) {
    const v = fullJitter(100);
    assert.ok(v >= 0 && v <= 100);
  }
});

test('retry: decorrelatedJitter stays within bounds', () => {
  for (let i = 0; i < 50; i++) {
    const v = decorrelatedJitter(500, { baseMs: 100, maxMs: 30000 });
    assert.ok(v >= 100 && v <= 30000);
  }
});

test('retry: hooks fire (onAttempt, onRetry, onGiveUp)', async () => {
  const events = [];
  await assert.rejects(
    retryAsync(
      async () => { throw new Error('x'); },
      {
        maxAttempts: 3,
        baseMs: 1,
        onAttempt: ({ attempt }) => events.push(['attempt', attempt]),
        onRetry: ({ attempt, error }) => events.push(['retry', attempt, error.message]),
        onGiveUp: ({ attempts }) => events.push(['giveup', attempts]),
      }
    )
  );
  assert.deepEqual(events, [
    ['attempt', 1],
    ['retry', 1, 'x'],
    ['attempt', 2],
    ['retry', 2, 'x'],
    ['attempt', 3],
    ['giveup', 3],
  ]);
});

test('retry: AbortSignal cancels mid-flight', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(
    retryAsync(
      async () => { await new Promise((r) => setTimeout(r, 50)); throw new Error('slow'); },
      { maxAttempts: 10, baseMs: 100, maxMs: 1000, signal: ac.signal }
    ),
    (err) => err.name === 'RetryError'
  );
});

test('retry: budgetMs enforced across attempts', async () => {
  let calls = 0;
  const start = Date.now();
  await assert.rejects(
    retryAsync(
      async () => { calls++; await new Promise((r) => setTimeout(r, 20)); throw new Error('x'); },
      { maxAttempts: 100, baseMs: 10, maxMs: 100, budgetMs: 50 }
    )
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `should respect budget, took ${elapsed}ms`);
  assert.ok(calls >= 1 && calls <= 10);
});

test('retry: sync retry succeeds after retries', () => {
  let calls = 0;
  const result = retry(
    () => {
      calls++;
      if (calls < 3) throw new Error('x');
      return 'ok';
    },
    { maxAttempts: 5, baseMs: 0, maxMs: 0 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('retry: RetryError preserves cause', async () => {
  const original = new Error('original');
  try {
    await retryAsync(async () => { throw original; }, { maxAttempts: 2, baseMs: 1 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.cause, original);
    assert.equal(err.lastError, original);
  }
});
