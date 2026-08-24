import { describe, expect, it } from "vitest";
import {
  ReflexDetector,
  type ReflexThresholds,
} from "../../src/reflexes/detectors.js";
import { ReflexCoordinator } from "../../src/reflexes/reflex-coordinator.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { FakeMinecraft, createSnapshot } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";

const thresholds: ReflexThresholds = {
  lowFood: 14,
  lowOxygen: 5,
  hostileDistance: 8,
  fallingVelocity: -0.9,
  stuckWindowMs: 1_000,
  stuckDistance: 0.5,
};

const coordinatorFor = (minecraft: FakeMinecraft): ReflexCoordinator =>
  new ReflexCoordinator(
    new ReflexDetector(thresholds),
    thresholds,
    minecraft,
    new TaskRuntime(new InMemoryTaskStore(), () =>
      minecraft.stopCurrentAction(),
    ),
    new ActionArbiter(),
    1_000,
  );

describe("reflex loop", () => {
  it("eats without calling an LLM when hunger is low", async () => {
    const minecraft = new FakeMinecraft(createSnapshot({ food: 10 }));
    const state = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      false,
    );
    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("eat:bread");
  });

  it("escapes an observed lava hazard", async () => {
    const minecraft = new FakeMinecraft(createSnapshot({ inLava: true }));
    const state = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      true,
    );
    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("escape");
  });

  it("uses bounded stuck recovery after the movement window expires", async () => {
    const old = new Date(Date.now() - 2_000).toISOString();
    const minecraft = new FakeMinecraft(createSnapshot());
    const coordinator = coordinatorFor(minecraft);
    await coordinator.tick(
      { ...(await minecraft.observe()), observedAt: old },
      true,
    );
    const state = await coordinator.tick(await minecraft.observe(), true);
    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("recover:stuck");
  });
});
