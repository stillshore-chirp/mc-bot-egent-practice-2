import { AppError } from "../domain/errors.js";
import { delay } from "./timeout.js";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  shouldRetry: (error: unknown) => boolean,
  signal?: AbortSignal,
): Promise<T> {
  if (policy.maxAttempts < 1) {
    throw new AppError({
      category: "validation",
      code: "INVALID_RETRY_POLICY",
      message: "maxAttempts must be at least one",
      retryable: false,
    });
  }
  let nextDelay = policy.initialDelayMs;
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal?.aborted === true) throw signal.reason;
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === policy.maxAttempts || !shouldRetry(error)) throw error;
      await delay(nextDelay, signal);
      nextDelay = Math.min(
        policy.maxDelayMs,
        Math.ceil(nextDelay * policy.multiplier),
      );
    }
  }
  throw lastError;
}
