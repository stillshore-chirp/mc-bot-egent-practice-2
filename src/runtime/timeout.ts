import { AppError } from "../domain/errors.js";

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  failedAt?: string,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    parentSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([parentSignal, timeoutSignal]);
  try {
    return await operation(signal);
  } catch (error) {
    if (timeoutSignal.aborted && !(parentSignal?.aborted ?? false)) {
      throw new AppError(
        {
          category: "timeout",
          code: "ACTION_TIMEOUT",
          message: `Action exceeded ${String(timeoutMs)}ms`,
          retryable: true,
          ...(failedAt === undefined ? {} : { failedAt }),
        },
        { cause: error },
      );
    }
    throw error;
  }
}

export function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Delay cancelled"),
      );
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Delay cancelled"),
        );
      },
      { once: true },
    );
  });
}
