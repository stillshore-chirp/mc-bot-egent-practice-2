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
