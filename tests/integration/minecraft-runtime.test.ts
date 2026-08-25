import { describe, expect, it } from "vitest";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { MoveToSkill } from "../../src/skills/move-to.js";
import { FakeMinecraft } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";

describe("Minecraft adapter and runtime contract", () => {
  it("persists task transitions around an observed movement", async () => {
    const minecraft = new FakeMinecraft();
    const store = new InMemoryTaskStore();
    const runtime = new TaskRuntime(store, () => minecraft.stopCurrentAction());
    const skill = new MoveToSkill(minecraft, runtime, new ActionArbiter());
    const result = await skill.run({
      position: { x: 4, y: 64, z: 3 },
      range: 1,
      timeoutMs: 1_000,
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ position: { x: 4, y: 64, z: 3 } });
    expect(store.records.map((record) => record.status)).toContain("running");
    expect(store.records.at(-1)?.status).toBe("completed");
  });
});
