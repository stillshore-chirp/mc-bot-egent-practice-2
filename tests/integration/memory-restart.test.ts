import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../../src/memory/store.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "mc-companion-memory-restart-"));
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

describe("memory restart recovery", () => {
  it("retains durable structured memory and changes unverified running work to suspended", () => {
    const path = databasePath();
    const first = MemoryStore.open(path);
    const player = first.getOrCreatePlayer("Builder");
    first.rememberPlayerFact({
      playerId: player.id,
      subject: "Builder",
      predicate: "home_biome",
      value: "plains",
      source: "minecraft_observed",
    });
    first.saveLifeState({
      currentInterests: ["find a safe cave entrance"],
      longTermGoals: ["connect the home base by rail"],
      homeBase: {
        name: "Hill base",
        dimension: "minecraft:overworld",
        x: 8,
        y: 72,
        z: -5,
      },
      possessions: [{ name: "rail", quantity: 24 }],
    });
    const worldMemory = first.rememberWorldMemory({
      kind: "hazard",
      name: "Lava pocket",
      description: "lava exposed below the abandoned mineshaft",
      dimension: "minecraft:overworld",
      x: 36,
      y: 18,
      z: -44,
      source: "minecraft_observed",
    });
    const task = first.createTaskRun({
      playerId: player.id,
      kind: "gather_resource",
      status: "running",
      phase: "collecting",
      input: { resource: "oak_log", requestedCount: 8 },
    });
    first.recordTaskCheckpoint({
      taskRunId: task.id,
      phase: "collecting",
      data: { collectedCount: 3 },
    });
    first.close();

    const restarted = MemoryStore.open(path);
    const recoveredTask = restarted.getTaskRun(task.id);
    const recalled = restarted.recall({
      playerId: player.id,
      query: "plains",
      kinds: ["fact"],
    });
    const life = restarted.getLifeState();
    const rememberedHazards = restarted.searchWorldMemories({
      query: "lava",
      kinds: ["hazard"],
    });

    expect(recoveredTask.status).toBe("suspended");
    expect(recoveredTask.phase).toBe("collecting");
    expect(recoveredTask.checkpoint).toMatchObject({
      taskRunId: task.id,
      sequence: 1,
      data: { collectedCount: 3 },
    });
    expect(recalled).toHaveLength(1);
    expect(life).toMatchObject({
      currentInterests: ["find a safe cave entrance"],
      homeBase: { name: "Hill base", x: 8, y: 72, z: -5 },
      possessions: [{ name: "rail", quantity: 24 }],
    });
    expect(rememberedHazards).toEqual([
      expect.objectContaining({
        id: worldMemory.id,
        kind: "hazard",
        name: "Lava pocket",
      }),
    ]);
    restarted.close();
  });
});
