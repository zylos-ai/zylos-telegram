import { describe, expect, it, vi } from 'vitest';
import { classifySendError, withSendRetry } from '../src/lib/send-retry.js';

function telegramError(errorCode, retryAfter = null) {
  const err = new Error(`Telegram error ${errorCode}`);
  err.telegramResponse = {
    ok: false,
    error_code: errorCode,
    ...(retryAfter == null ? {} : { parameters: { retry_after: retryAfter } }),
  };
  err.httpStatus = errorCode;
  return err;
}

function curlError(status) {
  const err = new Error(`curl failed with exit ${status}`);
  err.status = status;
  return err;
}

describe('send failure classification', () => {
  it('retries transport, HTTP 5xx, and 429 failures', () => {
    expect(classifySendError(curlError(35))).toMatchObject({ retryable: true, reason: 'curl exit 35' });
    expect(classifySendError(telegramError(502))).toMatchObject({ retryable: true, reason: 'HTTP 502' });
    expect(classifySendError(telegramError(429, 5))).toEqual({
      retryable: true,
      reason: 'HTTP 429',
      retryAfterMs: 5000,
    });
  });

  it('does not retry non-429 HTTP 4xx or local curl failures', () => {
    expect(classifySendError(telegramError(400))).toMatchObject({ retryable: false });
    expect(classifySendError(telegramError(401))).toMatchObject({ retryable: false });
    expect(classifySendError(curlError(26))).toMatchObject({ retryable: false });
  });
});

describe('withSendRetry', () => {
  it('retries a transport failure at 4-second intervals and logs each retry', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(curlError(35))
      .mockRejectedValueOnce(curlError(7))
      .mockResolvedValue('sent');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(withSendRetry(operation, { sleep, log })).resolves.toBe('sent');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[4000], [4000]]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('curl exit 35');
    expect(log.mock.calls[1][0]).toContain('attempt 3/3');
  });

  it('honors Telegram retry_after when it exceeds the normal interval', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(telegramError(429, 5))
      .mockResolvedValue('sent');
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withSendRetry(operation, { sleep, log: vi.fn() })).resolves.toBe('sent');
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('retries HTTP 5xx but fails a permanent 4xx immediately', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const transient = vi.fn()
      .mockRejectedValueOnce(telegramError(503))
      .mockResolvedValue('sent');
    await expect(withSendRetry(transient, { sleep, log: vi.fn() })).resolves.toBe('sent');
    expect(transient).toHaveBeenCalledTimes(2);

    const permanent = vi.fn().mockRejectedValue(telegramError(403));
    await expect(withSendRetry(permanent, { sleep, log: vi.fn() })).rejects.toThrow('Telegram error 403');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('stops after two retries', async () => {
    const operation = vi.fn().mockRejectedValue(curlError(56));

    await expect(withSendRetry(operation, {
      sleep: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    })).rejects.toThrow('curl failed with exit 56');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not violate retry_after when it exceeds the total delay budget', async () => {
    const operation = vi.fn().mockRejectedValue(telegramError(429, 11));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(withSendRetry(operation, { sleep, log })).rejects.toThrow('Telegram error 429');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('retry skipped');
  });
});
