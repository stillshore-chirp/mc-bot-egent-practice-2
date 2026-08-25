import { AppError } from "../domain/errors.js";
import type {
  RetryAttemptFailed,
  RetryAttemptStarted,
  RetryObserver,
} from "../runtime/retry.js";
import type { ActiveTraceSpan, TraceService } from "./service.js";

export function createTraceRetryObserver(
  traceService: TraceService | undefined,
  operationName: string,
  parentSpanId?: () => string | undefined,
): RetryObserver | undefined {
  if (traceService === undefined) return undefined;
  let current: ActiveTraceSpan | undefined;
  let previous: ActiveTraceSpan | undefined;

  return {
    onAttemptStarted: async (event) => {
      const session = traceService.currentSession();
      if (session === undefined) return;
      const parent = parentSpanId?.();
      current =
        parent === undefined
          ? await traceService.startSpan(
              "recovery",
              `retry:${operationName}:attempt`,
              attemptOptions(event),
            )
          : await session.startSpan(
              "recovery",
              `retry:${operationName}:attempt`,
              parent,
              attemptOptions(event),
            );
      if (current !== undefined && previous !== undefined) {
        await session.link("retry_of", current.spanId, previous.spanId);
      }
    },
    onAttemptSucceeded: async (event) => {
      const span = current;
      current = undefined;
      if (span === undefined) return;
      await span.succeed({
        actualResult: "再試行attemptを完了",
        attributes: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
        },
      });
      previous = span;
    },
    onAttemptFailed: async (event) => {
      const span = current;
      current = undefined;
      if (span === undefined) return;
      await span.fail({
        actualResult: event.willRetry
          ? "再試行attempt失敗後に次attemptを予定"
          : "再試行attemptを完了できず",
        errorCode: retryErrorCode(event.error),
        attributes: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          willRetry: event.willRetry,
          ...(event.scheduledDelayMs === undefined
            ? {}
            : { scheduledDelayMs: event.scheduledDelayMs }),
        },
      });
      previous = span;
    },
  };
}

function attemptOptions(event: RetryAttemptStarted) {
  return {
    summary: "実処理の再試行attemptを実行",
    expectedResult: "attemptの成功または失敗を確認",
    attributes: {
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
    },
  } as const;
}

function retryErrorCode(error: RetryAttemptFailed["error"]): string {
  if (error instanceof AppError) return error.detail.code;
  if (error instanceof Error) return error.name.slice(0, 160);
  return "UNKNOWN_RETRY_ERROR";
}
