import { describe, expect, it } from "vitest";

import { CompanionContextFactory } from "../../src/app/context-factory.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { MemoryStore } from "../../src/memory/store.js";
import type { PersonaCore } from "../../src/persona/persona.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";
import type { GameController, MemoryPort } from "../../src/tools/contracts.js";

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

function factory(): CompanionContextFactory {
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
  const game = {
    observeStatus: async () => status,
  } as unknown as GameController;
  return new CompanionContextFactory(
    config,
    "player",
    memoryStore,
    {} as MemoryPort,
    persona,
    game,
    new TaskRuntime(new InMemoryTaskStore(), async () => undefined),
  );
}

describe("CompanionContextFactory owner action boundary", () => {
  it("attaches only the current authenticated owner goal", async () => {
    const first = await factory().create(
      "owner",
      "鉄20個を集めて",
      new AbortController().signal,
      "correlation-1",
      "owner_message",
    );
    expect(first.toolContext.safeActionAuthorization).toMatchObject({
      targetItem: "raw_iron",
      targetCount: 20,
    });

    const second = await factory().create(
      "owner",
      "石炭3個を集めて",
      new AbortController().signal,
      "correlation-2",
      "owner_message",
    );
    expect(second.toolContext.safeActionAuthorization).toMatchObject({
      targetItem: "coal",
      targetCount: 3,
    });
    expect(second.toolContext.safeActionAuthorization).not.toMatchObject({
      targetItem: "raw_iron",
    });

    const thirdParty = await factory().create(
      "other",
      "鉄20個を集めて",
      new AbortController().signal,
      "correlation-3",
      "owner_message",
    );
    expect(thirdParty.toolContext.safeActionAuthorization).toBeUndefined();
  });
});
