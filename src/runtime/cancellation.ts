import { AppError } from "../domain/errors.js";

export function throwIfAborted(signal: AbortSignal, failedAt?: string): void {
  if (!signal.aborted) return;
  throw new AppError(
    {
      category: "cancelled",
      code: "ACTION_CANCELLED",
      message: "The action was cancelled",
      retryable: false,
      ...(failedAt === undefined ? {} : { failedAt }),
    },
    { cause: signal.reason },
  );
}

export function combineSignals(
  ...signals: readonly AbortSignal[]
): AbortSignal {
  return AbortSignal.any([...signals]);
}
