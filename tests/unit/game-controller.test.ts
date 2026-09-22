import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CompanionGameController } from "../../src/app/game-controller.js";
import { MemoryStore } from "../../src/memory/store.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { FollowPlayerSkill } from "../../src/skills/follow-player.js";
import { GatherLogsSkill } from "../../src/skills/gather-logs/gather-logs-skill.js";
import { MoveToSkill } from "../../src/skills/move-to.js";
import { ReturnToPlayerSkill } from "../../src/skills/return-to-player.js";
import { FakeMinecraft } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";

function createController(minecraft: FakeMinecraft) {
  const directory = mkdtempSync(join(tmpdir(), "mc-game-controller-"));
  const memory = MemoryStore.open(join(directory, "memory.sqlite"));
  const tasks = new TaskRuntime(new InMemoryTaskStore(), () =>
    minecraft.stopCurrentAction(),
  );
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
      taskTimeoutMs: 2_000,
      retryLimit: 1,
      logger: pino({ level: "silent" }),
      memory,
    }),
    close: () => {
      memory.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("CompanionGameController", () => {
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

    expect(status.activeTaskState).toContain("移動が進まなかった");
    expect(report).toMatchObject({
      outcome: "failed",
      failureCategory: "safety",
      failureCode: "TASK_SUSPENDED_FOR_SAFETY",
      failureRetryable: true,
    });
    expect(report.summary).toContain("周囲の障害物");
    expect(report.summary).toContain("もう一度「こっちおいで」");
    expect(report.nextActions).toEqual([
      "周囲の障害物を避ける",
      "もう一度「こっちおいで」と指示する",
    ]);
    expect(report.summary).not.toContain("reflex:stuck");
    close();
  });

  it.each([
    {
      reason: "reflex:hazard",
      observed: "危険を確認したため",
      currentCheck: "現在も危険があるかは再確認が必要",
      nextAction: "周囲が安全か再確認する",
    },
    {
      reason: "reflex:hostile",
      observed: "危険な相手を確認したため",
      currentCheck: "現在も相手が近くにいるかは再確認が必要",
      nextAction: "周囲の安全を再確認してからもう一度指示する",
    },
    {
      reason: "reflex:damage",
      observed: "被害を確認したため",
      currentCheck: "現在も危険があるかは再確認が必要",
      nextAction: "周囲の安全と被害の原因を再確認する",
    },
    {
      reason: "reflex:hunger",
      observed: "空腹を確認したため",
      currentCheck: "現在の空腹状態と食料を再確認し",
      nextAction: "現在の空腹状態と食料を再確認する",
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
