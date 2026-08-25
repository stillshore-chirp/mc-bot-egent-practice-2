import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.useRealTimers());

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
    expect(minecraft.actions).toContain("escape:environment");
  });

  it("uses the environmental escape when lava and a hostile coexist", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({
        inLava: true,
        nearbyEntities: [
          {
            id: 1,
            name: "zombie",
            kind: "mob",
            position: { x: 1, y: 64, z: 0 },
            distance: 1,
            hostile: true,
          },
        ],
      }),
    );
    const state = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      true,
    );
    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("escape:environment");
  });

  it("uses the directed escape only for a hostile incident", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({
        nearbyEntities: [
          {
            id: 1,
            name: "zombie",
            kind: "mob",
            position: { x: 1, y: 64, z: 0 },
            distance: 1,
            hostile: true,
          },
        ],
      }),
    );
    const state = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      true,
    );
    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("escape:hostile");
  });

  it("uses the directed escape when damage and a nearby hostile coexist", async () => {
    const minecraft = new FakeMinecraft(createSnapshot());
    const coordinator = coordinatorFor(minecraft);
    await coordinator.tick(await minecraft.observe(), false);
    minecraft.snapshot = createSnapshot({
      health: 19,
      nearbyEntities: [
        {
          id: 1,
          name: "zombie",
          kind: "mob",
          position: { x: 1, y: 64, z: 0 },
          distance: 1,
          hostile: true,
        },
      ],
    });

    const state = await coordinator.tick(await minecraft.observe(), true);
    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("escape:hostile");
  });

  it("clears a failed reflex after cooldown when the observed incident is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    class UnstableMinecraft extends FakeMinecraft {
      public override async escapeDanger(
        _mode: "environment" | "hostile",
        signal: AbortSignal,
      ): Promise<void> {
        if (signal.aborted) throw signal.reason;
        this.actions.push("escape:unstable");
      }
    }
    const minecraft = new UnstableMinecraft(createSnapshot({ inLava: true }));
    const coordinator = coordinatorFor(minecraft);
    const failed = await coordinator.tick(await minecraft.observe(), true);
    expect(failed.state).toBe("failed");

    minecraft.snapshot = createSnapshot();
    vi.advanceTimersByTime(5_001);
    const recovered = await coordinator.tick(await minecraft.observe(), false);
    expect(recovered.state).toBe("safe");
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
