import { randomUUID } from "node:crypto";
import { AppError, toFailureDetail } from "../domain/errors.js";
import type { TaskRecord } from "../domain/task.js";
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
}

export class TaskRuntime {
  private active: TaskRecord | undefined;
  private controller: AbortController | undefined;

  public constructor(
    private readonly store: TaskStore,
    private readonly stopMinecraftAction: () => Promise<void>,
  ) {}

  public get current(): TaskRecord | undefined {
    return this.active;
  }

  public async run<Input, Output>(
    kind: string,
    input: Input,
    execute: (context: TaskContext) => Promise<Output>,
  ): Promise<TaskRecord<Input, Output>> {
    if (
      this.active !== undefined &&
      ["queued", "running", "suspended"].includes(this.active.status)
    ) {
      throw new AppError({
        category: "validation",
        code: "MAIN_TASK_BUSY",
        message: "Only one main task may run at a time",
        retryable: true,
      });
    }

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

    const context: TaskContext = {
      taskId: record.id,
      signal: controller.signal,
      advance: async (phase, checkpoint) => {
        if (this.active?.id !== record.id || this.active.status !== "running")
          return;
        record = transitionTask(record, {
          type: "advance",
          phase,
          ...(checkpoint === undefined ? {} : { checkpoint }),
        }) as TaskRecord<Input, Output>;
        this.active = record;
        await this.store.save(record);
      },
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
      if (this.controller === controller) this.controller = undefined;
    }
    this.active = record;
    await this.store.save(record);
    return record;
  }

  public async suspend(reason: string): Promise<void> {
    if (this.active?.status !== "running") return;
    this.active = transitionTask(this.active, {
      type: "suspend",
      phase: this.active.phase,
      checkpoint: { ...(this.active.checkpoint ?? {}), suspendReason: reason },
    });
    this.controller?.abort(new Error(reason));
    await this.stopMinecraftAction();
    await this.store.save(this.active);
  }

  public async cancel(reason: string): Promise<void> {
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
        code: "TASK_CANCELLED",
        message: reason,
        retryable: false,
        failedAt: this.active.phase,
      },
    });
    this.controller?.abort(new Error(reason));
    await this.stopMinecraftAction();
    await this.store.save(this.active);
  }

  private interruptedTask(taskId: string): TaskRecord | undefined {
    const active: TaskRecord | undefined = this.active;
    return active?.id === taskId &&
      (active.status === "suspended" || active.status === "cancelled")
      ? active
      : undefined;
  }
}
