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
