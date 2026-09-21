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
    skill: new DeliverLogsSkill(minecraft, runtime, arbiter, gather, 128),
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
  it("rejects a replaced chest before gathering or moving", async () => {
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
});
