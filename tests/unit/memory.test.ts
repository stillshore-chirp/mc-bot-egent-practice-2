import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore, MemoryStoreError } from "../../src/memory/store.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "mc-companion-memory-"));
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

describe("MemoryStore", () => {
  it("persists an empty initial life state without creating a stale search entry", () => {
    const store = MemoryStore.open(databasePath());
    const initial = store.saveLifeState({
      currentInterests: [],
      longTermGoals: [],
      possessions: [],
    });

    expect(store.getLifeState()).toEqual(initial);
    expect(store.searchLifeState("rail route")).toBeUndefined();

    store.saveLifeState({
      currentInterests: ["repair the rail route"],
      longTermGoals: [],
      possessions: [],
    });
    expect(store.searchLifeState("rail route")).toBeDefined();

    store.saveLifeState({
      currentInterests: [],
      longTermGoals: [],
      possessions: [],
    });
    expect(store.searchLifeState("rail route")).toBeUndefined();
  });

  it("creates a migrated WAL database and a relationship with a player", () => {
    const path = databasePath();
    const store = MemoryStore.open(path);
    const first = store.getOrCreatePlayer("Taishi");
    const second = store.getOrCreatePlayer("taishi");
    const relationship = store.getRelationship(first.id);
    store.close();

    const database = new Database(path);
    const journalMode = database.pragma("journal_mode", { simple: true });
    const migration = database
      .prepare<[], { readonly version: number }>(
        "SELECT version FROM schema_migrations",
      )
      .all();
    database.close();

    expect(second.id).toBe(first.id);
    expect(relationship).toMatchObject({
      playerId: first.id,
      trust: 0,
      intimacy: 0,
      state: {},
    });
    expect(journalMode).toBe("wal");
    expect(migration).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it("forward migrates an existing v1 database without losing its structured records", () => {
    const path = databasePath();
    const first = MemoryStore.open(path);
    const player = first.getOrCreatePlayer("Migrator");
    first.rememberPlayerFact({
      playerId: player.id,
      subject: "Migrator",
      predicate: "favorite_material",
      value: "copper",
      source: "player_stated",
    });
    first.close();

    const v1 = new Database(path);
    v1.exec(
      "DROP TABLE life_states; DROP TABLE world_memories; DELETE FROM schema_migrations WHERE version = 2",
    );
    v1.close();

    const migrated = MemoryStore.open(path);
    const inspected = new Database(path);
    const migrations = inspected
      .prepare<[], { readonly version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
      .all();
    inspected.close();

    expect(migrations).toEqual([{ version: 1 }, { version: 2 }]);
    expect(
      migrated.recall({
        playerId: player.id,
        query: "copper",
        kinds: ["fact"],
      }),
    ).toHaveLength(1);
    expect(migrated.getLifeState()).toBeUndefined();
    migrated.close();
  });

  it("deduplicates facts, supersedes conflicts, retracts records, and searches active memory", () => {
    const store = MemoryStore.open(databasePath());
    const player = store.getOrCreatePlayer("Builder");
    const first = store.rememberPlayerFact({
      playerId: player.id,
      subject: "Builder",
      predicate: "favorite_wood",
      value: "oak",
      source: "player_stated",
    });
    const duplicate = store.rememberPlayerFact({
      playerId: player.id,
      subject: "Builder",
      predicate: "favorite_wood",
      value: "oak",
      source: "player_stated",
    });
    const updated = store.rememberPlayerFact({
      playerId: player.id,
      subject: "Builder",
      predicate: "favorite_wood",
      value: "birch",
      source: "player_stated",
    });
    const retracted = store.retractFact(
      updated.id,
      "the player corrected this fact",
    );
    store.rememberPlayerFact({
      playerId: player.id,
      subject: "Builder",
      predicate: "好きな花",
      value: "桜",
      source: "player_stated",
    });

    expect(duplicate.id).toBe(first.id);
    expect(updated.supersededById).toBeUndefined();
    expect(retracted.status).toBe("retracted");
    expect(
      store.recall({ playerId: player.id, query: "oak", kinds: ["fact"] }),
    ).toEqual([]);
    expect(
      store.recall({ playerId: player.id, query: "birch", kinds: ["fact"] }),
    ).toEqual([]);
    expect(
      store.recall({
        playerId: player.id,
        query: "桜の花が好きだと覚えて",
        kinds: ["fact"],
      }),
    ).toHaveLength(1);
  });

  it("stores searchable locations, commitments, and structured episodes without a transcript API", () => {
    const store = MemoryStore.open(databasePath());
    const player = store.getOrCreatePlayer("Explorer");
    const location = store.rememberLocation({
      playerId: player.id,
      name: "Oak grove",
      purpose: "wood gathering",
      dimension: "minecraft:overworld",
      x: 12,
      y: 70,
      z: -8,
    });
    const commitment = store.setCommitment({
      playerId: player.id,
      description: "Return after collecting eight oak logs",
      blockers: ["bridge is incomplete"],
      fulfillment: {
        toolName: "gather_resource",
        resource: "oak_log",
        count: 8,
      },
    });
    const progressed = store.updateCommitmentProgress({
      commitmentId: commitment.id,
      progress: ["collected four logs"],
      blockers: ["bridge is incomplete"],
    });
    const complete = store.completeCommitment({
      playerId: player.id,
      commitmentId: commitment.id,
      outcome: {
        delivered: 8,
        verifiedBy: "inventory_snapshot",
      },
      verificationSource: "verified_tool_result",
      verificationEvidence: "inventory delta and return distance verified",
    });
    const episode = store.recordEpisode({
      playerId: player.id,
      summary: "Collected oak logs near the river",
      source: "minecraft_observed",
      importance: 4,
      details: { count: 8, dimension: "minecraft:overworld" },
    });

    expect(location.x).toBe(12);
    expect(progressed).toMatchObject({
      progress: ["collected four logs"],
      blockers: ["bridge is incomplete"],
      fulfillment: {
        toolName: "gather_resource",
        resource: "oak_log",
        count: 8,
      },
    });
    expect(complete.status).toBe("completed");
    expect(complete).toMatchObject({
      progress: ["collected four logs"],
      blockers: [],
      fulfillment: {
        toolName: "gather_resource",
        resource: "oak_log",
        count: 8,
      },
      outcome: { delivered: 8, verifiedBy: "inventory_snapshot" },
      completionVerification: {
        source: "verified_tool_result",
        evidence: "inventory delta and return distance verified",
      },
    });
    expect(episode.details).toEqual({
      count: 8,
      dimension: "minecraft:overworld",
    });
    expect(
      store.recall({
        playerId: player.id,
        query: "oak",
        kinds: ["location", "episode"],
      }),
    ).toHaveLength(2);
    expect(
      Object.prototype.hasOwnProperty.call(store, "rememberTranscript"),
    ).toBe(false);
  });

  it("does not transition a cancelled commitment to completed", () => {
    const path = databasePath();
    const store = MemoryStore.open(path);
    const player = store.getOrCreatePlayer("Explorer");
    const commitment = store.setCommitment({
      playerId: player.id,
      description: "Collect one oak log",
    });
    store.close();

    const database = new Database(path);
    database
      .prepare("UPDATE commitments SET status = 'cancelled' WHERE id = ?")
      .run(commitment.id);
    database.close();

    const reopened = MemoryStore.open(path);
    expect(() =>
      reopened.completeCommitment({
        playerId: player.id,
        commitmentId: commitment.id,
        outcome: "done",
        verificationSource: "owner_confirmation",
        verificationEvidence: "owner confirmed",
      }),
    ).toThrow(MemoryStoreError);
    expect(reopened.getCommitment(commitment.id)?.status).toBe("cancelled");
    reopened.close();
  });

  it("stores, corrects, and searches companion life state and world memory independently", () => {
    const store = MemoryStore.open(databasePath());
    const life = store.saveLifeState({
      currentInterests: ["map nearby caves"],
      longTermGoals: ["build a safe rail route"],
      homeBase: {
        name: "River cabin",
        dimension: "minecraft:overworld",
        x: 20,
        y: 68,
        z: -14,
      },
      possessions: [{ name: "copper ingot", quantity: 12 }],
    });
    const copper = store.rememberWorldMemory({
      kind: "resource",
      name: "Copper deposit",
      description: "visible ore along the cave wall",
      dimension: "minecraft:overworld",
      x: 44,
      y: 32,
      z: -19,
      source: "minecraft_observed",
    });
    const duplicate = store.rememberWorldMemory({
      kind: "resource",
      name: "Copper deposit",
      description: "visible ore along the cave wall",
      dimension: "minecraft:overworld",
      x: 44,
      y: 32,
      z: -19,
      source: "minecraft_observed",
    });
    expect(store.searchLifeState("copper")?.possessions).toEqual([
      { name: "copper ingot", quantity: 12 },
    ]);
    const corrected = store.correctWorldMemory({
      worldMemoryId: copper.id,
      replacement: {
        kind: "resource",
        name: "Copper deposit east",
        description: "confirmed copper vein behind the waterfall",
        dimension: "minecraft:overworld",
        x: 52,
        y: 31,
        z: -21,
        source: "minecraft_observed",
      },
    });
    const correctedLife = store.correctLifeState({
      currentInterests: ["repair the rail route"],
      longTermGoals: ["build a safe rail route"],
      possessions: [{ name: "copper ingot", quantity: 16 }],
    });

    expect(life.homeBase?.name).toBe("River cabin");
    expect(duplicate.id).toBe(copper.id);
    expect(store.getWorldMemory(copper.id)).toMatchObject({
      status: "superseded",
      supersededById: corrected.id,
    });
    expect(
      store.searchWorldMemories({ query: "waterfall", kinds: ["resource"] }),
    ).toEqual([
      expect.objectContaining({ id: corrected.id, status: "active" }),
    ]);
    const retracted = store.retractWorldMemory(
      corrected.id,
      "the vein was exhausted",
    );
    expect(retracted.status).toBe("retracted");
    expect(store.searchWorldMemories({ query: "waterfall" })).toEqual([]);
    expect(correctedLife.homeBase).toBeUndefined();
    expect(store.searchLifeState("map nearby caves")).toBeUndefined();
    expect(
      store.searchLifeState("repair rail route")?.currentInterests,
    ).toEqual(["repair the rail route"]);
  });

  it("persists task checkpoints and blocks likely credentials from every structured record", () => {
    const store = MemoryStore.open(databasePath());
    const player = store.getOrCreatePlayer("Operator");
    const task = store.createTaskRun({
      playerId: player.id,
      kind: "gather_resource",
      input: { resource: "oak_log", requestedCount: 8 },
      status: "running",
      phase: "finding_resource",
    });
    const checkpoint = store.recordTaskCheckpoint({
      taskRunId: task.id,
      phase: "moving",
      data: { target: "oak_log", attempts: 1 },
    });
    const updated = store.updateTaskRun({
      taskRunId: task.id,
      status: "suspended",
      phase: "moving",
      checkpoint: { target: "oak_log", attempts: 2 },
    });

    expect(checkpoint.sequence).toBe(1);
    expect(updated.checkpoint?.sequence).toBe(2);
    expect(store.listRecentTaskRuns(player.id, 1)).toEqual([
      expect.objectContaining({ id: task.id, status: "suspended" }),
    ]);
    expect(() =>
      store.rememberPlayerFact({
        playerId: player.id,
        subject: "account",
        predicate: "api_key",
        value: "redacted-test-credential",
        source: "player_stated",
      }),
    ).toThrow(MemoryStoreError);
  });
});
