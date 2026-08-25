import { AppError } from "../domain/errors.js";
import { delay } from "./timeout.js";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
}

export interface RetryAttemptStarted {
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type RetryAttemptSucceeded = RetryAttemptStarted;

export interface RetryAttemptFailed extends RetryAttemptStarted {
  readonly error: unknown;
  readonly willRetry: boolean;
  readonly scheduledDelayMs?: number | undefined;
}

export interface RetryObserver {
  readonly onAttemptStarted?: (
    event: RetryAttemptStarted,
  ) => void | Promise<void>;
  readonly onAttemptSucceeded?: (
    event: RetryAttemptSucceeded,
  ) => void | Promise<void>;
  readonly onAttemptFailed?: (
    event: RetryAttemptFailed,
  ) => void | Promise<void>;
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  shouldRetry: (error: unknown) => boolean,
  signal?: AbortSignal,
  observer?: RetryObserver,
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
    await notify(observer?.onAttemptStarted, {
      attempt,
      maxAttempts: policy.maxAttempts,
    });
    try {
      const result = await operation(attempt);
      await notify(observer?.onAttemptSucceeded, {
        attempt,
        maxAttempts: policy.maxAttempts,
      });
      return result;
    } catch (error) {
      lastError = error;
      const willRetry = attempt < policy.maxAttempts && shouldRetry(error);
      await notify(observer?.onAttemptFailed, {
        attempt,
        maxAttempts: policy.maxAttempts,
        error,
        willRetry,
        ...(willRetry ? { scheduledDelayMs: nextDelay } : {}),
      });
      if (!willRetry) throw error;
      await delay(nextDelay, signal);
      nextDelay = Math.min(
        policy.maxDelayMs,
        Math.ceil(nextDelay * policy.multiplier),
      );
    }
  }
  throw lastError;
}

async function notify<T>(
  callback: ((event: T) => void | Promise<void>) | undefined,
  event: T,
): Promise<void> {
  if (callback === undefined) return;
  try {
    await callback(event);
  } catch {
    // Retry observation is best effort and cannot change operation semantics.
  }
}
