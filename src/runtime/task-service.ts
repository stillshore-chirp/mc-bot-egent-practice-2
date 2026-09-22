import { randomUUID } from "node:crypto";
import { AppError, toFailureDetail } from "../domain/errors.js";
import type { TaskRecord } from "../domain/task.js";
import type { ActiveTraceSpan, TraceService } from "../trace/service.js";
import { createTraceRetryObserver } from "../trace/retry-observer.js";
import { retry as runWithRetry, type RetryPolicy } from "./retry.js";
import { transitionTask } from "./task-machine.js";

export interface TaskStore {
  save(record: TaskRecord): Promise<void>;
}

export interface TaskContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
  advance(
    phase: string,
    checkpoint?: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  retry<T>(
    operationName: string,
    operation: (attempt: number) => Promise<T>,
    policy: RetryPolicy,
    shouldRetry: (error: unknown) => boolean,
    signal?: AbortSignal,
  ): Promise<T>;
}

export class TaskRuntime {
  private active: TaskRecord | undefined;
  private controller: AbortController | undefined;
  private readonly interruptedRecords = new Map<string, TaskRecord>();
  private readonly pendingExecutions = new Set<string>();
  private suspendedReplacement: Promise<void> | undefined;
  private activeTraceSpan: ActiveTraceSpan | undefined;
  private activePhaseTraceSpan: ActiveTraceSpan | undefined;
  private activePhaseStartedAt: number | undefined;
  private activePhase: string | undefined;

  public constructor(
    private readonly store: TaskStore,
    private readonly stopMinecraftAction: () => Promise<void>,
    private readonly traceService?: TraceService,
  ) {}

  public get current(): TaskRecord | undefined {
    return this.active;
  }

  private isActiveRunning(taskId: string): boolean {
    const active = this.active;
    if (active === undefined) return false;
    return active.id === taskId && active.status === "running";
  }

  public async run<Input, Output>(
    kind: string,
    input: Input,
    execute: (context: TaskContext) => Promise<Output>,
  ): Promise<TaskRecord<Input, Output>> {
    const traceSpan = await this.startTraceSpan(kind);
    const startedAt = performance.now();
    if (this.active?.status === "suspended") {
      await this.replaceSuspendedTask(
        "新しい利用者指示を受けたため、安全待機中の作業を置き換えました",
      );
    }
    if (
      this.active !== undefined &&
      ["queued", "running"].includes(this.active.status)
    ) {
      const error = new AppError({
        category: "validation",
        code: "MAIN_TASK_BUSY",
        message: "Only one main task may run at a time",
        retryable: true,
      });
      await this.finishTraceSpan(traceSpan, "failed", startedAt, error, false);
      throw error;
    }

    this.activeTraceSpan = traceSpan;
    try {
      const result = await this.runTask(kind, input, execute);
      await this.finishTraceSpan(
        traceSpan,
        result.status,
        startedAt,
        result,
        this.activeTraceSpan === traceSpan,
      );
      return result;
    } catch (error) {
      await this.finishTraceSpan(traceSpan, "failed", startedAt, error);
      throw error;
    } finally {
      if (this.activeTraceSpan === traceSpan) this.activeTraceSpan = undefined;
    }
  }

