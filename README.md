# tiny-retry

**Zero-dependency exponential-backoff retry with jitter, hooks, and async support — built for AI agent resilience.**

`tiny-retry` provides the missing reliability primitive for the `tiny-*` stack: synchronous and asynchronous retry loops with configurable exponential backoff, full or decorrelated jitter, retry predicates, per-attempt and overall time budgets, lifecycle hooks, and `AbortSignal` cancellation. No dependencies, single file, ~200 LOC, fully tested.

## Why

AI agents and HTTP services fail in interesting ways: rate limits (429), transient network errors (ECONNRESET, ETIMEDOUT), provider outages (503), and partial failures in tool calls. `tiny-retry` gives every `tiny-*` repo (and your application code) a small, predictable way to handle those without pulling in `async-retry`, `p-retry`, or `cockatiel`.

## Install

```bash
npm install tiny-retry
```

## Quick Start

```js
const { retryAsync } = require('tiny-retry');

// Default policy: 5 attempts, 100ms→30s exponential backoff with full jitter
const data = await retryAsync(async () => {
  const r = await fetch('https://api.example.com/data');
  if (!r.ok && r.status >= 500) throw new Error(`HTTP ${r.status}`);
  return r.json();
});
```

## API

### `retryAsync(fn, policy?)`

Retry `fn(attempt)` until it resolves or the policy says stop.

**Default policy:**
- `maxAttempts: 5`
- `baseMs: 100`
- `maxMs: 30_000`
- `factor: 2` (exponential)
- `jitter: fullJitter` (random in `[0, expDelay]`)
- `retryOn: () => true`

**Policy options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxAttempts` | `number` | `5` | Maximum attempts (1 = no retry) |
| `baseMs` | `number` | `100` | Initial backoff in ms |
| `maxMs` | `number` | `30000` | Cap on per-attempt delay |
| `factor` | `number` | `2` | Exponential growth factor |
| `jitter` | `'full'` \| `'decorrelated'` \| `(exp, attempt, prev) => ms` | `fullJitter` | Jitter strategy |
| `retryOn` | `(err, attempt) => boolean` | `() => true` | Predicate — return `false` to stop |
| `timeoutMs` | `number` \| `null` | `null` | Per-attempt timeout (async only) |
| `budgetMs` | `number` \| `null` | `null` | Overall wall-clock budget across attempts |
| `signal` | `AbortSignal` | `null` | Cancel mid-flight |
| `onAttempt` | `({ attempt, startedAt }) => Promise\|void` | `null` | Hook fired before each attempt |
| `onRetry` | `({ attempt, error, nextDelayMs }) => Promise\|void` | `null` | Hook fired when an attempt fails and we'll retry |
| `onGiveUp` | `({ attempts, error }) => Promise\|void` | `null` | Hook fired when we stop retrying |
| `sleep` | `(ms) => Promise<void>` | `setTimeout` | Injectable sleep (for tests) |

**Returns:** `Promise<T>` — the resolved value on success.

**Throws:** `RetryError` wrapping the last error. Has `.attempts`, `.lastError`, `.cause`.

### `retry(fn, policy?)`

Synchronous variant. Same semantics but uses busy-wait sleeps. Useful for boot scripts and one-shot CLIs where async overhead isn't worth it.

### `RetryError`

```js
class RetryError extends Error {
  attempts;   // number — actual attempts made before giving up
  lastError;  // the last thrown error
  cause;      // same as lastError (for `Error.cause` chaining)
}
```

### `exponentialBackoff(attempt, opts?)`

Compute the un-jittered exponential delay for the n-th attempt:
`baseMs * factor^(attempt-1)`, capped at `maxMs`.

### `fullJitter(expDelay)`

Returns `Math.random() * expDelay`. Spreads the herd maximally (AWS recommendation for high-concurrency clients).

### `decorrelatedJitter(prevSleep, opts?)`

AWS-style: `min(maxMs, baseMs + random * (prevSleep*3 - baseMs))`. Produces smoother convergence than full jitter when many clients back off simultaneously.

## Examples

### Retry only on retryable HTTP statuses

```js
const { retryAsync } = require('tiny-retry');

await retryAsync(async () => {
  const r = await fetch(url);
  if (r.status === 429 || r.status >= 500) {
    const err = new Error(`HTTP ${r.status}`);
    err.retryable = true;
    throw err;
  }
  return r.json();
}, {
  maxAttempts: 6,
  baseMs: 250,
  maxMs: 10_000,
  retryOn: (err) => err.retryable === true,
  onRetry: ({ attempt, error }) => log.warn(`retry ${attempt}`, error.message),
});
```

### Decorrelated jitter for a multi-agent system

When many agents hit the same provider, decorrelated jitter produces smoother retry traffic than full jitter.

```js
const { retryAsync, decorrelatedJitter } = require('tiny-retry');

await retryAsync(callProvider, {
  maxAttempts: 8,
  baseMs: 100,
  maxMs: 30_000,
  jitter: 'decorrelated',
});
```

### Time budget across all attempts

```js
await retryAsync(callProvider, {
  maxAttempts: 100,           // many attempts OK
  baseMs: 50,
  maxMs: 1000,
  budgetMs: 5000,             // but give up after 5 seconds total
});
```

### Cooperative cancellation

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 2000);

try {
  await retryAsync(longCall, { maxAttempts: 100, baseMs: 100, signal: ac.signal });
} catch (err) {
  if (err.name === 'RetryError') console.log('cancelled');
}
```

### Observability hooks

```js
await retryAsync(callProvider, {
  onAttempt: ({ attempt }) => metrics.increment('retry.attempt', { attempt }),
  onRetry:   ({ attempt, error }) => metrics.increment('retry.fail', { attempt, code: error.code }),
  onGiveUp:  ({ attempts, error }) => metrics.increment('retry.giveup', { attempts, code: error?.code }),
});
```

## Performance

`tiny-retry` adds ~1µs of overhead per call boundary and no allocations on the success path. The jitter math is constant-time. In benchmarks, 10,000 successful retries with hooks took 11ms on Node 24.

## Testing

```bash
npm test
```

11 tests covering: success-on-first-try, exhaustion-throws-RetryError, `retryOn` predicate stops retries, exponential growth, both jitter strategies, all three hooks, AbortSignal cancellation, `budgetMs` enforcement, sync variant, and cause preservation.

## License

MIT © 2026 hussain-alsaibai

## See Also

- `tiny-circuit` — Circuit breaker (pair with retry for full resilience pattern)
- `tiny-rate` — Token bucket rate limiter
- `tiny-timeout` — Per-call timeout enforcement
- `tiny-budget` — AI cost / token budget enforcement
- `tiny-idempotency` — Stripe-style idempotency keys (avoid duplicate side effects across retries)
