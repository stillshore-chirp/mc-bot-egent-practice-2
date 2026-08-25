import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryTaskStore } from "../../src/app/memory-adapters.js";
import { MemoryStore } from "../../src/memory/store.js";
import { runWithCorrelation } from "../../src/observability/correlation.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { MoveToSkill } from "../../src/skills/move-to.js";
import { FakeMinecraft } from "../support/fake-minecraft.js";

describe("task memory integration", () => {
  it("persists correlation, terminal result, and a structured episode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mc-task-memory-"));
    const memory = MemoryStore.open(join(directory, "memory.sqlite"));
    try {
      const player = memory.getOrCreatePlayer("owner");
      const minecraft = new FakeMinecraft();
      const runtime = new TaskRuntime(
        new MemoryTaskStore(memory, player.id),
        () => minecraft.stopCurrentAction(),
      );
      const skill = new MoveToSkill(minecraft, runtime, new ActionArbiter());

      await runWithCorrelation("correlation-test", () =>
        skill.run({
          position: { x: 2, y: 64, z: 1 },
          range: 1,
          timeoutMs: 1_000,
        }),
      );

      const recent = memory.listRecentTaskRuns(player.id, 1)[0];
      expect(recent?.status).toBe("completed");
      expect(recent?.input.correlationId).toBe("correlation-test");
      expect(
        memory.recall({
          playerId: player.id,
          query: "move_to completed",
          kinds: ["episode"],
        }),
      ).toHaveLength(1);
    } finally {
      memory.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
