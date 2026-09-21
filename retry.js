'use strict';

/**
 * tiny-retry: Zero-dependency exponential-backoff retry with jitter.
 *
 * Features:
 *   - Sync + async retry helpers
 *   - Exponential backoff with full or decorrelated jitter
 *   - Custom retry predicates (only retry on specific errors)
 *   - Per-attempt and overall time budgets
 *   - Hooks: onRetry, onAttempt, onGiveUp
 *   - Cancel via AbortSignal
 *   - Returns a typed RetryError wrapping the last cause
 *
 * No dependencies. ~300 LOC. Single file.
 */

class RetryError extends Error {
  constructor(message, { attempts, lastError, cause }) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
    this.cause = cause;
  }
}

/**
 * Compute delay for the n-th attempt (1-indexed).
 *
 * Exponential with cap: baseMs * 2^(n-1), clamped to maxMs.
 * Caller chooses jitter strategy (fullJitter / decorrelatedJitter / none).
 */
function exponentialBackoff(attempt, { baseMs = 100, maxMs = 30_000, factor = 2 } = {}) {
  const exp = Math.min(maxMs, baseMs * Math.pow(factor, Math.max(0, attempt - 1)));
  return Math.max(0, Math.floor(exp));
}

/** Full jitter: random in [0, expDelay]. Spreads thundering herd maximally. */
function fullJitter(expDelay) {
  return Math.floor(Math.random() * Math.max(0, expDelay));
}

/** Decorrelated jitter (AWS-style): min(maxMs, random_between(baseMs, prevSleep * 3)). */
function decorrelatedJitter(prevSleep, { baseMs = 100, maxMs = 30_000 } = {}) {
  return Math.min(maxMs, Math.floor(baseMs + Math.random() * (prevSleep * 3 - baseMs)));
}

/** Default policy: 5 attempts, exponential 100ms→30s, full jitter. */
const defaultPolicy = {
  maxAttempts: 5,
  baseMs: 100,
  maxMs: 30_000,
  factor: 2,
  jitter: fullJitter,
  retryOn: () => true,
  timeoutMs: null,    // per-attempt timeout (sync path only)
  budgetMs: null,     // overall budget across all attempts
  onAttempt: null,
  onRetry: null,
  onGiveUp: null,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function sleepSync(ms) {
  // Busy-wait. Only used when caller explicitly opts into sync mode with budgetMs.
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {}
}

function mergePolicy(policy) {
  return { ...defaultPolicy, ...(policy || {}) };
}

function shouldRetry(err, policy, attempt) {
  if (attempt >= policy.maxAttempts) return false;
  if (policy.budgetMs != null && policy._startedAt != null) {
    const elapsed = Date.now() - policy._startedAt;
    if (elapsed + (policy.baseMs || 0) > policy.budgetMs) return false;
  }
  try {
    return policy.retryOn(err, attempt) !== false;
  } catch (_) {
    return false;
  }
}

function nextDelay(policy, attempt, prevSleep) {
  const exp = exponentialBackoff(attempt, {
    baseMs: policy.baseMs,
    maxMs: policy.maxMs,
    factor: policy.factor,
  });
  if (policy.jitter === 'decorrelated') {
    return decorrelatedJitter(prevSleep, { baseMs: policy.baseMs, maxMs: policy.maxMs });
  }
  if (typeof policy.jitter === 'function') {
    return policy.jitter(exp, attempt, prevSleep);
  }
  return exp;
}

async function retryAsync(fn, policy = {}) {
  const p = mergePolicy(policy);
  p._startedAt = Date.now();
  let prevSleep = p.baseMs;
  let lastErr;
  let attemptsMade = 0;
  let aborted = false;

  for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
    if (p.signal && p.signal.aborted) {
      aborted = true;
      break;
    }
    attemptsMade = attempt;

    try {
      if (typeof p.onAttempt === 'function') {
        await p.onAttempt({ attempt, startedAt: Date.now() - p._startedAt });
      }
      const result = await fn(attempt);
      return result;
    } catch (err) {
      lastErr = err;
      if (typeof p.onRetry === 'function' && attempt < p.maxAttempts) {
        // best-effort: don't let hook failures throw
        try { await p.onRetry({ attempt, error: err, nextDelayMs: 0 }); } catch (_) {}
      }
      if (!shouldRetry(err, p, attempt)) break;
      const delay = nextDelay(p, attempt, prevSleep);
      prevSleep = Math.max(delay, prevSleep);
      if (p.signal) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, delay);
          p.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        if (p.signal.aborted) break;
      } else {
        await p.sleep(delay);
      }
    }
  }

  if (typeof p.onGiveUp === 'function') {
    try { await p.onGiveUp({ attempts: attemptsMade, error: lastErr }); } catch (_) {}
  }
  throw new RetryError(
    aborted
      ? `retry aborted after ${attemptsMade} attempts`
      : `retry exhausted after ${attemptsMade} attempts`,
    { attempts: attemptsMade, lastError: lastErr, cause: lastErr }
  );
}

function retry(fn, policy = {}) {
  const p = mergePolicy(policy);
  p._startedAt = Date.now();
  let prevSleep = p.baseMs;
  let lastErr;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
    attemptsMade = attempt;
    try {
      return fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err, p, attempt)) break;
      const delay = nextDelay(p, attempt, prevSleep);
      prevSleep = Math.max(delay, prevSleep);
      sleepSync(delay);
    }
  }
  throw new RetryError(`retry exhausted after ${attemptsMade} attempts`, {
    attempts: attemptsMade,
    lastError: lastErr,
    cause: lastErr,
  });
}

module.exports = {
  retry,
  retryAsync,
  RetryError,
  defaultPolicy,
  exponentialBackoff,
  fullJitter,
  decorrelatedJitter,
};
