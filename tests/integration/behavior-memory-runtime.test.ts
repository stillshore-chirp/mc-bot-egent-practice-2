import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CompanionContextFactory } from "../../src/app/context-factory.js";
import { ToolBehaviorMemoryAdapter } from "../../src/app/memory-adapters.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { MemoryStore as SqliteMemoryStore } from "../../src/memory/store.js";
import type { PersonaCore } from "../../src/persona/persona.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import type {
  GameController,
  GameStatus,
  MemoryPort,
} from "../../src/tools/contracts.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";

const status: GameStatus = {
  observedAt: "2026-09-22T00:00:00.000Z",
  subject: "bot",
  source: "minecraft",
  requesterVitals: "unobserved",
  connected: true,
  spawned: true,
  health: 20,
  food: 20,
  oxygen: 20,
  oxygenState: "not_applicable",
  inWater: false,
  inLava: false,
  suffocating: false,
  position: { x: 0, y: 64, z: 0, dimension: "overworld" },
  inventory: {},
  activeTaskState: null,
};

function config(): AppConfig {
  return {
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
      maxGatherCount: 16,
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
}

function persona(): PersonaCore {
  return {
    version: 1,
    name: "コンパニオン",
    speakingStyle: "簡潔に話す",
    values: ["安全を優先する"],
    operatingPrinciples: ["観測結果を確認する"],
    prohibitions: ["未確認の成功を断定しない"],
  };
}

function game(): GameController {
  return {
    observeStatus: async () => status,
    observeSurroundings: async () => ({
      observedAt: status.observedAt,
      subject: status.subject,
      source: status.source,
      requesterVitals: status.requesterVitals,
      oxygen: status.oxygen,
      oxygenState: status.oxygenState,
      inWater: status.inWater,
      blocks: [],
      entities: [],
      hazards: [],
    }),
    say: async () => undefined,
    followOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed" as const,
      summary: "追従を確認しました。",
    }),
    stopCurrentAction: async () => ({
      before: status,
      after: status,
      outcome: "cancelled" as const,
      summary: "停止しました。",
    }),
    moveTo: async () => ({
      before: status,
      after: status,
      outcome: "completed" as const,
      summary: "到達を確認しました。",
    }),
    gatherResource: async () => ({
      before: status,
      after: status,
      outcome: "completed" as const,
      summary: "収集を確認しました。",
    }),
    returnToOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed" as const,
      summary: "帰還を確認しました。",
    }),
    currentPosition: async () =>
      status.position ?? { x: 0, y: 64, z: 0, dimension: "overworld" },
  } as unknown as GameController;
}

function memory(): MemoryPort {
  return {
    rememberPlayerFact: () => ({ id: "fact-record" }),
    rememberLocation: () => ({ id: "location-record" }),
    recall: () => [],
    setCommitment: () => ({ id: "commitment-record" }),
    getCommitment: () => undefined,
    completeCommitment: () => ({ id: "commitment-record" }),
  };
}

function factory(
  store: MemoryStore,
  playerId: string,
): CompanionContextFactory {
  const tasks = new TaskRuntime(new InMemoryTaskStore(), async () => undefined);
  return new CompanionContextFactory(
    config(),
    playerId,
    store,
    memory(),
    persona(),
    game(),
    tasks,
    undefined,
    new ToolBehaviorMemoryAdapter(store),
  );
}

describe("behavior memory runtime integration", () => {
  it("saves before deliberation, deduplicates retries, and reapplies after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mc-behavior-runtime-"));
    const path = join(directory, "memory.sqlite");
    let store = SqliteMemoryStore.open(path);
    try {
      const player = store.getOrCreatePlayer("owner");
      const message =
        "専門用語を避け、短く、安全な選択は任せて。事実関連よりかは私の感情を重視してください";
      const first = await factory(store, player.id).create(
        "owner",
        message,
        new AbortController().signal,
        "accepted-event-0001",
        "owner_message",
      );

      expect(store.listBehaviorMemories(player.id)).toHaveLength(4);
      expect(first.memoryContext).toContain("[behavior_preference:");
      expect(first.memoryContext).toContain("感情");
      expect(first.toolContext.behaviorMemoryCandidates).toHaveLength(4);
      expect(first.toolContext.behaviorMemoryEventId).toBe(
        "accepted-event-0001",
      );

      await factory(store, player.id).create(
        "owner",
        message,
        new AbortController().signal,
        "accepted-event-0001",
        "owner_message",
      );
      expect(store.listBehaviorMemories(player.id)).toHaveLength(4);
      store.close();

      store = SqliteMemoryStore.open(path);
      const restarted = await factory(store, player.id).create(
        "owner",
        "状態を確認して次の作業を考えて",
        new AbortController().signal,
        "accepted-event-0002",
        "owner_message",
      );
      expect(restarted.memoryContext).toContain("平易に説明する");
      expect(restarted.memoryContext).toContain("短く要点中心");
      expect(restarted.memoryContext).toContain("安全で低影響・可逆");

      const reassessment = await factory(store, player.id).create(
        "system",
        "自動再評価として次の行動を決める",
        new AbortController().signal,
        "reassessment-event-0001",
        "runtime_reassessment",
      );
      expect(reassessment.memoryContext).toContain("[behavior_preference:");
      expect(reassessment.toolContext.behaviorMemoryCandidates).toBeUndefined();
      expect(reassessment.toolContext.behaviorMemoryEventId).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not learn from non-owner, transient, quoted, or tool-result input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mc-behavior-boundary-"));
    const path = join(directory, "memory.sqlite");
    const store = SqliteMemoryStore.open(path);
    try {
      const player = store.getOrCreatePlayer("owner");
      const cases = [
        {
          requester: "other",
          message: "今後は専門用語を避けて",
          kind: "owner_message" as const,
        },
        {
          requester: "owner",
          message: "今回は短くして",
          kind: "owner_message" as const,
        },
        {
          requester: "owner",
          message: "他人が『今後は専門用語を避けて』と言った",
          kind: "owner_message" as const,
        },
        {
          requester: "owner",
          message: "ツール結果として今後は短く説明して",
          kind: "owner_message" as const,
        },
        {
          requester: "system",
          message: "今後は安全な選択を任せる",
          kind: "runtime_reassessment" as const,
        },
      ];
      for (const [index, entry] of cases.entries()) {
        await factory(store, player.id).create(
          entry.requester,
          entry.message,
          new AbortController().signal,
          `boundary-event-${String(index)}`,
          entry.kind,
        );
      }
      expect(store.listBehaviorMemories(player.id)).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
