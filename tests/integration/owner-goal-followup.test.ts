import { describe, expect, it } from "vitest";

import { CompanionContextFactory } from "../../src/app/context-factory.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { MemoryStore } from "../../src/memory/store.js";
import type { PersonaCore } from "../../src/persona/persona.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";
import type { GameController, MemoryPort } from "../../src/tools/contracts.js";
import { ToolExecutor } from "../../src/tools/executor.js";

const status = {
  connected: true,
  spawned: true,
  health: 20,
  food: 20,
  oxygen: 20,
  position: { x: 0, y: 64, z: 0, dimension: "overworld" },
  inventory: {},
  activeTaskState: null,
};

const config: AppConfig = {
  minecraft: {
    host: "127.0.0.1",
    port: 25_565,
    username: "companion",
    auth: "offline",
    version: "1.21.11",
  },
  ownerUsername: "owner",
  openai: { apiKey: "test-only", model: "gpt-5.6-luna" },
  databasePath: ":memory:",
  personaPath: "test-persona.json",
  logLevel: "silent",
  limits: {
    maxMoveDistance: 128,
    maxGatherCount: 64,
    taskTimeoutMs: 1_000,
    skillRetryLimit: 0,
    followDistance: 3,
    hungerThreshold: 14,
    memoryContextLimit: 10,
  },
  reconnect: { enabled: false, maxAttempts: 0, delayMs: 250 },
  dashboard: {
    enabled: false,
    host: "127.0.0.1",
    port: 4_310,
    staticDirectory: "dashboard/dist",
    maxAgeDays: 30,
    maxTraces: 100,
  },
};

const persona: PersonaCore = {
  version: 1,
  name: "コンパニオン",
  speakingStyle: "簡潔に話す",
  values: ["安全を優先する"],
  operatingPrinciples: ["観測結果を確認する"],
  prohibitions: ["未確認の成功を断定しない"],
};

function createFactory(calls: string[]): CompanionContextFactory {
  const memoryStore = {
    getRelationship: () => ({
      playerId: "player",
      trust: 50,
      intimacy: 20,
      state: {},
      updatedAt: new Date().toISOString(),
    }),
    getLifeState: () => undefined,
    searchWorldMemories: () => [],
    listRecentTaskRuns: () => [],
    recall: () => [],
  } as unknown as MemoryStore;
  const game: GameController = {
    observeStatus: async () => status,
    observeSurroundings: async () => ({
      blocks: [],
      entities: [],
      hazards: [],
    }),
    say: async () => undefined,
    followOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "追従しました。",
    }),
    stopCurrentAction: async () => ({
      before: status,
      after: status,
      outcome: "cancelled",
      summary: "停止しました。",
    }),
    moveTo: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "移動しました。",
    }),
    gatherResource: async () => {
      calls.push("gather_resource");
      return {
        before: status,
        after: status,
        outcome: "completed",
        summary: "収集しました。",
      };
    },
    returnToOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "戻りました。",
    }),
    currentPosition: async () => status.position,
  };
  const memory: MemoryPort = {
    rememberPlayerFact: () => ({}),
    rememberLocation: () => ({}),
    recall: () => [],
    setCommitment: () => ({ id: "commitment" }),
    getCommitment: () => undefined,
    completeCommitment: () => ({}),
  };
  return new CompanionContextFactory(
    config,
    "player",
    memoryStore,
    memory,
    persona,
    game,
    new TaskRuntime(new InMemoryTaskStore(), async () => undefined),
  );
}

describe("owner goal quantity follow-up boundary", () => {
  it("carries only the next owner quantity reply into action authorization", async () => {
    const calls: string[] = [];
    const contextFactory = createFactory(calls);
    const first = await contextFactory.create(
      "owner",
      "鉄を掘って",
      new AbortController().signal,
      "integration-pending-1",
      "owner_message",
    );
    const executor = new ToolExecutor();

    expect(first.toolContext.safeActionAuthorization).toBeUndefined();
    expect(first.toolContext.safeActionClarification).toContain("数量");
    const beforeQuantity = await executor.execute(
      "gather_resource",
      JSON.stringify({ resource: "oak_log", count: 1, commitmentId: null }),
      first.toolContext,
    );
    expect(beforeQuantity).toMatchObject({
      success: false,
      error: { code: "OWNER_GOAL_CLARIFICATION_REQUIRED" },
    });
    expect(calls).toEqual([]);

    const second = await contextFactory.create(
      "owner",
      "20個で",
      new AbortController().signal,
      "integration-pending-2",
      "owner_message",
    );
    expect(second.toolContext.safeActionAuthorization).toMatchObject({
      allowedResources: ["iron_ore", "deepslate_iron_ore"],
      targetItem: "raw_iron",
      targetCount: 20,
    });
  });

  it("does not treat a quantity statement as authorization for a held item", async () => {
    const contextFactory = createFactory([]);
    await contextFactory.create(
      "owner",
      "鉄を掘って",
      new AbortController().signal,
      "integration-held-1",
      "owner_message",
    );
    const held = await contextFactory.create(
      "owner",
      "20個持ってるよ",
      new AbortController().signal,
      "integration-held-2",
      "owner_message",
    );

    expect(held.toolContext.safeActionAuthorization).toBeUndefined();
    expect(held.toolContext.safeActionClarification).toContain("資源");
  });
});