  private async runTask<Input, Output>(
    kind: string,
    input: Input,
    execute: (context: TaskContext) => Promise<Output>,
  ): Promise<TaskRecord<Input, Output>> {
    const now = new Date().toISOString();
    let record: TaskRecord<Input, Output> = {
      id: randomUUID(),
      kind,
      status: "queued",
      phase: "queued",
      input,
      createdAt: now,
      updatedAt: now,
    };
    this.active = record;
    const controller = new AbortController();
    this.controller = controller;
    await this.store.save(record);
    if (this.active.status === "cancelled") {
      if (this.controller === controller) this.controller = undefined;
      return this.active as TaskRecord<Input, Output>;
    }
    record = transitionTask(record, {
      type: "start",
      phase: "starting",
    }) as TaskRecord<Input, Output>;
    this.active = record;
    await this.store.save(record);
    if (this.active.status === "cancelled" || controller.signal.aborted) {
      if (this.controller === controller) this.controller = undefined;
      return this.active as TaskRecord<Input, Output>;
    }
    await this.startPhaseTraceSpan(record.phase);
    this.pendingExecutions.add(record.id);

    const context: TaskContext = {
      taskId: record.id,
      signal: controller.signal,
      advance: async (phase, checkpoint) => {
        if (!this.isActiveRunning(record.id)) return;
        record = transitionTask(record, {
          type: "advance",
          phase,
          ...(checkpoint === undefined ? {} : { checkpoint }),
        }) as TaskRecord<Input, Output>;
        this.active = record;
        const previousPhase = this.finishPhaseTraceSpan("succeeded");
        await this.store.save(record);
        await previousPhase;
        if (!this.isActiveRunning(record.id)) return;
        await this.startPhaseTraceSpan(record.phase);
      },
      retry: (operationName, operation, policy, shouldRetry, signal) =>
        runWithRetry(
          operation,
          policy,
          shouldRetry,
          signal === undefined
            ? controller.signal
            : AbortSignal.any([controller.signal, signal]),
          createTraceRetryObserver(
            this.traceService,
            operationName,
            () =>
              this.activePhaseTraceSpan?.spanId ?? this.activeTraceSpan?.spanId,
          ),
        ),
    };

    try {
      const output = await execute(context);
      const interrupted = this.interruptedTask(record.id);
      if (interrupted !== undefined)
        return interrupted as TaskRecord<Input, Output>;
      record = transitionTask(record, {
        type: "complete",
        phase: "completed",
        output,
      }) as TaskRecord<Input, Output>;
    } catch (error) {
      const interrupted = this.interruptedTask(record.id);
      if (interrupted !== undefined)
        return interrupted as TaskRecord<Input, Output>;
      record = transitionTask(record, {
        type: "fail",
        phase: record.phase,
        failure: toFailureDetail(error, {
          category: "observation",
          code: "TASK_FAILED",
          message: error instanceof Error ? error.message : "Task failed",
          retryable: false,
          failedAt: record.phase,
        }),
      }) as TaskRecord<Input, Output>;
    } finally {
      this.pendingExecutions.delete(record.id);
      if (this.controller === controller) this.controller = undefined;
    }
    if (!this.isCurrentTask(record.id)) {
      const interrupted = this.interruptedTask(record.id);
      if (interrupted !== undefined) {
        return interrupted as TaskRecord<Input, Output>;
      }
      return record;
    }
    this.active = record;
    await this.store.save(record);
    return record;
  }

  private async startTraceSpan(
    kind: string,
  ): Promise<ActiveTraceSpan | undefined> {
    const traceService = this.traceService;
    if (traceService === undefined) return undefined;
    try {
      return await traceService.startSpan("skill", `skill:${kind}`, {
        summary: "決定論的skillを実行",
        expectedResult: "skillの実行結果を確認",
        attributes: { kind },
      });
    } catch {
      return undefined;
    }
  }

  private async finishTraceSpan(
    span: ActiveTraceSpan | undefined,
    status: TaskRecord["status"] | "failed",
    startedAt: number,
    result: unknown,
    finishPhase = true,
  ): Promise<void> {
    if (span === undefined) return;
    const durationMs = Math.max(0, performance.now() - startedAt);
    try {
      if (isTaskRecord(result)) {
        if (finishPhase) {
          await this.finishPhaseTraceSpan(
            result.status === "completed"
              ? "succeeded"
              : result.status === "cancelled"
                ? "cancelled"
                : result.status === "suspended"
                  ? "waiting"
                  : "failed",
          );
        }
        const completion = {
          actualResult:
            result.status === "completed"
              ? "skillの実行を完了"
              : result.status === "cancelled"
                ? "skillをキャンセル"
                : result.status === "suspended"
                  ? "skillを安全待機へ移行"
                  : "skillを完了できず",
          metrics: { durationMs },
          ...(result.failure?.code === undefined
            ? {}
            : { errorCode: result.failure.code }),
          attributes: { status: result.status, phase: result.phase },
        };
        if (result.status === "completed") {
          await span.succeed(completion);
        } else if (result.status === "cancelled") {
          await span.cancel(completion);
        } else if (result.status === "suspended") {
          await span.wait("安全介入後の再評価を待機", {
            status: result.status,
            phase: result.phase,
          });
        } else {
          await span.fail(completion);
        }
        return;
      }
      if (finishPhase) await this.finishPhaseTraceSpan("failed");
      const errorCode =
        result instanceof AppError ? result.detail.code : "TASK_RUNTIME_FAILED";
      await span.fail({
        actualResult: "skillを完了できず",
        errorCode,
        metrics: { durationMs },
      });
    } catch {
      // Observability is deliberately best effort and cannot alter task state.
    }
  }

