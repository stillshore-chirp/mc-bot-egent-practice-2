import pino from "pino";
import { describe, expect, it } from "vitest";

import {
  ChatCoordinator,
  type ChatContextFactory,
} from "../../src/agent/chat-coordinator.js";
import type { OpenAIDeliberationAgent } from "../../src/agent/openai-agent.js";
import { CompanionGameController } from "../../src/app/game-controller.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { FollowPlayerSkill } from "../../src/skills/follow-player.js";
import { GatherLogsSkill } from "../../src/skills/gather-logs/gather-logs-skill.js";
import { MoveToSkill } from "../../src/skills/move-to.js";
import { ReturnToPlayerSkill } from "../../src/skills/return-to-player.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import type {
  GameController,
  MemoryPort,
  ToolContext,
} from "../../src/tools/contracts.js";
import { FakeMinecraft } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";

class FollowRecoveryMinecraft extends FakeMinecraft {
  private followCount = 0;

  override async followPlayer(
    username: string,
    range: number,
    maxPathAttempts: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.followCount += 1;
    if (this.followCount === 1) {
      await super.followPlayer(username, range, maxPathAttempts, signal);
      return;
    }
    this.actions.push(`follow:${username}`);
    signal.throwIfAborted();
  }
}

function createScenario() {
  const minecraft = new FollowRecoveryMinecraft();
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
    logger: pino({ level: "silent" }),
    memory: {} as never,
  });
  return { game, minecraft, tasks };
}

function createContextFactory(game: GameController): ChatContextFactory {
  return {
    create: async (
      requesterUsername,
      _message,
      signal,
      correlationId,
      requestKind,
    ) => ({
      personaContext: "短く、理由と次の操作を日本語で説明する。",
      memoryContext: "関連する保存済み記憶はありません。",
      worldContext: JSON.stringify(await game.observeStatus()),
      toolContext: {
        correlationId,
        requesterUsername,
        authorizedOwnerUsername: "owner",
        playerId: "test-player",
        signal,
        requestKind,
        executionEvidence: { verifiedActionReceipts: [] },
        game,
        memory: {} as MemoryPort,
        limits: {
          maxMoveDistance: 128,
          maxGatherCount: 16,
          followDistance: 3,
          memoryContextLimit: 10,
        },
      },
    }),
  };
}

function createScenarioAgent(executor: ToolExecutor) {
  return {
    deliberate: async (request: {
      readonly message: string;
      readonly toolContext: ToolContext;
    }) => {
      if (request.message === "来て") {
        const result = await executor.execute(
          "follow_player",
          JSON.stringify({ safeDistance: 3, maxDurationSeconds: 60 }),
          request.toolContext,
        );
        return {
          text: result.success ? result.userSummary : result.error.userSummary,
          toolResults: [{ name: "follow_player", result }],
        };
      }
      const status = await request.toolContext.game.observeStatus();
      return {
        text:
          status.activeTaskState ??
          "現在の停止理由を確認できません。状態を確認してから指示してください。",
        toolResults: [],
      };
    },
  } as unknown as OpenAIDeliberationAgent;
}

describe("follow recovery conversation", () => {
  it("explains a stuck follow and resumes after the next follow instruction", async () => {
    const { game, minecraft, tasks } = createScenario();
    const executor = new ToolExecutor();
    const replies: string[] = [];
    const coordinatorGame: GameController = {
      delivery: game.delivery,
      observeStatus: () => game.observeStatus(),
      observeSurroundings: (radius, includeEntities) =>
        game.observeSurroundings(radius, includeEntities),
      say: async (message: string) => {
        replies.push(message);
        await game.say(message);
      },
      followOwner: (...args) => game.followOwner(...args),
      stopCurrentAction: (...args) => game.stopCurrentAction(...args),
      moveTo: (...args) => game.moveTo(...args),
      gatherResource: (...args) => game.gatherResource(...args),
      returnToOwner: (...args) => game.returnToOwner(...args),
      currentPosition: () => game.currentPosition(),
    };
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: coordinatorGame,
      agent: createScenarioAgent(executor),
      contextFactory: createContextFactory(game),
      logger: pino({ level: "silent" }),
    });

    const first = coordinator.handleChat("owner", "来て");
    await waitUntil(() => minecraft.actions.includes("follow:owner"));
    await tasks.suspend("reflex:stuck");
    await first;

    expect(replies[0]).toContain("移動が進まなかった");
    expect(replies[0]).toContain("もう一度「こっちおいで」");
    expect(replies[0]).not.toContain("MAIN_TASK_BUSY");

    await coordinator.handleChat("owner", "なぜ");
    expect(replies[1]).toContain("移動が進まなかった");
    expect(replies[1]).toContain("次の操作");
    expect(replies[1]).not.toContain("suspended");

    await coordinator.handleChat("owner", "来て");
    expect(replies[2]).toContain("追従し");
    expect(replies[2]).not.toContain("MAIN_TASK_BUSY");
    expect(tasks.current?.status).toBe("completed");
    expect(
      minecraft.actions.filter((action) => action === "follow:owner"),
    ).toHaveLength(2);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}
