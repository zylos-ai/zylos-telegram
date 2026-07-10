const RETRYABLE_CURL_EXIT_CODES = new Set([
  5,  // Could not resolve proxy
  6,  // Could not resolve host
  7,  // Failed to connect
  18, // Partial file
  28, // Operation timeout
  35, // TLS handshake failure
  52, // Empty reply
  55, // Failed sending data
  56, // Failed receiving data
  92, // HTTP/2 stream error
]);

export const DEFAULT_SEND_RETRY_POLICY = Object.freeze({
  maxRetries: 2,
  retryDelayMs: 4000,
  maxRetryDelayMs: 10000,
});

/**
 * Classify a Telegram send failure at the channel boundary.
 *
 * @param {Error} err
 * @returns {{ retryable: boolean, reason: string, retryAfterMs?: number }}
 */
export function classifySendError(err) {
  const telegramCode = Number(err?.telegramResponse?.error_code);
  const httpStatus = Number(err?.httpStatus);

  if (telegramCode === 429 || httpStatus === 429) {
    const retryAfterSeconds = Number(err?.telegramResponse?.parameters?.retry_after);
    return {
      retryable: true,
      reason: 'HTTP 429',
      ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? { retryAfterMs: retryAfterSeconds * 1000 }
        : {}),
    };
  }

  const status = Number.isFinite(telegramCode) && telegramCode > 0
    ? telegramCode
    : httpStatus;
  if (Number.isFinite(status) && status >= 500 && status <= 599) {
    return { retryable: true, reason: `HTTP ${status}` };
  }
  if (Number.isFinite(status) && status >= 400 && status <= 499) {
    return { retryable: false, reason: `HTTP ${status}` };
  }

  const curlExitCode = Number(err?.status);
  if (RETRYABLE_CURL_EXIT_CODES.has(curlExitCode)) {
    return { retryable: true, reason: `curl exit ${curlExitCode}` };
  }
  if (err?.killed || err?.signal === 'SIGTERM') {
    return { retryable: true, reason: 'curl timeout' };
  }

  return { retryable: false, reason: 'non-retryable failure' };
}

/**
 * Retry a Telegram send while bounding total retry sleep time.
 *
 * @template T
 * @param {() => T | Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.maxRetries]
 * @param {number} [options.retryDelayMs]
 * @param {number} [options.maxRetryDelayMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<T>}
 */
export async function withSendRetry(operation, options = {}) {
  const {
    maxRetries = DEFAULT_SEND_RETRY_POLICY.maxRetries,
    retryDelayMs = DEFAULT_SEND_RETRY_POLICY.retryDelayMs,
    maxRetryDelayMs = DEFAULT_SEND_RETRY_POLICY.maxRetryDelayMs,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    log = message => console.warn(message),
  } = options;

  let retryDelaySpentMs = 0;

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const classification = classifySendError(err);
      if (!classification.retryable || attempt >= maxRetries) throw err;

      const delayMs = Math.max(retryDelayMs, classification.retryAfterMs || 0);
      if (retryDelaySpentMs + delayMs > maxRetryDelayMs) {
        log(
          `[telegram] ${classification.reason}; retry skipped because `
          + `${delayMs}ms would exceed the ${maxRetryDelayMs}ms retry-delay budget`
        );
        throw err;
      }

      log(
        `[telegram] ${classification.reason}; retrying send `
        + `(attempt ${attempt + 2}/${maxRetries + 1}) in ${delayMs}ms`
      );
      await sleep(delayMs);
      retryDelaySpentMs += delayMs;
    }
  }
}
