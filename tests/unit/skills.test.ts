import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import type { ResourceTarget } from "../../src/minecraft/port.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { GatherLogsSkill } from "../../src/skills/gather-logs/gather-logs-skill.js";
import { FakeMinecraft, createSnapshot } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";

describe("gather logs skill", () => {
  it("gathers the requested inventory delta and returns to the live requester position", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({ inventory: [{ name: "oak_log", count: 5 }] }),
    );
    minecraft.resources.push(
      { name: "oak_log", position: { x: 5, y: 64, z: 0 } },
      { name: "oak_log", position: { x: 6, y: 64, z: 0 } },
    );
    const runtime = new TaskRuntime(new InMemoryTaskStore(), () =>
      minecraft.stopCurrentAction(),
    );
    const skill = new GatherLogsSkill(minecraft, runtime, new ActionArbiter(), {
      maxCount: 64,
      localSearchDistance: 32,
      maxSearchDistance: 64,
      searchStep: 16,
      moveRange: 3,
      returnRange: 3,
      maxPathAttempts: 2,
    });
    const result = await skill.run({
      resource: "oak_log",
      count: 2,
      requester: "owner",
    });
    expect(result.status).toBe("completed");
    expect(result.output).toMatchObject({ collectedCount: 2, heldCount: 7 });
    expect(
      minecraft.actions.filter((action) => action === "dig:oak_log"),
    ).toHaveLength(2);
    expect(minecraft.actions.at(-1)).toBe("move:0,64,0");
  });

  it("fails instead of reporting success when no resource exists in the bounded search", async () => {
    const minecraft = new FakeMinecraft();
    const runtime = new TaskRuntime(new InMemoryTaskStore(), () =>
      minecraft.stopCurrentAction(),
    );
    const skill = new GatherLogsSkill(minecraft, runtime, new ActionArbiter(), {
      maxCount: 64,
      localSearchDistance: 16,
      maxSearchDistance: 16,
      searchStep: 16,
      moveRange: 3,
      returnRange: 3,
      maxPathAttempts: 1,
    });
    const result = await skill.run({
      resource: "birch_log",
      count: 1,
      requester: "owner",
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("retries a transient dig path failure within the configured bound", async () => {
    class FlakyDigMinecraft extends FakeMinecraft {
      public digAttempts = 0;

      public override async dig(
        target: ResourceTarget,
        signal: AbortSignal,
      ): Promise<void> {
        this.digAttempts += 1;
        if (this.digAttempts === 1) {
          throw new AppError({
            category: "path",
            code: "PATHFINDER_FAILED",
            message: "transient path failure",
            retryable: true,
            failedAt: "dig",
          });
        }
        await super.dig(target, signal);
      }
    }

    const minecraft = new FlakyDigMinecraft();
    minecraft.resources.push({
      name: "oak_log",
      position: { x: 5, y: 64, z: 0 },
    });
    const skill = new GatherLogsSkill(
      minecraft,
      new TaskRuntime(new InMemoryTaskStore(), () =>
        minecraft.stopCurrentAction(),
      ),
      new ActionArbiter(),
      {
        maxCount: 64,
        localSearchDistance: 32,
        maxSearchDistance: 64,
        searchStep: 16,
        moveRange: 3,
        returnRange: 3,
        maxPathAttempts: 2,
      },
    );

    const result = await skill.run({
      resource: "oak_log",
      count: 1,
      requester: "owner",
    });
    expect(result.status).toBe("completed");
    expect(minecraft.digAttempts).toBe(2);
  });

  it("re-scans when the selected resource changes before digging", async () => {
    class ChangedResourceMinecraft extends FakeMinecraft {
      public digAttempts = 0;

      public override async dig(
        target: ResourceTarget,
        signal: AbortSignal,
      ): Promise<void> {
        this.digAttempts += 1;
        if (this.digAttempts === 1) {
          this.resources.shift();
          throw new AppError({
            category: "resource",
            code: "RESOURCE_CHANGED",
            message: "resource changed",
            retryable: true,
            failedAt: "dig",
          });
        }
        await super.dig(target, signal);
      }
    }

    const minecraft = new ChangedResourceMinecraft();
    minecraft.resources.push(
      { name: "oak_log", position: { x: 5, y: 64, z: 0 } },
      { name: "oak_log", position: { x: 6, y: 64, z: 0 } },
    );
    const skill = new GatherLogsSkill(
      minecraft,
      new TaskRuntime(new InMemoryTaskStore(), () =>
        minecraft.stopCurrentAction(),
      ),
      new ActionArbiter(),
      {
        maxCount: 64,
        localSearchDistance: 32,
        maxSearchDistance: 64,
        searchStep: 16,
        moveRange: 3,
        returnRange: 3,
        maxPathAttempts: 2,
      },
    );

    const result = await skill.run({
      resource: "oak_log",
      count: 1,
      requester: "owner",
    });
    expect(result.status).toBe("completed");
    expect(minecraft.digAttempts).toBe(2);
  });
});
