import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import type { TaskRecord } from "../../src/domain/task.js";
import {
  ActionArbiter,
  actionPriorities,
} from "../../src/runtime/action-arbiter.js";
import { retry } from "../../src/runtime/retry.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";
import { transitionTask } from "../../src/runtime/task-machine.js";

const queuedTask = (): TaskRecord => ({
  id: "task-1",
  kind: "test",
  status: "queued",
  phase: "queued",
  input: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe("task state machine", () => {
  it("distinguishes running, suspended and cancelled", () => {
    const running = transitionTask(queuedTask(), {
      type: "start",
      phase: "running",
    });
    const suspended = transitionTask(running, {
      type: "suspend",
      phase: "moving",
    });
    const cancelled = transitionTask(suspended, {
      type: "cancel",
      phase: "moving",
      failure: {
        category: "cancelled",
        code: "STOP",
        message: "stop",
        retryable: false,
      },
    });
    expect([running.status, suspended.status, cancelled.status]).toEqual([
      "running",
      "suspended",
      "cancelled",
    ]);
  });

  it("rejects terminal transitions", () => {
    const completed = transitionTask(
      transitionTask(queuedTask(), { type: "start", phase: "run" }),
      {
        type: "complete",
        phase: "done",
        output: {},
      },
    );
    expect(() =>
      transitionTask(completed, { type: "start", phase: "again" }),
    ).toThrow(AppError);
  });
});

describe("ActionArbiter", () => {
  it("lets a reflex preempt a task lease", () => {
    const arbiter = new ActionArbiter();
    const task = arbiter.acquire("task", actionPriorities.task);
    const reflex = arbiter.acquire("reflex", actionPriorities.reflex);
    expect(task.signal.aborted).toBe(true);
    expect(arbiter.currentOwner).toBe("reflex");
    reflex.release();
  });

  it("waits for a reflex lease to release before a task resumes", async () => {
    const arbiter = new ActionArbiter();
    const reflex = arbiter.acquire("reflex:stuck", actionPriorities.reflex);
    let resumed = false;
    const waiting = (async () => {
      await arbiter.waitForAvailable(actionPriorities.task);
      const task = arbiter.acquire("task:replacement", actionPriorities.task);
      resumed = true;
      task.release();
    })();

    await Promise.resolve();
    expect(resumed).toBe(false);
    reflex.release();
    await waiting;
    expect(resumed).toBe(true);
  });
});

describe("TaskRuntime", () => {
  it("cancels a running operation and immediately stops Minecraft controls", async () => {
    const store = new InMemoryTaskStore();
    let stopped = 0;
    const runtime = new TaskRuntime(store, async () => {
      stopped += 1;
    });
    const running = runtime.run("long", {}, async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw signal.reason;
    });
    await Promise.resolve();
    await runtime.cancel("owner stop");
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(stopped).toBe(1);
  });

  it("preserves a timeout code when cancellation comes from a deadline", async () => {
    const store = new InMemoryTaskStore();
    const runtime = new TaskRuntime(store, async () => undefined);
    const running = runtime.run("long", {}, async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw signal.reason;
    });
    await Promise.resolve();

    await runtime.cancel("deadline", "TASK_TIMEOUT");
    const result = await running;

    expect(result).toMatchObject({
      status: "cancelled",
      failure: { category: "cancelled", code: "TASK_TIMEOUT" },
    });
  });

  it("refuses a second main task", async () => {
    const runtime = new TaskRuntime(
      new InMemoryTaskStore(),
      async () => undefined,
    );
    const first = runtime.run("first", {}, async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {};
    });
    await Promise.resolve();
    await expect(
      runtime.run("second", {}, async () => ({})),
    ).rejects.toMatchObject({
      detail: { code: "MAIN_TASK_BUSY" },
    });
    await runtime.cancel("test cleanup");
    await first;
  });

  it("replaces a suspended task for a new instruction without stale overwrite", async () => {
    const store = new InMemoryTaskStore();
    let stopCount = 0;
    let taskStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      taskStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime = new TaskRuntime(store, async () => {
      stopCount += 1;
    });
    const first = runtime.run("follow_player", {}, async ({ signal }) => {
      taskStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await firstCanFinish;
      throw signal.reason;
    });
    await started;
    await runtime.suspend("reflex:stuck");

    let replacementStarted!: () => void;
    const replacementReady = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    const replacement = runtime.run("move_to", { retry: true }, async () => {
      replacementStarted();
      return { restarted: true };
    });
    await replacementReady;
    releaseFirst();

    const [firstResult, replacementResult] = await Promise.all([
      first,
      replacement,
    ]);
    expect(firstResult).toMatchObject({
      status: "cancelled",
      failure: { code: "TASK_REPLACED_AFTER_SUSPENSION" },
    });
    expect(replacementResult).toMatchObject({
      status: "completed",
      output: { restarted: true },
    });
    expect(runtime.current).toMatchObject({
      kind: "move_to",
      status: "completed",
    });
    expect(stopCount).toBe(1);
    expect(
      store.records.some(
        (record) => record.failure?.code === "TASK_REPLACED_AFTER_SUSPENSION",
      ),
    ).toBe(true);
  });

  it("does not retain an interrupted record after the suspended run has ended", async () => {
    const runtime = new TaskRuntime(
      new InMemoryTaskStore(),
      async () => undefined,
    );
    let started!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = runtime.run("follow_player", {}, async ({ signal }) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw signal.reason;
    });
    await taskStarted;
    await runtime.suspend("reflex:stuck");
    await first;

    await runtime.run("move_to", {}, async () => ({ restarted: true }));

    const interruptedRecords = (
      runtime as unknown as {
        interruptedRecords: Map<string, TaskRecord>;
      }
    ).interruptedRecords;
    expect(interruptedRecords.size).toBe(0);
  });
});

describe("retry", () => {
  it("uses a bounded attempt count", async () => {
    let attempts = 0;
    await expect(
      retry(
        async () => {
          attempts += 1;
          throw new Error("retry");
        },
        { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1 },
        () => true,
      ),
    ).rejects.toThrow("retry");
    expect(attempts).toBe(3);
  });
});
