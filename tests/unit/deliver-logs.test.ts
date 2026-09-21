import { describe, expect, it } from "vitest";
import {
  DeliverLogsSkill,
  type DeliveryInput,
} from "../../src/skills/deliver-logs.js";
import { GatherLogsSkill } from "../../src/skills/gather-logs/gather-logs-skill.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { FakeMinecraft, createSnapshot } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";
import { distance, type Position } from "../../src/domain/snapshot.js";
import type { DepositResult } from "../../src/minecraft/port.js";
const worldId = "00000000-0000-4000-8000-000000000001";
const input: DeliveryInput = {
  resource: "oak_log",
  count: 2,
  requester: "owner",
  gather: true,
  home: {
    kind: "home",
    worldId,
    dimension: "overworld",
    position: { x: 10, y: 64, z: 0 },
  },
  chest: {
    kind: "chest",
    worldId,
    dimension: "overworld",
    position: { x: 12, y: 64, z: 0 },
    identity: "fixture",
  },
};
function setup(
  minecraft = new FakeMinecraft(
    createSnapshot({
      inventory: [
        { name: "oak_log", count: 2 },
        { name: "stone", count: 3 },
      ],
    }),
  ),
  maxDistance = 128,
) {
  minecraft.storageIdentities.set(
    JSON.stringify(input.chest.position),
    input.chest.identity,
  );
  minecraft.resources.push(
    { name: "oak_log", position: { x: 5, y: 64, z: 0 } },
    { name: "oak_log", position: { x: 6, y: 64, z: 0 } },
  );
  const arbiter = new ActionArbiter(),
    runtime = new TaskRuntime(new InMemoryTaskStore(), () =>
      minecraft.stopCurrentAction(),
    );
  const gather = new GatherLogsSkill(minecraft, runtime, arbiter, {
    maxCount: 64,
    localSearchDistance: 32,
    maxSearchDistance: 64,
    searchStep: 16,
    moveRange: 3,
    returnRange: 3,
    maxPathAttempts: 1,
  });
  return {
    minecraft,
    arbiter,
    runtime,
    skill: new DeliverLogsSkill(
      minecraft,
      runtime,
      arbiter,
      gather,
      maxDistance,
    ),
  };
}
describe("gather, return and storage task", () => {
  it("collects only the requested delta then returns home and stores that quantity", async () => {
    const { minecraft, skill } = setup();
    const result = await skill.run(input, () => undefined);
    expect(result.status).toBe("completed");
    expect(minecraft.chestCounts.get("oak_log")).toBe(2);
    expect(minecraft.snapshot.inventory).toEqual([
      { name: "oak_log", count: 2 },
      { name: "stone", count: 3 },
    ]);
    expect(minecraft.actions).toContain("move:10,64,0");
    expect(minecraft.actions).toContain("move:12,64,0");
  });
  it("reports partial full storage and counts only the remainder on a new request", async () => {
    const { minecraft, skill, arbiter } = setup();
    minecraft.chestCapacity = 1;
    const first = await skill.run({ ...input, gather: false }, () => undefined);
    expect(first.status).toBe("failed");
    expect(first.failure?.confirmedState).toMatchObject({
      deposited: 1,
      remaining: 1,
      heldCount: 1,
    });
    arbiter.acquire("check-release", 50).release();
    minecraft.chestCapacity = 64;
    const second = await skill.run(
      { ...input, gather: false, count: 1 },
      () => undefined,
    );
    expect(second.status).toBe("completed");
    expect(second.output?.deposited).toBe(1);
    expect(minecraft.chestCounts.get("oak_log")).toBe(2);
  });
  it("reaches inside the measured boundary despite block-based pathfinder rounding", async () => {
    class RoundedArrival extends FakeMinecraft {
      override async moveTo(
        position: DeliveryInput["home"]["position"],
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
    const { skill } = setup(
      new RoundedArrival(
        createSnapshot({ inventory: [{ name: "oak_log", count: 2 }] }),
      ),
    );
    const result = await skill.run(
      { ...input, gather: false },
      () => undefined,
    );
    expect(result.status).toBe("completed");
    expect(result.output?.homeDistance).toBeCloseTo(1.6);
  });
  it("rejects an unavailable chest before gathering", async () => {
    const { minecraft, skill, arbiter } = setup();
    minecraft.storageIdentities.clear();
    const result = await skill.run(input, () => undefined);
    expect(result.failure?.code).toBe("STORAGE_TARGET_CHANGED");
    expect(minecraft.actions.some((a) => a.startsWith("dig:"))).toBe(false);
    arbiter.acquire("next", 50).release();
  });
  it("rechecks the chest after returning home", async () => {
    class ChangingWorld extends FakeMinecraft {
      override async moveTo(
        position: DeliveryInput["home"]["position"],
        range: number,
        signal: AbortSignal,
      ) {
        await super.moveTo(position, range, signal);
        this.storageIdentities.clear();
      }
    }
    const { minecraft, skill } = setup(
      new ChangingWorld(
        createSnapshot({ inventory: [{ name: "oak_log", count: 2 }] }),
      ),
    );
    const result = await skill.run(
      { ...input, gather: false },
      () => undefined,
    );
    expect(result.failure?.code).toBe("STORAGE_TARGET_CHANGED");
    expect(minecraft.chestCounts.size).toBe(0);
  });
  it("refuses a different world without moving", async () => {
    const { minecraft, skill } = setup();
    const result = await skill.run(
      {
        ...input,
        home: {
          ...input.home,
          worldId: "00000000-0000-4000-8000-000000000002",
        },
      },
      () => undefined,
    );
    expect(result.failure?.code).toBe("DELIVERY_WORLD_CHANGED");
    expect(minecraft.actions.some((a) => a.startsWith("move:"))).toBe(false);
  });
  it("retains partial reconciliation separately from the cancelled task and releases control", async () => {
    const { minecraft, skill, runtime, arbiter } = setup();
    const deposit = minecraft.depositLogs.bind(minecraft);
    minecraft.depositLogs = async (target, resource, _count, signal) => {
      const result = await deposit(target, resource, 1, signal);
      await runtime.cancel("fixture stop");
      return { ...result, requested: 2, remaining: 1, reason: "cancelled" };
    };
    let receipt: DepositResult | undefined;
    const result = await skill.run({ ...input, gather: false }, (value) => {
      receipt = value;
    });
    expect(result.status).toBe("cancelled");
    expect(receipt).toMatchObject({ deposited: 1, remaining: 1 });
    arbiter.acquire("next", 50).release();
  });
  it("rejects an excessive return leg before harvesting", async () => {
    const { minecraft, skill } = setup();
    const result = await skill.run(
      { ...input, home: { ...input.home, position: { x: 200, y: 64, z: 0 } } },
      () => undefined,
    );
    expect(result.failure?.code).toBe("DELIVERY_DISTANCE_EXCEEDED");
    expect(minecraft.actions.some((a) => a.startsWith("dig:"))).toBe(false);
  });
  it.each([-120, -110])(
    "does not harvest at %s when return or drop collection would exceed the limit",
    async (x) => {
      const { minecraft, skill } = setup();
      minecraft.resources.splice(0, minecraft.resources.length, {
        name: "oak_log",
        position: { x, y: 64, z: 0 },
      });
      const result = await skill.run({ ...input, count: 1 }, () => undefined);
      expect(result.status).toBe("failed");
      expect(minecraft.actions.some((a) => a.startsWith("dig:"))).toBe(false);
      expect(minecraft.actions).not.toContain(`move:${x},64,0`);
      expect(
        minecraft.snapshot.inventory.find((i) => i.name === "oak_log")?.count,
      ).toBe(2);
    },
  );
  it.each([false, true])(
    "approaches a distant unloaded chest before requiring identity (gather=%s)",
    async (gather) => {
      class NearbyInspection extends FakeMinecraft {
        override async storageIdentity(
          position: Position | null,
          register: boolean,
          signal: AbortSignal,
        ) {
          const proof = await super.storageIdentity(position, register, signal);
          // Simulate a remote/unloaded target becoming inspectable only after approaching it.
          return {
            ...proof,
            identity:
              position && distance(this.snapshot.position, position) > 3
                ? null
                : proof.identity,
          };
        }
      }
      const { minecraft, skill } = setup(
        new NearbyInspection(
          createSnapshot({ inventory: [{ name: "oak_log", count: 2 }] }),
        ),
        512,
      );
      const farInput = {
        ...input,
        gather,
        home: { ...input.home, position: { x: 200, y: 64, z: 0 } },
        chest: { ...input.chest, position: { x: 220, y: 64, z: 0 } },
      };
      minecraft.storageIdentities.set(
        JSON.stringify(farInput.chest.position),
        farInput.chest.identity,
      );
      minecraft.resources.splice(
        0,
        minecraft.resources.length,
        { name: "oak_log", position: { x: 221, y: 64, z: 0 } },
        { name: "oak_log", position: { x: 222, y: 64, z: 0 } },
      );
      const result = await skill.run(farInput, () => undefined);
      expect(result.status).toBe("completed");
      expect(minecraft.chestCounts.get("oak_log")).toBe(2);
      if (gather)
        expect(minecraft.actions.indexOf("move:220,64,0")).toBeLessThan(
          minecraft.actions.indexOf("dig:oak_log"),
        );
    },
  );
  it("walks a long return in loaded-distance segments", async () => {
    class LimitedView extends FakeMinecraft {
      override async moveTo(
        position: Position,
        range: number,
        signal: AbortSignal,
      ) {
        if (distance(this.snapshot.position, position) > 33)
          throw new Error("target outside loaded view");
        await super.moveTo(position, range, signal);
      }
    }
    const { minecraft, skill } = setup(
      new LimitedView(
        createSnapshot({
          position: { x: 210, y: 64, z: 0 },
          inventory: [{ name: "oak_log", count: 2 }],
        }),
      ),
      256,
    );
    const result = await skill.run(
      { ...input, gather: false },
      () => undefined,
    );
    expect(result.status).toBe("completed");
    expect(
      minecraft.actions.filter((a) => a.startsWith("move:")).length,
    ).toBeGreaterThan(2);
    expect(minecraft.chestCounts.get("oak_log")).toBe(2);
  });
});
