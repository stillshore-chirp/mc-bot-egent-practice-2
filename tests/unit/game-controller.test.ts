import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CompanionGameController } from "../../src/app/game-controller.js";
import { AppError } from "../../src/domain/errors.js";
import { MemoryStore } from "../../src/memory/store.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime, type TaskStore } from "../../src/runtime/task-service.js";
import { FollowPlayerSkill } from "../../src/skills/follow-player.js";
import { GatherLogsSkill } from "../../src/skills/gather-logs/gather-logs-skill.js";
import { MoveToSkill } from "../../src/skills/move-to.js";
import { ReturnToPlayerSkill } from "../../src/skills/return-to-player.js";
import type { ToolContext } from "../../src/tools/contracts.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { FakeMinecraft, createSnapshot } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";

function createController(
  minecraft: FakeMinecraft,
  withPlayer = false,
  taskStore: TaskStore = new InMemoryTaskStore(),
  hungerThreshold = 14,
) {
  const directory = mkdtempSync(join(tmpdir(), "mc-game-controller-"));
  const memory = MemoryStore.open(join(directory, "memory.sqlite"));
  const playerId = withPlayer
    ? memory.getOrCreatePlayer("owner").id
    : undefined;
  const tasks = new TaskRuntime(taskStore, () => minecraft.stopCurrentAction());
  const arbiter = new ActionArbiter();
  return {
    tasks,
    game: new CompanionGameController({
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
      ...(playerId === undefined ? {} : { playerId }),
      taskTimeoutMs: 2_000,
      hungerThreshold,
      retryLimit: 1,
      logger: pino({ level: "silent" }),
      memory,
    }),
    memory,
    close: () => {
      memory.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("CompanionGameController", () => {
  it("reports the observed distance and health after a bounded descent", async () => {
    class DescendingMinecraft extends FakeMinecraft {
      public override async moveToWithSafeDescent(
        position: { x: number; y: number; z: number },
        range: number,
        signal: AbortSignal,
      ) {
        await this.moveTo(position, range, signal);
        return {
          usedDescent: true,
          predictedMaxDamage: 2,
          healthBefore: 20,
          minimumObservedHealth: 18,
          healthAfter: 20,
        };
      }
    }
    const minecraft = new DescendingMinecraft(
      createSnapshot({
        position: { x: 0, y: 68, z: 0 },
        players: [
          { username: "owner", position: { x: 1, y: 64, z: 0 }, distance: 4.1 },
        ],
      }),
    );
    const { game, close } = createController(minecraft);
    try {
      const report = await game.returnToOwner(3, new AbortController().signal);
      expect(report.outcome).toBe("completed");
      expect(report.confirmedState).toMatchObject({
        usedDescent: true,
        healthBefore: 20,
        minimumObservedHealth: 18,
        healthAfter: 20,
      });
      expect(report.summary).toContain("降下中に最低18、帰還時20");
      expect(report.summary).toContain("距離0.0");
    } finally {
      close();
    }
  });

  it("explains a refused high-place return without exposing an internal error name", async () => {
    class UnsafeLandingMinecraft extends FakeMinecraft {
      public override async moveToWithSafeDescent(
        _position: { x: number; y: number; z: number },
        _range: number,
        _signal: AbortSignal,
      ): Promise<never> {
        throw new AppError({
          category: "safety",
          code: "SAFE_DESCENT_BLOCKED",
          message: "Unsafe landing",
          retryable: false,
          confirmedState: { reason: "landing_unsafe" },
        });
      }
    }
    const minecraft = new UnsafeLandingMinecraft(
      createSnapshot({
        position: { x: 0, y: 68, z: 0 },
        players: [
          { username: "owner", position: { x: 1, y: 64, z: 0 }, distance: 4.1 },
        ],
      }),
    );
    const { game, close } = createController(minecraft);
    try {
      const report = await game.returnToOwner(3, new AbortController().signal);
      expect(report.outcome).toBe("failed");
      expect(report.summary).toContain("足場または通り道");
      expect(report.summary).toContain("安全な通路や着地点");
      expect(report.summary).not.toContain("SAFE_DESCENT_BLOCKED");
      expect(report.nextActions?.[0]).toContain("安全な通路や着地点");
    } finally {
      close();
    }
  });

  const hostile = (id: number, distance: number) => ({
    id,
    name: "zombie",
    kind: "mob",
    position: { x: distance, y: 64, z: 0 },
    distance,
    hostile: true,
  });

  it("retreats when the observed threat is distant and the Bot is unarmed", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({ nearbyEntities: [hostile(1, 21), hostile(2, 23)] }),
    );
    const { game, close } = createController(minecraft);
    try {
      const report = await game.respondToHostiles(
        "eliminate",
        new AbortController().signal,
      );
      expect(minecraft.actions).toContain("retreat:hostile");
      expect(
        minecraft.actions.some((action) => action.startsWith("attack:")),
      ).toBe(false);
      expect(report.outcome).toBe("failed");
      expect(report.failureCode).toBe("HOSTILE_ELIMINATION_NOT_CONFIRMED");
      expect(report.summary).toContain("移動して距離を取りました");
      expect(report.summary).toContain("撃破は未確認");
    } finally {
      close();
    }
  });

  it("equips carried armor at a safe distance before choosing retreat", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({
        nearbyEntities: [hostile(1, 21), hostile(2, 23)],
        inventory: [
          { name: "iron_helmet", count: 1 },
          { name: "iron_chestplate", count: 1 },
        ],
      }),
    );
    const { game, close } = createController(minecraft);
    try {
      const report = await game.respondToHostiles(
        "eliminate",
        new AbortController().signal,
      );
      expect(minecraft.actions).toEqual(
        expect.arrayContaining([
          "equip:head:iron_helmet",
          "equip:torso:iron_chestplate",
          "retreat:hostile",
        ]),
      );
      expect(minecraft.snapshot.armor).toMatchObject({
        head: "iron_helmet",
        torso: "iron_chestplate",
      });
      expect(report.summary).toContain("防具を2箇所装着");
      expect(report.summary).toContain("撃破は未確認");
    } finally {
      close();
    }
  });

  it("retreats before equipping when a hostile is too close", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({
        nearbyEntities: [hostile(1, 2)],
        inventory: [{ name: "iron_helmet", count: 1 }],
      }),
    );
    const { game, close } = createController(minecraft);
    try {
      await game.respondToHostiles("evade", new AbortController().signal);
      expect(minecraft.actions.indexOf("retreat:hostile")).toBeLessThan(
        minecraft.actions.indexOf("equip:head:iron_helmet"),
      );
    } finally {
      close();
    }
  });

  it("attacks one adjacent hostile with a weapon and verifies death", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({
        nearbyEntities: [hostile(7, 2)],
        inventory: [{ name: "iron_sword", count: 1 }],
      }),
    );
    const { game, close } = createController(minecraft);
    try {
      const report = await game.respondToHostiles(
        "eliminate",
        new AbortController().signal,
      );
      expect(minecraft.actions).toContain("attack:7");
      expect(minecraft.actions).not.toContain("retreat:hostile");
      expect(report.outcome).toBe("completed");
      expect(report.summary).toContain("死亡を確認");
    } finally {
      close();
    }
  });

  it("accepts the death event while the dead mob remains briefly visible", async () => {
    class LingeringDeadMob extends FakeMinecraft {
      public override async attackHostile(
        entityId: number,
        signal: AbortSignal,
      ): Promise<boolean> {
        signal.throwIfAborted();
        this.actions.push(`attack:${entityId}`);
        return true;
      }
    }
    const minecraft = new LingeringDeadMob(
      createSnapshot({
        nearbyEntities: [hostile(7, 2)],
        inventory: [{ name: "iron_sword", count: 1 }],
      }),
    );
    const { game, close } = createController(minecraft);
    try {
      const report = await game.respondToHostiles(
        "eliminate",
        new AbortController().signal,
      );
      expect(report.outcome).toBe("completed");
      expect(report.summary).toContain("死亡を確認");
    } finally {
      close();
    }
  });

  it("retreats after an inconclusive attack and never claims a kill", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({
        nearbyEntities: [hostile(7, 2)],
        inventory: [{ name: "iron_sword", count: 1 }],
      }),
    );
    minecraft.attackSucceeds = false;
    const { game, close } = createController(minecraft);
    try {
      const report = await game.respondToHostiles(
        "eliminate",
        new AbortController().signal,
      );
      expect(minecraft.actions).toEqual(
        expect.arrayContaining(["attack:7", "retreat:hostile"]),
      );
      expect(report.summary).toContain("撃破は未確認");
    } finally {
      close();
    }
  });

  it("takes no action without an observed hostile target", async () => {
    const minecraft = new FakeMinecraft();
    const { game, close } = createController(minecraft);
    try {
      const report = await game.respondToHostiles(
        "eliminate",
        new AbortController().signal,
      );
      expect(report.failureCode).toBe("HOSTILE_TARGET_NOT_OBSERVED");
      expect(minecraft.actions).toEqual([]);
    } finally {
      close();
    }
  });

  it("tries stuck recovery and another safe route after pathfinding fails", async () => {
    class ObstructedMinecraft extends FakeMinecraft {
      private firstRoute = true;

      public override async retreatFromHostiles(
        signal: AbortSignal,
      ): Promise<void> {
        if (this.firstRoute) {
          this.firstRoute = false;
          throw new AppError({
            category: "path",
            code: "PATHFINDER_FAILED",
            message: "route blocked",
            retryable: true,
          });
        }
        await super.retreatFromHostiles(signal);
      }
    }
    const minecraft = new ObstructedMinecraft(
      createSnapshot({ nearbyEntities: [hostile(1, 21), hostile(2, 23)] }),
    );
    const { game, close } = createController(minecraft);
    try {
      const report = await game.respondToHostiles(
        "evade",
        new AbortController().signal,
      );
      expect(minecraft.actions).toEqual(
        expect.arrayContaining(["recover:stuck", "retreat:hostile"]),
      );
      expect(report.outcome).toBe("completed");
    } finally {
      close();
    }
  });

  it("attributes vitals to the Bot and keeps requester vitals unobserved", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({ oxygen: 5, inWater: true }),
    );
    const { game, close } = createController(minecraft);

    const status = await game.observeStatus();
    const surroundings = await game.observeSurroundings(8, false);

    expect(status).toMatchObject({
      subject: "bot",
      source: "minecraft",
      requesterVitals: "unobserved",
      oxygen: 5,
      oxygenState: "low",
      inWater: true,
    });
    expect(surroundings).toMatchObject({
      subject: "bot",
      source: "minecraft",
      requesterVitals: "unobserved",
      oxygen: 5,
      oxygenState: "low",
      inWater: true,
    });
    expect(status.observedAt).toBeTruthy();
    expect(surroundings.observedAt).toBeTruthy();
    close();
  });

  it("maps observed movement into a verified action report", async () => {
    const minecraft = new FakeMinecraft();
    const { game, close } = createController(minecraft);

    const report = await game.moveTo(
      { x: 4, y: 64, z: 3 },
      1,
      new AbortController().signal,
    );

    expect(report).toMatchObject({
      outcome: "completed",
      after: { position: { x: 4, y: 64, z: 3, dimension: "overworld" } },
    });
    expect(report.summary).toContain("到達を観測");
    close();
  });

  it("stops a running follow task without waiting for the LLM", async () => {
    const minecraft = new FakeMinecraft();
    const { game, tasks, close } = createController(minecraft);
    const follow = game.followOwner(3, 60, new AbortController().signal);
    await waitUntil(() => minecraft.actions.includes("follow:owner"));

    const stop = await game.stopCurrentAction("owner requested stop");
    const followResult = await follow;

    expect(stop.outcome).toBe("completed");
    expect(stop.summary).toBe("進行中のMinecraft作業を停止しました。");
    expect(followResult.outcome).toBe("cancelled");
    expect(tasks.current?.status).toBe("cancelled");
    expect(minecraft.stopCount).toBeGreaterThan(0);
    close();
  });

  it("explains why a stuck follow stopped and how to give the next instruction", async () => {
    const minecraft = new FakeMinecraft();
    const { game, tasks, close } = createController(minecraft);
    const follow = game.followOwner(3, 60, new AbortController().signal);
    await waitUntil(() => minecraft.actions.includes("follow:owner"));

    await tasks.suspend("reflex:stuck");
    const status = await game.observeStatus();
    const report = await follow;

    expect(status.activeTaskState).toContain("Botの位置が変わらず");
    expect(status.activeTaskSummary).toContain("Botの位置が変わらず");
    expect(status.activeTaskSummary).not.toContain("次の操作:");
    expect(report).toMatchObject({
      outcome: "failed",
      failureCategory: "safety",
      failureCode: "TASK_SUSPENDED_FOR_SAFETY",
      failureRetryable: true,
    });
    expect(report.summary).toContain(
      "通れない地形の詳細はまだ確認できていません",
    );
    expect(report.summary).toContain("「続けて」");
    expect(report.summary).not.toContain("もう一度「こっちおいで」");
    expect(report.nextActions).toEqual([
      "通れる道と周囲の安全を確認する",
      "状況が変わったら「続けて」で再開する",
    ]);
    expect(report.summary).not.toContain("reflex:stuck");
    close();
  });

  it.each([
    {
      reason: "reflex:hazard",
      observed: "直前にBotの周囲で危険を確認",
      currentCheck: "危険が続いているか確認できません",
      nextAction: "Botの周囲の安全を再確認する",
    },
    {
      reason: "reflex:hostile",
      observed: "直前にBotの近くで敵を確認",
      currentCheck: "今回の観測では近くの敵を確認していません",
      nextAction: "敵から距離を取り周囲の安全を確認する",
    },
    {
      reason: "reflex:damage",
      observed: "直前にBotの体力が減ったため",
      currentCheck: "被害の原因を特定できません",
      nextAction: "Botの周囲と被害の原因を確認する",
    },
    {
      reason: "reflex:hunger",
      observed: "直前にBotの空腹を確認し",
      currentCheck: "今回の観測では空腹が解消しています",
      nextAction: "Botの食料と空腹状態を確認する",
    },
  ])(
    "separates a remembered $reason observation from the current state",
    async ({ reason, observed, currentCheck, nextAction }) => {
      const minecraft = new FakeMinecraft();
      const { game, tasks, close } = createController(minecraft);
      const follow = game.followOwner(3, 60, new AbortController().signal);
      await waitUntil(() => minecraft.actions.includes("follow:owner"));

      await tasks.suspend(reason);
      const report = await follow;

      expect(report.summary).toContain(observed);
      expect(report.summary).toContain(currentCheck);
      expect(report.nextActions).toContain(nextAction);
      expect(report.summary).not.toContain("現在の周囲に危険を観測");
      expect(report.summary).not.toContain("近くの危険を確認したため");
      close();
    },
  );

  it("still permits an explicit safety response while a prior task is suspended", async () => {
    const minecraft = new FakeMinecraft();
    const { game, tasks, close } = createController(minecraft);
    const follow = game.followOwner(3, 60, new AbortController().signal);
    await waitUntil(() => minecraft.actions.includes("follow:owner"));
    await tasks.suspend("reflex:hostile");
    await follow;
    minecraft.snapshot = createSnapshot({ nearbyEntities: [hostile(1, 4)] });

    const response = await game.respondToHostiles(
      "evade",
      new AbortController().signal,
    );

    expect(minecraft.actions).toContain("retreat:hostile");
    expect(response.failureCode).not.toBe("SUSPENDED_TASK_UNSAFE_TO_RESUME");
    close();
  });

  it.each([
    {
      danger: "fire",
      snapshot: createSnapshot({
        onFire: true,
        nearbyEntities: [hostile(1, 4)],
      }),
    },
    {
      danger: "oxygen",
      snapshot: createSnapshot({
        inWater: true,
        oxygen: 2,
        oxygenState: "low",
        nearbyEntities: [hostile(1, 4)],
      }),
    },
    {
      danger: "hunger",
      snapshot: createSnapshot({ food: 10, nearbyEntities: [hostile(1, 4)] }),
    },
  ])("does not use hostile retreat to bypass $danger", async ({ snapshot }) => {
    const minecraft = new FakeMinecraft();
    const { game, tasks, close } = createController(minecraft);
    const follow = game.followOwner(3, 60, new AbortController().signal);
    await waitUntil(() => minecraft.actions.includes("follow:owner"));
    await tasks.suspend("reflex:hostile");
    await follow;
    minecraft.snapshot = snapshot;

    const response = await game.respondToHostiles(
      "evade",
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: "failed",
      failureCategory: "safety",
      failureCode: "SUSPENDED_TASK_UNSAFE_TO_RESUME",
    });
    expect(minecraft.actions).not.toContain("retreat:hostile");
    expect(tasks.current?.status).toBe("suspended");
    close();
  });

  it("uses the configured food threshold before replacing a hunger suspension", async () => {
    const minecraft = new FakeMinecraft();
    const { game, tasks, close } = createController(
      minecraft,
      false,
      new InMemoryTaskStore(),
      16,
    );
    const follow = game.followOwner(3, 60, new AbortController().signal);
    await waitUntil(() => minecraft.actions.includes("follow:owner"));
    await tasks.suspend("reflex:hunger");
    await follow;
    minecraft.snapshot = createSnapshot({ food: 15 });

    const retry = await game.followOwner(3, 60, new AbortController().signal);

    expect(retry.failureCode).toBe("SUSPENDED_TASK_UNSAFE_TO_RESUME");
    expect(tasks.current?.status).toBe("suspended");
    expect((await game.observeStatus()).activeTaskSummary).toContain(
      "今も空腹",
    );
    close();
  });

  it("keeps the safety gate after stopping a suspended task until danger clears", async () => {
    const minecraft = new FakeMinecraft();
    const { game, tasks, close } = createController(minecraft);
    try {
      const follow = game.followOwner(3, 60, new AbortController().signal);
      await waitUntil(() => minecraft.actions.includes("follow:owner"));
      await tasks.suspend("reflex:hazard");
      await follow;
      await game.stopCurrentAction("owner requested stop");
      expect(tasks.current?.status).toBe("cancelled");

      minecraft.snapshot = createSnapshot({ onFire: true });
      const blocked = await game.moveTo(
        { x: 5, y: 64, z: 0 },
        1,
        new AbortController().signal,
      );
      expect(blocked.failureCode).toBe("SUSPENDED_TASK_UNSAFE_TO_RESUME");
      expect(minecraft.actions).not.toContain("move:5,64,0");

      minecraft.snapshot = createSnapshot();
      const resumed = await game.moveTo(
        { x: 5, y: 64, z: 0 },
        1,
        new AbortController().signal,
      );
      expect(resumed.outcome).toBe("completed");
      expect(minecraft.actions).toContain("move:5,64,0");
    } finally {
      close();
    }
  });

  it("reports a currently observed threat separately from the reason a task stopped", async () => {
    const minecraft = new FakeMinecraft();
    const { game, tasks, close } = createController(minecraft);
    const follow = game.followOwner(3, 60, new AbortController().signal);
    await waitUntil(() => minecraft.actions.includes("follow:owner"));

    await tasks.suspend("reflex:damage");
    minecraft.snapshot = createSnapshot({ nearbyEntities: [hostile(1, 4)] });
    const status = await game.observeStatus();
    const report = await follow;

    expect(status.activeTaskSummary).toContain("直前にBotの体力が減った");
    expect(status.activeTaskSummary).toContain("今もBotの近くに敵を観測");
    expect(report.summary).toContain("今もBotの近くに敵を観測");
    expect(report.summary).not.toContain(
      "今回の観測だけでは被害の原因を特定できません",
    );
    close();
  });

  it.each([
    { danger: "fire", snapshot: createSnapshot({ onFire: true }) },
    {
      danger: "oxygen",
      snapshot: createSnapshot({
        inWater: true,
        oxygen: 2,
        oxygenState: "low",
      }),
    },
    {
      danger: "hostile",
      snapshot: createSnapshot({ nearbyEntities: [hostile(1, 4)] }),
    },
    { danger: "hunger", snapshot: createSnapshot({ food: 10 }) },
  ])(
    "does not start a replacement action while $danger remains",
    async ({ snapshot }) => {
      const minecraft = new FakeMinecraft();
      const { game, tasks, close } = createController(minecraft);
      const follow = game.followOwner(3, 60, new AbortController().signal);
      await waitUntil(() => minecraft.actions.includes("follow:owner"));
      await tasks.suspend("reflex:stuck");
      await follow;
      minecraft.snapshot = snapshot;
      const actionCount = minecraft.actions.length;

      const retry = await game.followOwner(3, 60, new AbortController().signal);
      const move = await game.moveTo(
        { x: 3, y: 64, z: 0 },
        1,
        new AbortController().signal,
      );

      expect(retry).toMatchObject({
        outcome: "failed",
        failureCategory: "safety",
        failureCode: "SUSPENDED_TASK_UNSAFE_TO_RESUME",
      });
      expect(move).toMatchObject({
        outcome: "failed",
        failureCategory: "safety",
        failureCode: "SUSPENDED_TASK_UNSAFE_TO_RESUME",
      });
      expect(tasks.current?.status).toBe("suspended");
      expect(minecraft.actions).toHaveLength(actionCount);
      expect(retry.summary).not.toContain("SUSPENDED_TASK_UNSAFE_TO_RESUME");
      close();
    },
  );

  it("reports the observed new inventory count after gathering and returning", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push(
      { name: "oak_log", position: { x: 5, y: 64, z: 0 } },
      { name: "oak_log", position: { x: 6, y: 64, z: 0 } },
    );
    const { game, close } = createController(minecraft);

    const report = await game.gatherResource(
      "oak_log",
      2,
      new AbortController().signal,
    );

    expect(report.outcome).toBe("completed");
    expect(report.summary).toContain("新たに2個");
    expect(report.after?.inventory).toMatchObject({ oak_log: 2 });
    close();
  });

  it("explains blocked gathering paths and the verified collected count", async () => {
    class BlockedTreeMinecraft extends FakeMinecraft {
      public override async moveTo(
        position: { x: number; y: number; z: number },
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
    const { game, close } = createController(minecraft);
    try {
      const report = await game.gatherResource(
        "oak_log",
        1,
        new AbortController().signal,
      );
      expect(report).toMatchObject({
        outcome: "failed",
        failureCode: "RESOURCE_PATHS_BLOCKED",
        confirmedState: { collectedCount: 0, heldCount: 0 },
      });
      expect(report.summary).toContain("経路");
      expect(report.summary).toContain("今回の取得は0個");
    } finally {
      close();
    }
  });

  it("returns only server protection-checked resource candidates in distance order", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push(
      { name: "oak_log", position: { x: 6, y: 64, z: 0 } },
      { name: "birch_log", position: { x: 3, y: 64, z: 0 } },
    );
    const { game, close } = createController(minecraft);

    const candidates = await game.findSafeResourceCandidates(
      16,
      8,
      new AbortController().signal,
    );

    expect(candidates).toEqual([
      { resource: "birch_log", distance: 3 },
      { resource: "oak_log", distance: 6 },
    ]);
    close();
  });

  it("turns an observed resource into a reusable safe action plan candidate", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "birch_log",
      position: { x: 3, y: 64, z: 0 },
    });
    const { game, close } = createController(minecraft);

    const candidates = await game.findSafeActionCandidates(
      { goal: "collect_resource", count: 2, maxCandidates: 4 },
      new AbortController().signal,
    );

    expect(candidates).toMatchObject([
      {
        id: "gather_resource:birch_log",
        reversible: false,
        impact: "medium",
        action: "gather_resource",
        operationClass: "natural_resource",
        requestedCount: 2,
        resourceName: "birch_log",
        goalItem: "birch_log",
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "birch_log", count: 2, commitmentId: null },
          },
        ],
      },
    ]);
    close();
  });

  it("approaches a distant observed ore before rechecking server permission", async () => {
    class ReachAwareMinecraft extends FakeMinecraft {
      public override async observeActionCandidates(
        input: Parameters<FakeMinecraft["observeActionCandidates"]>[0],
        signal: AbortSignal,
      ) {
        const candidates = await super.observeActionCandidates(input, signal);
        return candidates.map((candidate) => {
          if (candidate.action !== "mine_block") return candidate;
          const target = candidate.args.position as {
            x: number;
            y: number;
            z: number;
          };
          const observedDistance = Math.hypot(
            target.x - this.snapshot.position.x,
            target.y - this.snapshot.position.y,
            target.z - this.snapshot.position.z,
          );
          return observedDistance > 6
            ? {
                ...candidate,
                distance: observedDistance,
                permission: "unknown" as const,
                safety: "unknown" as const,
              }
            : { ...candidate, distance: observedDistance };
        });
      }
    }
    const minecraft = new ReachAwareMinecraft();
    minecraft.resources.push({
      name: "iron_ore",
      position: { x: 15, y: 64, z: 0 },
    });
    const { game, close } = createController(minecraft);
    const request = {
      goal: "鉄を1個集めて",
      count: 1,
      maxCandidates: 8,
      authorization: {
        kind: "owner_bounded_resource" as const,
        goal: "鉄を1個集めて",
        allowedResources: ["iron_ore"],
        targetItem: "raw_iron",
        targetCount: 1,
        maxCount: 8,
      },
    };
    try {
      const initial = await game.findSafeActionCandidates(
        request,
        new AbortController().signal,
      );
      expect(initial[0]?.permission).toBe("unknown");
      const result = await game.searchSafeActionCandidates(
        request,
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        blockedWaypoints: 0,
        candidates: [{ action: "mine_block", permission: "allowed" }],
      });
      expect(result.attemptedWaypoints).toBeGreaterThan(1);
      expect(
        minecraft.actions.filter((action) => action.startsWith("move:")),
      ).toHaveLength(result.attemptedWaypoints);
      expect(
        minecraft.actions.some((action) => action.startsWith("dig:")),
      ).toBe(false);
    } finally {
      close();
    }
  });

  it("searches a bounded alternate route before selecting a protected log", async () => {
    class RangeAwareMinecraft extends FakeMinecraft {
      public override async findResources(
        names: readonly string[],
        maxDistance: number,
        count: number,
      ) {
        return this.resources
          .filter(
            ({ name, position }) =>
              names.includes(name) &&
              Math.hypot(
                position.x - this.snapshot.position.x,
                position.y - this.snapshot.position.y,
                position.z - this.snapshot.position.z,
              ) <= maxDistance,
          )
          .slice(0, count);
      }

      public override async moveTo(
        position: { x: number; y: number; z: number },
        range: number,
        signal: AbortSignal,
      ): Promise<void> {
        if (position.x > 0) {
          throw new AppError({
            category: "path",
            code: "PATH_BLOCKED",
            message: "Path blocked",
            retryable: false,
          });
        }
        await super.moveTo(position, range, signal);
      }
    }

    const minecraft = new RangeAwareMinecraft();
    minecraft.resources.push({
      name: "birch_log",
      position: { x: 0, y: 64, z: 45 },
    });
    const { game, close } = createController(minecraft);
    try {
      const search = await game.searchSafeResourceCandidates(
        32,
        1,
        new AbortController().signal,
        ["birch_log"],
      );
      expect(search).toMatchObject({
        candidates: [{ resource: "birch_log" }],
        attemptedWaypoints: 2,
        blockedWaypoints: 1,
      });
      expect(minecraft.actions).toContain("move:0,64,16");
      expect(
        minecraft.actions.some((action) => action.startsWith("dig:")),
      ).toBe(false);
    } finally {
      close();
    }
  });

  it("stops resource search before movement when the current state is unsafe", async () => {
    const minecraft = new FakeMinecraft(createSnapshot({ food: 10 }));
    const { game, close } = createController(minecraft);
    try {
      const search = await game.searchSafeResourceCandidates(
        32,
        1,
        new AbortController().signal,
        ["oak_log"],
      );
      expect(search).toMatchObject({
        attemptedWaypoints: 0,
        stop: { code: "SAFE_RESOURCE_SEARCH_UNSAFE" },
      });
      expect(
        minecraft.actions.some((action) => action.startsWith("move:")),
      ).toBe(false);
    } finally {
      close();
    }
  });

  it("normalizes a descriptive log collection goal", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "oak_log",
      position: { x: 3, y: 64, z: 0 },
    });
    const { game, close } = createController(minecraft);

    const candidates = await game.findSafeActionCandidates(
      { goal: "オークの原木を集める", count: 2, maxCandidates: 4 },
      new AbortController().signal,
    );

    expect(candidates).toMatchObject([
      {
        resourceName: "oak_log",
        goalItem: "oak_log",
        requestedCount: 2,
      },
    ]);
    close();
  });

  it("observes log candidates for a natural one-tree cutting request", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "oak_log",
      position: { x: 3, y: 64, z: 0 },
    });
    const { game, close } = createController(minecraft);
    try {
      const candidates = await game.findSafeActionCandidates(
        { goal: "木を一本切って持ってきて", count: 1, maxCandidates: 4 },
        new AbortController().signal,
      );
      expect(candidates).toMatchObject([
        { resourceName: "oak_log", requestedCount: 1 },
      ]);
    } finally {
      close();
    }
  });

  it("finds the authorized log species behind other nearby logs", async () => {
    const minecraft = new FakeMinecraft();
    for (let index = 0; index < 8; index += 1) {
      minecraft.resources.push({
        name: "oak_log",
        position: { x: 1 + index, y: 64, z: 0 },
      });
    }
    minecraft.resources.push({
      name: "spruce_log",
      position: { x: 10, y: 64, z: 0 },
    });
    const { game, close } = createController(minecraft);
    try {
      const candidates = await game.findSafeActionCandidates(
        {
          goal: "トウヒの原木を1本集める",
          count: 1,
          maxCandidates: 8,
          authorization: {
            kind: "owner_bounded_resource",
            goal: "トウヒの原木を1本集めて",
            allowedResources: ["spruce_log"],
            targetItem: "spruce_log",
            targetCount: 1,
            maxCount: 16,
          },
        },
        new AbortController().signal,
      );
      expect(candidates.map((candidate) => candidate.resourceName)).toEqual([
        "spruce_log",
      ]);
    } finally {
      close();
    }
  });

  it.each([
    ["鉄", "iron_ore", "iron_ingot", "raw_iron", 1],
    ["銅", "copper_ore", "copper_ingot", "raw_copper", 1],
    ["複数の鉄", "iron_ore", "iron_ingot", "raw_iron", 6],
  ])(
    "executes one bounded %s goal across mining and smelting from provider observations",
    async (_label, ore, ingot, raw, count) => {
      const minecraft = new FakeMinecraft();
      minecraft.availableFurnace = true;
      minecraft.resources.push(
        ...Array.from({ length: Math.max(2, count) }, (_, index) => ({
          name: ore,
          position: { x: 2 + index, y: 63, z: 0 },
        })),
      );
      const { game, close } = createController(minecraft);
      const authorization = {
        kind: "owner_bounded_resource" as const,
        goal: `${ingot}を${String(count)}個作って`,
        allowedResources: [ore],
        targetItem: ingot,
        targetCount: count,
        maxCount: 8,
      };
      const context: ToolContext = {
        correlationId: "multi-stage-goal",
        requesterUsername: "owner",
        authorizedOwnerUsername: "owner",
        playerId: "owner",
        signal: new AbortController().signal,
        requestKind: "owner_message",
        safeActionAuthorization: authorization,
        allowedActionToolNames: [
          "plan_safe_action",
          "mine_block",
          "smelt_item",
        ],
        safeActionAuthorizationUsage: {
          remainingCount: count,
          consumed: false,
        },
        executionEvidence: { verifiedActionReceipts: [] },
        game,
        memory: {
          rememberPlayerFact: () => ({}),
          rememberLocation: () => ({}),
          recall: () => [],
          setCommitment: () => ({ id: "unused" }),
          getCommitment: () => undefined,
          completeCommitment: () => ({}),
        },
        limits: {
          maxMoveDistance: 128,
          maxGatherCount: 16,
          maxSafeActionDurationMs: 5_000,
          followDistance: 3,
          memoryContextLimit: 10,
        },
      };
      try {
        const result = await new ToolExecutor().execute(
          "plan_safe_action",
          JSON.stringify({
            goal: `${ingot}を作る`,
            count,
            mode: "delegated",
            candidateId: null,
          }),
          context,
        );
        expect(result).toMatchObject({
          success: true,
          data: {
            completedCount: count,
          },
        });
        expect(
          minecraft.actions.filter((action) => action === `dig:${ore}`),
        ).toHaveLength(count);
        expect(minecraft.actions).toContain(`collect:${raw}`);
        expect(minecraft.actions).toContain(
          `smelt:${raw}:${ingot}:${String(count)}`,
        );
        expect((await game.observeStatus()).inventory[ingot]).toBe(count);
      } finally {
        close();
      }
    },
  );

  it("uses the newest persisted task when the runtime has no live task", async () => {
    const minecraft = new FakeMinecraft();
    const { game, memory, close } = createController(minecraft, true);
    const playerId = memory.getOrCreatePlayer("owner").id;
    memory.createTaskRun({
      playerId,
      kind: "follow_player",
      phase: "following",
      status: "completed",
      input: {},
    });

    const status = await game.observeStatus();

    expect(status.activeTaskState).toBeNull();
    expect(status.latestTaskState).toBe("直前のMinecraft作業は完了しました。");
    close();
  });

  it.each([
    { danger: "fire", snapshot: createSnapshot({ onFire: true }) },
    {
      danger: "oxygen",
      snapshot: createSnapshot({
        inWater: true,
        oxygen: 2,
        oxygenState: "low",
      }),
    },
    { danger: "falling", snapshot: createSnapshot({ velocityY: -1.5 }) },
    { danger: "hunger", snapshot: createSnapshot({ food: 10 }) },
  ])(
    "checks a persisted suspension before resuming during $danger",
    async ({ snapshot }) => {
      const minecraft = new FakeMinecraft(snapshot);
      const { game, memory, tasks, close } = createController(minecraft, true);
      const playerId = memory.getOrCreatePlayer("owner").id;
      memory.createTaskRun({
        playerId,
        kind: "follow_player",
        phase: "following",
        status: "suspended",
        input: { range: 3 },
      });

      const retry = await game.followOwner(3, 60, new AbortController().signal);

      expect(tasks.current).toBeUndefined();
      expect(minecraft.actions).not.toContain("follow:owner");
      expect(retry).toMatchObject({
        outcome: "failed",
        failureCategory: "safety",
        failureCode: "SUSPENDED_TASK_UNSAFE_TO_RESUME",
      });
      close();
    },
  );

  it("checks a persisted cancelled suspension before moving after restart", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({ inWater: true, oxygen: 2, oxygenState: "low" }),
    );
    const { game, memory, tasks, close } = createController(minecraft, true);
    try {
      const playerId = memory.getOrCreatePlayer("owner").id;
      const previous = memory.createTaskRun({
        playerId,
        kind: "follow_player",
        phase: "following",
        status: "suspended",
        input: { range: 3 },
      });
      memory.updateTaskRun({
        taskRunId: previous.id,
        status: "cancelled",
        phase: "following",
        checkpoint: { suspendReason: "reflex:hazard" },
      });

      const retry = await game.moveTo(
        { x: 5, y: 64, z: 0 },
        1,
        new AbortController().signal,
      );

      expect(tasks.current).toBeUndefined();
      expect(minecraft.actions).not.toContain("move:5,64,0");
      expect(retry.failureCode).toBe("SUSPENDED_TASK_UNSAFE_TO_RESUME");
    } finally {
      close();
    }
  });

  it.each(["queued", "running", "suspended"] as const)(
    "does not present a persisted %s task as active after restart",
    async (status) => {
      const minecraft = new FakeMinecraft();
      const { game, memory, close } = createController(minecraft, true);
      const playerId = memory.getOrCreatePlayer("owner").id;
      memory.createTaskRun({
        playerId,
        kind: "follow_player",
        phase: "following",
        status,
        input: {},
      });

      const observed = await game.observeStatus();

      expect(observed.activeTaskState).toBeNull();
      expect(observed.activeTaskSummary).toBeNull();
      expect(observed.latestTaskState).toContain(
        "現在その作業が続いていることは確認できません",
      );
      close();
    },
  );

  it("reports a live queued task as waiting until its first save completes", async () => {
    let releaseSave!: () => void;
    let notifySaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      notifySaveStarted = resolve;
    });
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let firstSave = true;
    const taskStore: TaskStore = {
      save: async () => {
        if (firstSave) {
          firstSave = false;
          notifySaveStarted();
          await saveHeld;
        }
      },
    };
    const { game, tasks, close } = createController(
      new FakeMinecraft(),
      false,
      taskStore,
    );
    const task = tasks.run("follow_player", {}, async () => undefined);
    await saveStarted;

    const status = await game.observeStatus();
    expect(status.activeTaskSummary).toBe(
      "Minecraft作業の開始を待っています。",
    );
    expect(status.latestTaskState).toBe("Minecraft作業の開始を待っています。");

    releaseSave();
    await task;
    close();
  });

  it("keeps a safe persisted failure reason for direct status questions", async () => {
    const minecraft = new FakeMinecraft();
    const { game, memory, close } = createController(minecraft, true);
    const playerId = memory.getOrCreatePlayer("owner").id;
    const task = memory.createTaskRun({
      playerId,
      kind: "move_to",
      phase: "moving",
      status: "running",
      input: {},
    });
    memory.updateTaskRun({
      taskRunId: task.id,
      status: "failed",
      phase: "moving",
      failure: {
        category: "path",
        code: "PATH_BLOCKED",
        message: "raw internal failure detail",
        retryable: true,
      },
    });

    const status = await game.observeStatus();

    expect(status.latestTaskState).toContain("経路を確認できませんでした。");
    expect(status.latestTaskState).not.toContain("PATH_BLOCKED");
    expect(status.latestTaskState).not.toContain("raw internal failure detail");
    close();
  });

  it("keeps a persisted timeout distinct from an owner stop", async () => {
    const minecraft = new FakeMinecraft();
    const { game, memory, close } = createController(minecraft, true);
    const playerId = memory.getOrCreatePlayer("owner").id;
    const task = memory.createTaskRun({
      playerId,
      kind: "follow_player",
      phase: "following",
      status: "running",
      input: {},
    });
    memory.updateTaskRun({
      taskRunId: task.id,
      status: "cancelled",
      phase: "following",
      failure: {
        category: "cancelled",
        code: "TASK_TIMEOUT",
        message: "設定された作業時間を超過",
        retryable: false,
      },
    });

    const status = await game.observeStatus();

    expect(status.latestTaskState).toContain(
      "設定時間内に完了しませんでした。",
    );
    expect(status.latestTaskState).not.toContain("停止指示で中断しました");
    close();
  });

  it("reports acquired and held counts when gathering is stopped after pickup", async () => {
    const signal = new AbortController();
    class StopAfterPickup extends FakeMinecraft {
      override async collectDropsNear(
        ...args: Parameters<FakeMinecraft["collectDropsNear"]>
      ) {
        await super.collectDropsNear(...args);
        signal.abort(new Error("fixture stop"));
      }
    }
    const minecraft = new StopAfterPickup();
    minecraft.resources.push({
      name: "oak_log",
      position: { x: 5, y: 64, z: 0 },
    });
    const { game, close } = createController(minecraft);
    const report = await game.gatherResource("oak_log", 2, signal.signal);
    expect(report.outcome).toBe("cancelled");
    expect(report.confirmedState).toMatchObject({
      collectedCount: 1,
      heldCount: 1,
    });
    expect(report.summary).toContain("今回の取得は1個");
    close();
  });

  it("splits long Unicode responses within the Minecraft chat limit", async () => {
    const minecraft = new FakeMinecraft();
    const { game, close } = createController(minecraft);

    await game.say("🙂".repeat(121));

    const messages = minecraft.actions
      .filter((action) => action.startsWith("say:"))
      .map((action) => action.slice(4));
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.length <= 240)).toBe(true);
    expect(messages.join("")).toBe("🙂".repeat(121));
    close();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

describe("delivery user reports", () => {
  it("asks for missing registrations and reports verified partial quantities", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.snapshot = {
      ...minecraft.snapshot,
      inventory: [{ name: "oak_log", count: 2 }],
    };
    const { game, close } = createController(minecraft);
    const signal = new AbortController().signal;
    try {
      await expect(
        game.delivery.deliver("oak_log", 2, false, signal),
      ).rejects.toMatchObject({
        detail: { code: "DELIVERY_TARGET_NOT_REGISTERED" },
      });
      await game.delivery.register("home", null, signal);
      const position = { x: 2, y: 64, z: 0 };
      minecraft.storageIdentities.set(JSON.stringify(position), "fixture");
      await game.delivery.register("chest", position, signal);
      minecraft.chestCapacity = 1;
      const report = await game.delivery.deliver("oak_log", 2, false, signal);
      expect(report.outcome).toBe("failed");
      expect(report.summary).toContain("収納数は1個");
      expect(report.summary).toContain("未収納は1個");
      expect(report.summary).toContain("残り所持数は1個");
    } finally {
      close();
    }
  });
});
