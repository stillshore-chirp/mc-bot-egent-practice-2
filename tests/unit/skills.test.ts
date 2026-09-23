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

  it("returns within the measured distance despite block coordinate rounding", async () => {
    class RoundedArrival extends FakeMinecraft {
      override async moveTo(
        position: ResourceTarget["position"],
        range: number,
        signal: AbortSignal,
      ) {
        await super.moveTo(
          { ...position, x: position.x + range + 0.6 },
          range,
          signal,
        );
      }
    }
    const minecraft = new RoundedArrival();
    minecraft.resources.push({
      name: "oak_log",
      position: { x: 8, y: 64, z: 0 },
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
        maxPathAttempts: 1,
      },
    );
    const result = await skill.run({
      resource: "oak_log",
      count: 1,
      requester: "owner",
    });
    expect(result.status).toBe("completed");
    expect(result.output?.playerDistance).toBeCloseTo(2.6);
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

  it("tries another protected tree after one target path is blocked", async () => {
    class OneBlockedPathMinecraft extends FakeMinecraft {
      public attemptedTargets: number[] = [];

      public override async moveTo(
        position: ResourceTarget["position"],
        range: number,
        signal: AbortSignal,
      ): Promise<void> {
        if (position.x === 5) {
          this.attemptedTargets.push(position.x);
          throw new AppError({
            category: "path",
            code: "PATH_BLOCKED",
            message: "First tree unreachable",
            retryable: false,
          });
        }
        await super.moveTo(position, range, signal);
      }
    }
    const minecraft = new OneBlockedPathMinecraft();
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
        maxSearchDistance: 32,
        searchStep: 16,
        moveRange: 3,
        returnRange: 3,
        maxPathAttempts: 1,
      },
    );

    const result = await skill.run({
      resource: "oak_log",
      count: 1,
      requester: "owner",
    });
    expect(result.status).toBe("completed");
    expect(minecraft.attemptedTargets).toEqual([5]);
    expect(minecraft.actions).toContain("move:6,64,0");
    expect(result.output?.collectedCount).toBe(1);
  });

  it("reports exhausted paths without mining when every protected target is unreachable", async () => {
    class BlockedTreeMinecraft extends FakeMinecraft {
      public override async moveTo(
        position: ResourceTarget["position"],
        range: number,
        signal: AbortSignal,
      ): Promise<void> {
        if (position.x === 5) {
          throw new AppError({
            category: "path",
            code: "PATH_BLOCKED",
            message: "Tree unreachable",
            retryable: false,
          });
        }
        await super.moveTo(position, range, signal);
      }
    }
    const minecraft = new BlockedTreeMinecraft();
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
        localSearchDistance: 16,
        maxSearchDistance: 16,
        searchStep: 16,
        moveRange: 3,
        returnRange: 3,
        maxPathAttempts: 1,
      },
    );

    const result = await skill.run({
      resource: "oak_log",
      count: 1,
      requester: "owner",
    });
    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({
      code: "RESOURCE_PATHS_BLOCKED",
      confirmedState: { blockedTargets: 1 },
    });
    expect(minecraft.actions.some((action) => action.startsWith("dig:"))).toBe(
      false,
    );
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

describe("gather protection cleanup", () => {
  it("releases the action lease when the requester disappears during precheck", async () => {
    const minecraft = new FakeMinecraft(createSnapshot({ players: [] }));
    const arbiter = new ActionArbiter();
    const skill = new GatherLogsSkill(
      minecraft,
      new TaskRuntime(new InMemoryTaskStore(), () =>
        minecraft.stopCurrentAction(),
      ),
      arbiter,
      {
        maxCount: 64,
        localSearchDistance: 16,
        maxSearchDistance: 16,
        searchStep: 16,
        moveRange: 3,
        returnRange: 3,
        maxPathAttempts: 1,
      },
    );
    const result = await skill.run({
      resource: "oak_log",
      count: 1,
      requester: "owner",
    });
    expect(result.status).toBe("failed");
    const lease = arbiter.acquire("subsequent-request", 50);
    expect(lease.signal.aborted).toBe(false);
    lease.release();
    expect(minecraft.actions.some((action) => action.startsWith("dig:"))).toBe(
      false,
    );
  });
});
