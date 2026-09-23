import { describe, expect, it } from "vitest";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { GatherLogsSkill } from "../../src/skills/gather-logs/gather-logs-skill.js";
import { BaseBuildSkill } from "../../src/skills/base-build-skill.js";
import {
  buildBlockKey,
  buildPlan,
  buildSiteCandidates,
} from "../../src/skills/base-build-plan.js";
import type { TaskRecord } from "../../src/domain/task.js";
import type { JsonValue, TaskRunRecord } from "../../src/memory/types.js";
import { FakeMinecraft, createSnapshot } from "../support/fake-minecraft.js";

const gatherLimits = {
  maxCount: 64,
  localSearchDistance: 8,
  maxSearchDistance: 0,
  searchStep: 4,
  moveRange: 1,
  returnRange: 2,
  maxPathAttempts: 1,
};

function fixture(planks = 23) {
  const minecraft = new FakeMinecraft(
    createSnapshot({
      position: { x: 0.5, y: 64, z: 0.5 },
      inventory: planks === 0 ? [] : [{ name: "oak_planks", count: planks }],
    }),
  );
  const records: TaskRecord[] = [];
  const tasks = new TaskRuntime(
    {
      save: async (record) => {
        records.push(record);
      },
    },
    () => minecraft.stopCurrentAction(),
  );
  const arbiter = new ActionArbiter();
  const gather = new GatherLogsSkill(minecraft, tasks, arbiter, gatherLimits);
  const skill = new BaseBuildSkill(
    minecraft,
    tasks,
    arbiter,
    gather,
    "owner",
    () => [],
  );
  return { minecraft, records, tasks, skill };
}

function stored(record: TaskRecord): TaskRunRecord {
  if (record.checkpoint === undefined) throw new Error("missing checkpoint");
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    phase: record.phase,
    input: {},
    checkpoint: {
      id: "test-checkpoint",
      taskRunId: record.id,
      sequence: 1,
      phase: record.phase,
      data: record.checkpoint as Readonly<Record<string, JsonValue>>,
      createdAt: record.updatedAt,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

describe("base-build task", () => {
  it("completes one hut and confirms every placed block", async () => {
    const { minecraft, skill } = fixture();
    const result = await skill.run();
    expect(result.status).toBe("completed");
    expect(result.output?.verifiedBlocks).toBe(23);
    expect(minecraft.placedBlocks.size).toBe(23);
    expect(
      minecraft.actions.filter((action) => action.startsWith("place:")),
    ).toHaveLength(23);
  });

  it("suspends before mutation when material cannot be safely procured", async () => {
    const { minecraft, skill } = fixture(0);
    const result = await skill.run();
    expect(result.status).toBe("suspended");
    expect(result.checkpoint?.verified).toEqual([]);
    expect(minecraft.placedBlocks.size).toBe(0);
  });

  it("rejects protected candidate sites without placing a block", async () => {
    const { minecraft, skill } = fixture();
    const snapshot = minecraft.snapshot;
    for (const center of buildSiteCandidates(snapshot).slice(1)) {
      const first = buildPlan(
        center,
        snapshot.dimension,
        snapshot.position,
        minecraft.worldId,
      ).blocks[0];
      if (first === undefined) throw new Error("missing planned block");
      minecraft.actionGuardDecisions.set(
        `oak_planks:${buildBlockKey(first)}`,
        "protected",
      );
    }
    const result = await skill.run();
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("BASE_SITE_UNAVAILABLE");
    expect(minecraft.placedBlocks.size).toBe(0);
  });

  it("resumes only confirmed partial work after an explicit stop", async () => {
    const { minecraft, records, tasks, skill } = fixture();
    let stopped = false;
    const originalSave = records.push.bind(records);
    // Stop after the fifth authoritative placement checkpoint has been saved.
    records.push = (...items) => {
      const length = originalSave(...items);
      const latest = items.at(-1);
      if (
        !stopped &&
        latest?.kind === "build_base" &&
        Array.isArray(latest.checkpoint?.verified) &&
        latest.checkpoint.verified.length === 5
      ) {
        stopped = true;
        queueMicrotask(() => {
          void tasks.cancel("owner stop");
        });
      }
      return length;
    };
    const partial = await skill.run();
    expect(partial.status).toBe("cancelled");
    expect(partial.checkpoint?.verified).toHaveLength(5);
    expect(minecraft.placedBlocks.size).toBe(5);
    const resumed = await skill.run(stored(partial));
    expect(resumed.status).toBe("completed");
    expect(resumed.output?.verifiedBlocks).toBe(23);
    expect(minecraft.placedBlocks.size).toBe(23);
    expect(
      minecraft.actions.filter((action) => action.startsWith("place:")),
    ).toHaveLength(23);
  });

  it("stops a saved build when the server world identity changes", async () => {
    const { minecraft, skill } = fixture(0);
    const shortage = await skill.run();
    expect(shortage.status).toBe("suspended");
    minecraft.worldId = "00000000-0000-4000-8000-000000000002";
    minecraft.snapshot = {
      ...minecraft.snapshot,
      inventory: [{ name: "oak_planks", count: 23 }],
    };
    const resumed = await skill.run(stored(shortage));
    expect(resumed.status).toBe("failed");
    expect(resumed.failure?.code).toBe("BASE_WORLD_CHANGED");
    expect(minecraft.placedBlocks.size).toBe(0);
  });
});