  private async startPhaseTraceSpan(phase: string): Promise<void> {
    const skillSpan = this.activeTraceSpan;
    const session = this.traceService?.currentSession();
    if (skillSpan === undefined || session === undefined) return;
    try {
      const span = await session.startSpan(
        "skill",
        `phase:${phase}`,
        skillSpan.spanId,
        {
          summary: "skill内部stepを実行",
          expectedResult: "skill内部stepの結果を確認",
          attributes: { phase },
        },
      );
      this.activePhaseTraceSpan = span;
      this.activePhaseStartedAt = performance.now();
      this.activePhase = phase;
    } catch {
      // Phase tracing is best effort and cannot alter task execution.
    }
  }

  private async finishPhaseTraceSpan(
    status: "succeeded" | "failed" | "cancelled" | "waiting",
  ): Promise<void> {
    const span = this.activePhaseTraceSpan;
    const phase = this.activePhase;
    const startedAt = this.activePhaseStartedAt;
    this.activePhaseTraceSpan = undefined;
    this.activePhaseStartedAt = undefined;
    this.activePhase = undefined;
    if (span === undefined || phase === undefined || startedAt === undefined)
      return;
    const completion = {
      actualResult:
        status === "succeeded"
          ? "skill内部stepを完了"
          : status === "cancelled"
            ? "skill内部stepをキャンセル"
            : status === "waiting"
              ? "安全介入によりskill内部stepを待機"
              : "skill内部stepを完了できず",
      metrics: {
        durationMs: Math.max(0, performance.now() - startedAt),
      },
      attributes: { phase, status },
    };
    try {
      if (status === "succeeded") {
        await span.succeed(completion);
      } else if (status === "cancelled") {
        await span.cancel(completion);
      } else if (status === "waiting") {
        await span.wait("安全介入後の再評価を待機", { phase });
      } else {
        await span.fail(completion);
      }
    } catch {
      // Phase observability is deliberately best effort.
    }
  }

  public async suspend(reason: string): Promise<void> {
    if (this.active?.status !== "running") return;
    this.active = transitionTask(this.active, {
      type: "suspend",
      phase: this.active.phase,
      checkpoint: { ...(this.active.checkpoint ?? {}), suspendReason: reason },
    });
    this.controller?.abort(new Error(reason));
    await this.finishPhaseTraceSpan("waiting");
    await this.stopMinecraftAction();
    await this.store.save(this.active);
  }

  private async replaceSuspendedTask(reason: string): Promise<void> {
    const pending = this.suspendedReplacement;
    if (pending !== undefined) {
      await pending;
      return;
    }
    const replacement = this.replaceSuspendedTaskNow(reason);
    this.suspendedReplacement = replacement;
    try {
      await replacement;
    } finally {
      if (this.suspendedReplacement === replacement) {
        this.suspendedReplacement = undefined;
      }
    }
  }

  private async replaceSuspendedTaskNow(reason: string): Promise<void> {
    const active = this.active;
    if (active?.status !== "suspended") return;
    const replaced = transitionTask(active, {
      type: "cancel",
      phase: active.phase,
      failure: {
        category: "cancelled",
        code: "TASK_REPLACED_AFTER_SUSPENSION",
        message: reason,
        retryable: true,
        failedAt: active.phase,
      },
    });
    if (this.pendingExecutions.has(active.id)) {
      this.interruptedRecords.set(active.id, replaced);
    } else {
      this.interruptedRecords.delete(active.id);
    }
    this.active = replaced;
    this.controller?.abort(new Error(reason));
    // suspend() has already stopped Minecraft controls before this task can
    // reach the suspended state. Avoid issuing a second stop while replacing
    // the persisted task with the owner's new explicit instruction.
    await this.store.save(replaced);
  }

  public async cancel(reason: string, code = "TASK_CANCELLED"): Promise<void> {
    if (
      this.active === undefined ||
      !["queued", "running", "suspended"].includes(this.active.status)
    )
      return;
    this.active = transitionTask(this.active, {
      type: "cancel",
      phase: this.active.phase,
      failure: {
        category: "cancelled",
        code,
        message: reason,
        retryable: false,
        failedAt: this.active.phase,
      },
    });
    this.controller?.abort(new Error(reason));
    await this.finishPhaseTraceSpan("cancelled");
    await this.stopMinecraftAction();
    await this.store.save(this.active);
  }

  private interruptedTask(taskId: string): TaskRecord | undefined {
    const interrupted = this.interruptedRecords.get(taskId);
    if (interrupted !== undefined) {
      this.interruptedRecords.delete(taskId);
      return interrupted;
    }
    const active: TaskRecord | undefined = this.active;
    return active?.id === taskId &&
      (active.status === "suspended" || active.status === "cancelled")
      ? active
      : undefined;
  }

  private isCurrentTask(taskId: string): boolean {
    return this.active?.id === taskId;
  }
}

function isTaskRecord(value: unknown): value is TaskRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "phase" in value
  );
}
