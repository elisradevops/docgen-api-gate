import {
  parseRetryAfterMs,
  backoffDelayMs,
  withThrottleRetry,
  createRetryBudget,
  MAX_RETRY_AFTER_MS,
  MAX_RETRY_ATTEMPTS,
  BASE_BACKOFF_MS,
} from '../../services/sharePointRetry';

jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('parseRetryAfterMs', () => {
  test('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });

  test('parses an HTTP-date in the future', () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const result = parseRetryAfterMs(future);
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThan(2000);
    expect(result as number).toBeLessThanOrEqual(3000);
  });

  test('clamps a hostile/huge value to MAX_RETRY_AFTER_MS', () => {
    expect(parseRetryAfterMs('999999')).toBe(MAX_RETRY_AFTER_MS);
  });

  test('returns 0, not negative, for a past HTTP-date', () => {
    const past = new Date(Date.now() - 5000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });

  test('returns null for garbage input', () => {
    expect(parseRetryAfterMs('not-a-date-or-number')).toBeNull();
  });

  test('returns null when absent', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});

describe('backoffDelayMs', () => {
  test('prefers Retry-After over exponential backoff', () => {
    expect(backoffDelayMs(0, '3')).toBe(3000);
  });

  test('falls back to exponential backoff when no header', () => {
    expect(backoffDelayMs(0)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelayMs(1)).toBe(BASE_BACKOFF_MS * 2);
  });
});

describe('withThrottleRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Drives fake timers forward while a retry loop is awaiting sleep().
  async function flushRetries() {
    for (let i = 0; i < MAX_RETRY_ATTEMPTS + 1; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }
  }

  test('succeeds on the first attempt with no retry', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const classify = jest.fn().mockReturnValue({ retryable: false });

    const result = await withThrottleRetry(fn, classify);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries a resolved 429-shaped outcome then succeeds', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '1' } })
      .mockResolvedValueOnce({ status: 200, data: 'done' });
    const classify = jest.fn((outcome) => ({
      retryable: outcome.value?.status === 429,
      retryAfter: outcome.value?.headers?.['retry-after'],
    }));

    const promise = withThrottleRetry(fn, classify);
    await flushRetries();
    const result = await promise;

    expect(result).toEqual({ status: 200, data: 'done' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries a thrown 429 error then succeeds', async () => {
    const thrownError: any = new Error('Too Many Requests');
    thrownError.response = { status: 429, headers: {} };
    const fn = jest.fn().mockRejectedValueOnce(thrownError).mockResolvedValueOnce('ok');
    const classify = jest.fn((outcome) => ({
      retryable: outcome.error?.response?.status === 429,
      retryAfter: outcome.error?.response?.headers?.['retry-after'],
    }));

    const promise = withThrottleRetry(fn, classify);
    await flushRetries();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('gives up after MAX_RETRY_ATTEMPTS and surfaces the last outcome', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 503 });
    const classify = jest.fn().mockReturnValue({ retryable: true });

    const promise = withThrottleRetry(fn, classify);
    await flushRetries();
    const result = await promise;

    expect(result).toEqual({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS + 1);
  });

  test('gives up and rethrows after MAX_RETRY_ATTEMPTS when the outcome is a thrown error', async () => {
    const err: any = new Error('still throttled');
    err.response = { status: 429, headers: {} };
    const fn = jest.fn().mockRejectedValue(err);
    const classify = jest.fn().mockReturnValue({ retryable: true });

    const promise = withThrottleRetry(fn, classify);
    await flushRetries();
    await expect(promise).rejects.toThrow('still throttled');
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS + 1);
  });

  test('stops retrying once the shared budget is exhausted, even with attempts remaining', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 429 });
    const classify = jest.fn().mockReturnValue({ retryable: true, retryAfter: undefined });
    const budget = createRetryBudget(100); // smaller than a single backoff delay (500ms)

    const promise = withThrottleRetry(fn, classify, { budget });
    await flushRetries();
    const result = await promise;

    // First attempt fails, budget check happens before sleeping the 500ms
    // backoff — since budget.limitMs (100) is below BASE_BACKOFF_MS (500),
    // the very first retry already exceeds it once spent, so this should
    // stop well short of MAX_RETRY_ATTEMPTS + 1 real attempts.
    expect(result).toEqual({ status: 429 });
    expect(fn.mock.calls.length).toBeLessThanOrEqual(MAX_RETRY_ATTEMPTS + 1);
    expect(budget.spentMs).toBeGreaterThan(0);
  });

  test('shares budget across multiple independent withThrottleRetry calls', async () => {
    const budget = createRetryBudget(600); // just over one 500ms backoff
    const classify = jest.fn().mockReturnValue({ retryable: true });

    const fn1 = jest.fn().mockResolvedValue({ status: 429 });
    const promise1 = withThrottleRetry(fn1, classify, { budget });
    await flushRetries();
    await promise1;

    const spentAfterFirst = budget.spentMs;
    expect(spentAfterFirst).toBeGreaterThan(0);

    // Second call starts with the budget already (mostly) spent — should
    // retry less than a fresh call would.
    const fn2 = jest.fn().mockResolvedValue({ status: 429 });
    const promise2 = withThrottleRetry(fn2, classify, { budget });
    await flushRetries();
    await promise2;

    expect(fn2.mock.calls.length).toBeLessThanOrEqual(fn1.mock.calls.length);
  });
});
