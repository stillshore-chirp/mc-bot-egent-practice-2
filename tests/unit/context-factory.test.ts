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
  it("authorizes only a direct owner request to equip carried armor", async () => {
    const contextFactory = factory();
    const allowed = await contextFactory.create(
      "owner",
      "渡した防具、つけてみな",
      new AbortController().signal,
      "armor-direct",
      "owner_message",
    );
    expect(allowed.toolContext.armorEquipAuthorized).toBe(true);
    expect(allowed.toolContext.armorEquipAuthorizationUsage).toEqual({
      consumed: false,
    });
    for (const [username, message] of [
      ["owner", "防具を装備してもいい？"],
      ["owner", "防具を装備しないで"],
      ["other", "防具を装備して"],
    ] as const) {
      const rejected = await factory().create(
        username,
        message,
        new AbortController().signal,
        "armor-rejected",
        "owner_message",
      );
      expect(rejected.toolContext.armorEquipAuthorized).toBeUndefined();
    }
  });
  it("binds a house request to the dedicated build scope without resource-goal clarification", async () => {
    const allowed = await factory().create(
      "owner",
      "近くに家を作って",
      new AbortController().signal,
      "base-request",
      "owner_message",
    );
    expect(allowed.toolContext.baseBuildAuthorized).toBe(true);
    expect(allowed.toolContext.safeActionClarification).toBeUndefined();
    expect(allowed.toolContext.safeActionAuthorization).toBeUndefined();

    const question = await factory().create(
      "owner",
      "5×5の家を建てて",
      new AbortController().signal,
      "base-clarify",
      "owner_message",
    );
    expect(question.toolContext.baseBuildAuthorized).toBeUndefined();
    expect(question.toolContext.baseBuildClarification).toContain("3×3");

    const thirdParty = await factory().create(
      "other",
      "近くに家を作って",
      new AbortController().signal,
      "base-other",
      "owner_message",
    );
    expect(thirdParty.toolContext.baseBuildAuthorized).toBeUndefined();
  });

  it("uses a bounded affirmative answer to a base-build clarification once", async () => {
    const contextFactory = factory();
    const question = await contextFactory.create(
      "owner",
      "石で家を建てて",
      new AbortController().signal,
      "base-pending",
      "owner_message",
    );
    expect(question.toolContext.baseBuildClarification).toContain("オーク");

    const other = await contextFactory.create(
      "other",
      "はい",
      new AbortController().signal,
      "base-other-answer",
      "owner_message",
    );
    expect(other.toolContext.baseBuildAuthorized).toBeUndefined();

    const accepted = await contextFactory.create(
      "owner",
      "はい",
      new AbortController().signal,
      "base-accepted",
      "owner_message",
    );
    expect(accepted.toolContext.baseBuildAuthorized).toBe(true);
    expect(accepted.toolContext.baseBuildResume).toBe(false);

    const replay = await contextFactory.create(
      "owner",
      "はい",
      new AbortController().signal,
      "base-replay",
      "owner_message",
    );
    expect(replay.toolContext.baseBuildAuthorized).toBeUndefined();
  });

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

  it("keeps one pending resource goal for the next owner quantity reply", async () => {
    const contextFactory = factory();
    const first = await contextFactory.create(
      "owner",
      "鉄を掘って",
      new AbortController().signal,
      "correlation-pending-1",
      "owner_message",
    );
    expect(first.toolContext.safeActionAuthorization).toBeUndefined();
    expect(first.toolContext.safeActionClarification).toContain("数量");

    const second = await contextFactory.create(
      "owner",
      "20個",
      new AbortController().signal,
      "correlation-pending-2",
      "owner_message",
    );
    expect(second.toolContext.safeActionAuthorization).toMatchObject({
      targetItem: "raw_iron",
      targetCount: 20,
    });
    expect(second.toolContext.safeActionClarification).toBeUndefined();
  });

  it("passes a generic log goal to the observed selector with a bounded owner authorization", async () => {
    const result = await factory().create(
      "owner",
      "近くの原木を2本集めて、種類は任せる",
      new AbortController().signal,
      "correlation-generic-log",
      "owner_message",
    );

    expect(result.toolContext.safeActionAuthorization).toMatchObject({
      targetItem: "*",
      targetCount: 2,
      selectionRequired: true,
    });
    expect(result.toolContext.safeActionClarification).toBeUndefined();
  });

  it("preserves pending owner goals across runtime reassessment but clears on stop", async () => {
    const contextFactory = factory();
    await contextFactory.create(
      "owner",
      "鉄を掘って",
      new AbortController().signal,
      "correlation-clear-1",
      "owner_message",
    );
    await contextFactory.create(
      "owner",
      "現在の状態を確認して",
      new AbortController().signal,
      "correlation-clear-2",
      "runtime_reassessment",
    );
    const afterRuntime = await contextFactory.create(
      "owner",
      "20個",
      new AbortController().signal,
      "correlation-clear-3",
      "owner_message",
    );
    expect(afterRuntime.toolContext.safeActionAuthorization).toMatchObject({
      targetItem: "raw_iron",
      targetCount: 20,
    });

    await contextFactory.create(
      "owner",
      "鉄を掘って",
      new AbortController().signal,
      "correlation-clear-4",
      "owner_message",
    );
    contextFactory.clearPendingOwnerGoal();
    const afterStop = await contextFactory.create(
      "owner",
      "20個",
      new AbortController().signal,
      "correlation-clear-5",
      "owner_message",
    );
    expect(afterStop.toolContext.safeActionAuthorization).toBeUndefined();
  });

  it("does not let a third-party message consume the owner pending goal", async () => {
    const contextFactory = factory();
    await contextFactory.create(
      "owner",
      "鉄を掘って",
      new AbortController().signal,
      "correlation-third-party-1",
      "owner_message",
    );
    const thirdParty = await contextFactory.create(
      "other",
      "20個",
      new AbortController().signal,
      "correlation-third-party-2",
      "owner_message",
    );
    expect(thirdParty.toolContext.safeActionAuthorization).toBeUndefined();

    const owner = await contextFactory.create(
      "owner",
      "20個",
      new AbortController().signal,
      "correlation-third-party-3",
      "owner_message",
    );
    expect(owner.toolContext.safeActionAuthorization).toMatchObject({
      targetItem: "raw_iron",
      targetCount: 20,
    });
  });

  it.each(["座標10 64 20へ移動して", "10秒ついてきて"])(
    "does not block an unrelated numeric action with a resource clarification: %s",
    async (message) => {
      const result = await factory().create(
        "owner",
        message,
        new AbortController().signal,
        "correlation-unrelated-number",
        "owner_message",
      );

      expect(result.toolContext.safeActionAuthorization).toBeUndefined();
      expect(result.toolContext.safeActionClarification).toBeUndefined();
    },
  );
});
