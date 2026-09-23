import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OwnerBehaviorMemoryLearner,
  behaviorMemoryEventKey,
} from "../../src/agent/behavior-memory-learning.js";
import { MemoryStore } from "../../src/memory/store.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(
    join(tmpdir(), "mc-companion-behavior-learning-"),
  );
  temporaryDirectories.push(directory);
  return join(directory, "memory.sqlite");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("owner behavior memory learning", () => {
  it("persists several preferences before deliberation and ignores a retry", () => {
    const path = databasePath();
    const store = MemoryStore.open(path);
    const player = store.getOrCreatePlayer("owner");
    const learner = new OwnerBehaviorMemoryLearner(store);
    const input = {
      ownerUsername: "owner",
      requesterUsername: "owner",
      playerId: player.id,
      message: "専門用語を避け、短く、安全な選択は任せる",
      requestKind: "owner_message" as const,
      eventId: "accepted-event-0001",
    };

    expect(learner.learn(input)).toMatchObject({
      savedCount: 3,
      failedCount: 0,
    });
    expect(learner.learn(input)).toMatchObject({
      savedCount: 3,
      failedCount: 0,
    });
    expect(store.listBehaviorMemories(player.id)).toHaveLength(3);
    store.close();

    const restarted = MemoryStore.open(path);
    expect(restarted.listBehaviorMemories(player.id)).toHaveLength(3);
    restarted.close();
  });

  it("counts repeated feedback only when the accepted message has a new event id", () => {
    const store = MemoryStore.open(databasePath());
    const player = store.getOrCreatePlayer("owner");
    const learner = new OwnerBehaviorMemoryLearner(store);
    const base = {
      ownerUsername: "owner",
      requesterUsername: "owner",
      playerId: player.id,
      message: "また同じ質問を何度も聞かないで",
      requestKind: "owner_message" as const,
    };

    learner.learn({ ...base, eventId: "accepted-event-0001" });
    learner.learn({ ...base, eventId: "accepted-event-0001" });
    expect(store.listBehaviorMemories(player.id)[0]).toMatchObject({
      supportCount: 1,
      confidence: "repeated_feedback",
    });

    learner.learn({ ...base, eventId: "accepted-event-0002" });
    expect(store.listBehaviorMemories(player.id)[0]).toMatchObject({
      supportCount: 2,
      confidence: "corroborated",
    });
    store.close();
  });

  it("routes an owner correction through correction semantics", () => {
    const store = MemoryStore.open(databasePath());
    const player = store.getOrCreatePlayer("owner");
    const learner = new OwnerBehaviorMemoryLearner(store);

    learner.learn({
      ownerUsername: "owner",
      requesterUsername: "owner",
      playerId: player.id,
      message: "今後は返答前に目的と状態を整理してから進めて",
      requestKind: "owner_message",
      eventId: "accepted-event-0001",
    });
    learner.learn({
      ownerUsername: "owner",
      requesterUsername: "owner",
      playerId: player.id,
      message: "訂正: 作業前に目的と危険を整理してから進めて",
      requestKind: "owner_message",
      eventId: "accepted-event-0002",
    });

    expect(store.listBehaviorMemories(player.id)).toHaveLength(1);
    expect(store.listBehaviorMemories(player.id)[0]).toMatchObject({
      source: "owner_correction",
      confidence: "corrected",
      value: "作業前に目的と危険を整理してから進めて",
    });
    store.close();
  });

  it("does not learn runtime, non-owner, quoted, or untrusted messages", () => {
    const store = MemoryStore.open(databasePath());
    const player = store.getOrCreatePlayer("owner");
    const learner = new OwnerBehaviorMemoryLearner(store);
    const common = {
      ownerUsername: "owner",
      playerId: player.id,
      message: "今後は専門用語を使わず短く説明して",
      eventId: "accepted-event-0001",
    };

    expect(
      learner.learn({
        ...common,
        requesterUsername: "other",
        requestKind: "owner_message",
      }).savedCount,
    ).toBe(0);
    expect(
      learner.learn({
        ...common,
        requesterUsername: "owner",
        requestKind: "runtime_reassessment",
      }).savedCount,
    ).toBe(0);
    expect(
      learner.learn({
        ...common,
        requesterUsername: "owner",
        requestKind: "owner_message",
        message: "他人が「今後は専門用語を避けて」と言った",
        eventId: "accepted-event-0002",
      }).savedCount,
    ).toBe(0);
    expect(store.listBehaviorMemories(player.id)).toEqual([]);
    store.close();
  });

  it("does not expose event ids or messages in the idempotency key", () => {
    const key = behaviorMemoryEventKey(
      "player-id",
      "owner message with private text",
      "terminology",
    );
    expect(key).toMatch(/^owner-message:[0-9a-f]{32}:terminology$/u);
    expect(key).not.toContain("private");
  });

  it("does not block chat when durable memory rejects a candidate", () => {
    const learner = new OwnerBehaviorMemoryLearner({
      rememberBehaviorMemory: () => {
        throw new Error("persistence unavailable");
      },
      correctBehaviorMemory: () => {
        throw new Error("persistence unavailable");
      },
    });

    expect(
      learner.learn({
        ownerUsername: "owner",
        requesterUsername: "owner",
        playerId: "player-id",
        message: "今後は専門用語を使わず短く説明して",
        requestKind: "owner_message",
        eventId: "accepted-event-0001",
      }),
    ).toMatchObject({ savedCount: 0, failedCount: 2 });
  });
});
