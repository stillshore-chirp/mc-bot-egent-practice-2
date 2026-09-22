import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompanionGameController } from "../../src/app/game-controller.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { FollowPlayerSkill } from "../../src/skills/follow-player.js";
import { GatherLogsSkill } from "../../src/skills/gather-logs/gather-logs-skill.js";
import { MoveToSkill } from "../../src/skills/move-to.js";
import { ReturnToPlayerSkill } from "../../src/skills/return-to-player.js";
import { MemoryStore } from "../../src/memory/store.js";
import { createSnapshot, FakeMinecraft } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";
import {
  craftRunsForOutput,
  furnaceBatchReadiness,
  selectBalancedActionCandidates,
  type GeneralActionCandidate,
} from "../../src/minecraft/general-actions.js";

function controller(minecraft: FakeMinecraft) {
  const directory = mkdtempSync(join(tmpdir(), "mc-general-actions-"));
  const memory = MemoryStore.open(join(directory, "memory.sqlite"));
  const tasks = new TaskRuntime(new InMemoryTaskStore(), () =>
    minecraft.stopCurrentAction(),
  );
  const arbiter = new ActionArbiter();
  const game = new CompanionGameController({
    minecraft,
    tasks,
    arbiter,
    followPlayer: new FollowPlayerSkill(minecraft, tasks, arbiter),
    moveTo: new MoveToSkill(minecraft, tasks, arbiter),
    gatherLogs: new GatherLogsSkill(minecraft, tasks, arbiter, {
      maxCount: 16,
      localSearchDistance: 16,
      maxSearchDistance: 32,
      searchStep: 16,
      moveRange: 3,
      returnRange: 3,
      maxPathAttempts: 2,
    }),
    returnToPlayer: new ReturnToPlayerSkill(minecraft, tasks, arbiter),
    ownerUsername: "owner",
    taskTimeoutMs: 2_000,
    retryLimit: 1,
    maxMoveDistance: 128,
    logger: pino({ level: "silent" }),
    memory,
  });
  return {
    game,
    close: () => {
      memory.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("general safe actions", () => {
  it("reserves bounded observation slots across action classes", () => {
    const candidate = (
      action: GeneralActionCandidate["action"],
      purposeFit: GeneralActionCandidate["purposeFit"],
      order: number,
    ): GeneralActionCandidate => ({
      id: `${action}:${order}`,
      label: action,
      action,
      args: {},
      steps: [],
      observed: true,
      purposeFit,
      permission: "allowed",
      safety: "allowed",
      reversible: false,
      impact: "low",
      distance: 1,
      order,
    });
    const selected = selectBalancedActionCandidates(
      [
        candidate("mine_block", "unknown", 0),
        candidate("mine_block", "unknown", 1),
        candidate("mine_block", "unknown", 2),
        candidate("craft_item", "direct", 3),
        candidate("place_block", "unknown", 4),
        candidate("smelt_item", "direct", 5),
      ],
      3,
    );
    expect(selected.map(({ action }) => action)).toEqual([
      "craft_item",
      "smelt_item",
      "mine_block",
    ]);
    expect(selected.map(({ order }) => order)).toEqual([0, 1, 2]);
  });

  it("derives craft runs from the recipe output count", () => {
    expect(craftRunsForOutput(4, 4)).toBe(1);
    expect(craftRunsForOutput(5, 4)).toBe(2);
    expect(craftRunsForOutput(1, undefined)).toBeUndefined();
  });

  it("requires a fully observed empty furnace before starting a batch", () => {
    expect(
      furnaceBatchReadiness({
        input: { known: true },
        fuel: { known: true },
        output: { known: true },
      }),
    ).toEqual({ allowed: true });
    expect(
      furnaceBatchReadiness({
        input: { known: true },
        fuel: { known: true },
        output: { known: true, itemName: "iron_ingot", count: 1 },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "occupied",
      slot: "output",
    });
    expect(
      furnaceBatchReadiness({
        input: { known: false },
        fuel: { known: true },
        output: { known: true },
      }),
    ).toMatchObject({ allowed: false, reason: "unknown", slot: "input" });
  });

  it("returns observed candidates and preserves a denied server decision", async () => {
    const minecraft = new FakeMinecraft();
    const resource = { name: "iron_ore", position: { x: 2, y: 63, z: 0 } };
    minecraft.resources.push(resource);
    minecraft.actionGuardDecisions.set("iron_ore:2:63:0", "denied");
    const { game, close } = controller(minecraft);
    const candidates = await game.observeActionCandidates(
      { radius: 8, requestedItems: ["iron_ore"], maxCandidates: 8 },
      new AbortController().signal,
    );
    expect(candidates[0]).toMatchObject({
      action: "mine_block",
      purposeFit: "direct",
      goalItem: "raw_iron",
      permission: "denied",
      safety: "blocked",
      steps: [{ tool: "mine_block" }],
    });
    close();
  });

  it("keeps a known smelting output as the goal and raw ore as an intermediate", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "iron_ore",
      position: { x: 2, y: 63, z: 0 },
    });
    const { game, close } = controller(minecraft);
    const candidates = await game.observeActionCandidates(
      { radius: 8, requestedItems: ["iron_ingot"], maxCandidates: 8 },
      new AbortController().signal,
    );
    expect(candidates[0]).toMatchObject({
      action: "mine_block",
      goalItem: "iron_ingot",
      intermediateItems: ["raw_iron"],
    });
    close();
  });

  it("collects ancient debris before treating netherite scrap as a smelting goal", async () => {
    const minecraft = new FakeMinecraft();
    const resource = {
      name: "ancient_debris",
      position: { x: 2, y: 63, z: 0 },
    };
    minecraft.resources.push(resource);
    const { game, close } = controller(minecraft);
    try {
      const candidates = await game.observeActionCandidates(
        { radius: 8, requestedItems: ["netherite_scrap"], maxCandidates: 8 },
        new AbortController().signal,
      );
      expect(candidates[0]).toMatchObject({
        action: "mine_block",
        goalItem: "netherite_scrap",
        intermediateItems: ["ancient_debris"],
      });

      const report = await game.mineBlock(
        resource,
        new AbortController().signal,
      );
      expect(report).toMatchObject({
        outcome: "completed",
        confirmedState: { item: "ancient_debris", collectedCount: 1 },
      });
      expect(minecraft.actions).toContain("collect:ancient_debris");
    } finally {
      close();
    }
  });

  it("rechecks the server guard and verifies a natural block inventory delta", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "iron_ore",
      position: { x: 2, y: 63, z: 0 },
    });
    const { game, close } = controller(minecraft);
    const report = await game.mineBlock(
      { name: "iron_ore", position: { x: 2, y: 63, z: 0 } },
      new AbortController().signal,
    );
    expect(report).toMatchObject({
      outcome: "completed",
      confirmedState: {
        block: "iron_ore",
        item: "raw_iron",
        collectedCount: 1,
      },
    });
    expect(minecraft.actions).toEqual([
      "move:2,63,0",
      "dig:iron_ore",
      "collect:raw_iron",
    ]);
    close();
  });

  it("stops a protected mutation before changing the fake world", async () => {
    const minecraft = new FakeMinecraft();
    const resource = { name: "stone", position: { x: 2, y: 63, z: 0 } };
    minecraft.resources.push(resource);
    minecraft.actionGuardDecisions.set("stone:2:63:0", "denied");
    const { game, close } = controller(minecraft);
    const report = await game.mineBlock(resource, new AbortController().signal);
    expect(report.outcome).toBe("failed");
    expect(report.failureCode).toBe("ACTION_DENIED");
    expect(minecraft.resources).toEqual([resource]);
    close();
  });

  it("confirms the authoritative drop for ordinary stone", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "stone",
      position: { x: 2, y: 63, z: 0 },
    });
    const { game, close } = controller(minecraft);
    const report = await game.mineBlock(
      { name: "stone", position: { x: 2, y: 63, z: 0 } },
      new AbortController().signal,
    );
    expect(report).toMatchObject({
      outcome: "completed",
      confirmedState: {
        block: "stone",
        item: "cobblestone",
        collectedCount: 1,
      },
    });
    close();
  });

  it("refuses to mine a block whose drop is not verified", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "grass_block",
      position: { x: 2, y: 63, z: 0 },
    });
    const { game, close } = controller(minecraft);
    await expect(
      game.observeActionCandidates(
        { radius: 8, requestedItems: ["grass_block"], maxCandidates: 8 },
        new AbortController().signal,
      ),
    ).resolves.toEqual([]);
    await expect(
      game.mineBlock(
        { name: "grass_block", position: { x: 2, y: 63, z: 0 } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ detail: { code: "UNSUPPORTED_BLOCK_DROP" } });
    expect(minecraft.actions).toEqual([]);
    close();
  });

  it("verifies craft, place, and smelt outputs through observed state", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.snapshot = {
      ...minecraft.snapshot,
      inventory: [
        { name: "raw_iron", count: 2 },
        { name: "cobblestone", count: 1 },
      ],
    };
    const { game, close } = controller(minecraft);
    const crafted = await game.craftItem(
      { name: "iron_pickaxe", count: 1 },
      new AbortController().signal,
    );
    const placed = await game.placeBlock(
      { name: "cobblestone", position: { x: 1, y: 64, z: 0 } },
      new AbortController().signal,
    );
    const smelted = await game.smeltItem(
      { input: "raw_iron", output: "iron_ingot", count: 2, furnace: null },
      new AbortController().signal,
    );
    expect(crafted.outcome).toBe("completed");
    expect(placed.outcome).toBe("completed");
    expect(smelted).toMatchObject({
      outcome: "completed",
      confirmedState: { output: "iron_ingot", smeltedCount: 2 },
    });
    close();
  });

  it("rejects a furnace outside the controller action range", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({ inventory: [{ name: "raw_iron", count: 1 }] }),
    );
    const { game, close } = controller(minecraft);
    await expect(
      game.smeltItem(
        {
          input: "raw_iron",
          output: "iron_ingot",
          count: 1,
          furnace: { x: 129, y: 64, z: 0 },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      detail: { code: "SMELT_DISTANCE_EXCEEDED" },
    });
    close();
  });
});
