import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import {
  ReflexDetector,
  reflexObservation,
  type ReflexThresholds,
} from "../../src/reflexes/detectors.js";
import { ReflexCoordinator } from "../../src/reflexes/reflex-coordinator.js";
import {
  actionPriorities,
  ActionArbiter,
} from "../../src/runtime/action-arbiter.js";
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
    3,
    "owner",
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

  it("equips carried armor on its own when an observed slot is empty", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({ inventory: [{ name: "iron_chestplate", count: 1 }] }),
    );
    const coordinator = coordinatorFor(minecraft);

    expect(
      (await coordinator.tick(await minecraft.observe(), false)).state,
    ).toBe("stabilizing");
    expect(minecraft.actions).toContain("equip:torso:iron_chestplate");
    expect((await minecraft.observe()).armor?.torso).toBe("iron_chestplate");
    expect(
      (await coordinator.tick(await minecraft.observe(), false)).state,
    ).toBe("safe");
  });

  it("prioritizes armor over food at critical health without a visible attacker", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({
        health: 4,
        food: 10,
        inventory: [{ name: "iron_helmet", count: 1 }],
      }),
    );

    const state = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      false,
    );

    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("equip:head:iron_helmet");
    expect(minecraft.actions).not.toContain("eat:bread");
  });

  it("eats at critical health when no armor or attacker is available", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({ health: 4, food: 10 }),
    );
    const state = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      false,
    );

    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("eat:bread");
  });

  it("moves toward the nearby owner on a safe route when critical and out of food", async () => {
    class NoFoodMinecraft extends FakeMinecraft {
      public override async eatBestFood(): Promise<string> {
        throw new AppError({
          category: "inventory",
          code: "NO_SAFE_FOOD",
          message: "No safe food is carried",
          retryable: false,
        });
      }
    }
    const minecraft = new NoFoodMinecraft(
      createSnapshot({
        health: 4,
        food: 10,
        players: [
          {
            username: "owner",
            position: { x: 8, y: 64, z: 0 },
            distance: 8,
          },
        ],
      }),
    );
    const response = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      false,
    );

    expect(response.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("move:8,64,0");
  });

  it("retreats before equipping when a critically injured Bot sees a hostile", async () => {
    const minecraft = new FakeMinecraft(
      createSnapshot({
        health: 4,
        inventory: [{ name: "iron_helmet", count: 1 }],
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
      false,
    );

    expect(state.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("escape:hostile");
    expect(minecraft.actions).not.toContain("equip:head:iron_helmet");
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

  it("treats low oxygen as a hazard only when the Bot is underwater", () => {
    const detector = new ReflexDetector(thresholds);
    const land = detector.detect(
      createSnapshot({ oxygen: 5, inWater: false }),
      false,
    );
    expect(land).toBeUndefined();

    const underwater = detector.detect(
      createSnapshot({ oxygen: 5, inWater: true }),
      false,
    );
    expect(underwater).toMatchObject({
      kind: "hazard",
      reason: "Bot oxygen is low while underwater",
      observation: {
        subject: "bot",
        source: "minecraft",
        oxygen: 5,
        oxygenState: "low",
        inWater: true,
      },
    });

    const recovered = detector.detect(
      createSnapshot({ oxygen: 20, inWater: true }),
      false,
    );
    expect(recovered).toBeUndefined();
  });

  it("uses an explicit unknown observation for underwater oxygen it cannot confirm", () => {
    const detector = new ReflexDetector(thresholds);
    const incident = detector.detect(
      createSnapshot({ oxygen: null, inWater: true }),
      false,
    );

    expect(incident).toMatchObject({
      kind: "hazard",
      reason: "Bot oxygen cannot be confirmed while underwater",
      observation: { oxygen: null, oxygenState: "unknown", inWater: true },
    });
  });

  it("keeps the intervention timeline and reports an unstable oxygen state as failure", async () => {
    class UnstableMinecraft extends FakeMinecraft {
      public override async escapeDanger(
        _mode: "environment" | "hostile",
        signal: AbortSignal,
      ): Promise<void> {
        if (signal.aborted) throw signal.reason;
        this.actions.push("escape:unstable");
      }
    }

    const minecraft = new UnstableMinecraft(
      createSnapshot({ oxygen: 5, inWater: true }),
    );
    const coordinator = coordinatorFor(minecraft);
    const failed = await coordinator.tick(await minecraft.observe(), false);

    expect(failed).toMatchObject({
      state: "failed",
      failure: { code: "REFLEX_NOT_STABLE" },
      incident: {
        observation: { oxygen: 5, oxygenState: "low", inWater: true },
      },
      after: { oxygen: 5, oxygenState: "low", inWater: true },
    });
    if (failed.state !== "failed") throw new Error("expected failed reflex");
    expect(failed.startedAt).toBe(failed.incident.observation.observedAt);
    expect(failed.endedAt).toBe(failed.after?.observedAt);
    expect(minecraft.actions).toContain("escape:unstable");
  });

  it("does not mark surface breathing as a completed escape while still in water", async () => {
    class SurfaceOnlyMinecraft extends FakeMinecraft {
      public override async escapeDanger(
        _mode: "environment" | "hostile",
        signal: AbortSignal,
      ): Promise<void> {
        if (signal.aborted) throw signal.reason;
        this.snapshot = createSnapshot({ oxygen: 20, inWater: true });
      }
    }
    const minecraft = new SurfaceOnlyMinecraft(
      createSnapshot({ oxygen: 5, inWater: true }),
    );

    const result = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      false,
    );

    expect(result).toMatchObject({
      state: "failed",
      failure: { code: "REFLEX_NOT_STABLE" },
      after: { oxygen: 20, oxygenState: "normal", inWater: true },
    });
  });

  it("keeps the observed state and shore failure reason when no dry route exists", async () => {
    class ShorelessMinecraft extends FakeMinecraft {
      public override async escapeDanger(): Promise<void> {
        this.snapshot = createSnapshot({ oxygen: 20, inWater: true });
        throw new AppError({
          category: "safety",
          code: "SHORE_NOT_OBSERVED",
          message: "No dry shore was observed",
          retryable: true,
        });
      }
    }
    const minecraft = new ShorelessMinecraft(
      createSnapshot({ oxygen: 5, inWater: true }),
    );

    const result = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      false,
    );

    expect(result).toMatchObject({
      state: "failed",
      failure: { code: "SHORE_NOT_OBSERVED" },
      after: { inWater: true, oxygen: 20, oxygenState: "normal" },
    });
  });

  it("requires confirmed oxygen recovery even after leaving the water", async () => {
    class UnconfirmedOxygenMinecraft extends FakeMinecraft {
      public override async escapeDanger(): Promise<void> {
        this.snapshot = createSnapshot({ oxygen: null, inWater: false });
      }
    }
    const minecraft = new UnconfirmedOxygenMinecraft(
      createSnapshot({ oxygen: 5, inWater: true }),
    );
    const result = await coordinatorFor(minecraft).tick(
      await minecraft.observe(),
      false,
    );
    expect(result).toMatchObject({
      state: "failed",
      failure: { code: "REFLEX_NOT_STABLE" },
      after: { inWater: false, oxygen: null },
    });
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

  it("does not interrupt a bounded planned fall but reacts to later unrelated damage", async () => {
    class PlannedFallMinecraft extends FakeMinecraft {
      public override isExpectedDescentDamage(
        previous: ReturnType<typeof createSnapshot>,
        current: ReturnType<typeof createSnapshot>,
      ): boolean {
        return (
          previous.health === 20 &&
          current.health === 19 &&
          previous.position.y > current.position.y
        );
      }
    }
    const minecraft = new PlannedFallMinecraft(
      createSnapshot({ position: { x: 0, y: 69, z: 0 } }),
    );
    const coordinator = coordinatorFor(minecraft);
    await coordinator.tick(await minecraft.observe(), true);
    minecraft.snapshot = createSnapshot({
      position: { x: 1, y: 64, z: 0 },
      health: 19,
    });
    expect(
      (await coordinator.tick(await minecraft.observe(), true)).state,
    ).toBe("safe");
    expect(minecraft.actions).not.toContain("escape:environment");

    minecraft.snapshot = createSnapshot({
      position: { x: 1, y: 64, z: 0 },
      health: 18,
    });
    expect(
      (await coordinator.tick(await minecraft.observe(), true)).state,
    ).toBe("stabilizing");
    expect(minecraft.actions).toContain("escape:environment");
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

  it("reacts to a new hostile immediately after a no-food failure", async () => {
    class NoFoodMinecraft extends FakeMinecraft {
      public override async eatBestFood(): Promise<string> {
        throw new AppError({
          category: "inventory",
          code: "NO_SAFE_FOOD",
          message: "No safe food is carried",
          retryable: false,
        });
      }
    }
    const minecraft = new NoFoodMinecraft(createSnapshot({ food: 10 }));
    const coordinator = coordinatorFor(minecraft);
    const failed = await coordinator.tick(await minecraft.observe(), false);
    expect(failed).toMatchObject({
      state: "failed",
      failure: { code: "NO_SAFE_FOOD" },
    });

    minecraft.snapshot = createSnapshot({
      food: 10,
      nearbyEntities: [
        {
          id: 2,
          name: "zombie",
          kind: "mob",
          position: { x: 2, y: 64, z: 0 },
          distance: 2,
          hostile: true,
        },
      ],
    });
    const response = await coordinator.tick(await minecraft.observe(), false);
    expect(response.state).toBe("stabilizing");
    expect(minecraft.actions).toContain("escape:hostile");
  });

  it("does not retry unavailable food until the observed inventory changes", async () => {
    class InventoryAwareMinecraft extends FakeMinecraft {
      public eatAttempts = 0;

      public override async eatBestFood(signal: AbortSignal): Promise<string> {
        this.eatAttempts += 1;
        if (
          !this.snapshot.inventory.some(
            (item) => item.name === "bread" && item.count > 0,
          )
        ) {
          throw new AppError({
            category: "inventory",
            code: "NO_SAFE_FOOD",
            message: "No safe food is carried",
            retryable: false,
          });
        }
        return super.eatBestFood(signal);
      }
    }
    const minecraft = new InventoryAwareMinecraft(createSnapshot({ food: 10 }));
    const coordinator = coordinatorFor(minecraft);
    await coordinator.tick(await minecraft.observe(), false);
    await coordinator.tick(await minecraft.observe(), false);
    expect(minecraft.eatAttempts).toBe(1);

    minecraft.snapshot = createSnapshot({
      food: 10,
      inventory: [{ name: "bread", count: 1 }],
    });
    const response = await coordinator.tick(await minecraft.observe(), false);
    expect(response.state).toBe("stabilizing");
    expect(minecraft.eatAttempts).toBe(2);
    expect(minecraft.actions).toContain("eat:bread");
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

  it("reserves the reflex lease before suspending the task", async () => {
    let startSuspending!: () => void;
    const suspensionStarted = new Promise<void>((resolve) => {
      startSuspending = resolve;
    });
    let releaseSuspension!: () => void;
    const suspension = new Promise<void>((resolve) => {
      releaseSuspension = resolve;
    });
    const minecraft = new FakeMinecraft();
    const initialSnapshot = await minecraft.observe();
    const tasks = {
      suspend: async () => {
        startSuspending();
        await suspension;
      },
    } as unknown as TaskRuntime;
    const detector = {
      detect: () => ({
        kind: "stuck" as const,
        reason: "Movement was requested but position did not change",
        priority: 100,
        observation: reflexObservation(initialSnapshot),
      }),
    } as unknown as ReflexDetector;
    const arbiter = new ActionArbiter();
    const coordinator = new ReflexCoordinator(
      detector,
      thresholds,
      minecraft,
      tasks,
      arbiter,
      1_000,
    );

    const tick = coordinator.tick(initialSnapshot, true);
    await suspensionStarted;

    let error: unknown;
    try {
      arbiter.acquire("task:replacement", actionPriorities.task);
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toMatchObject({ detail: { code: "ACTION_LEASE_BUSY" } });

    releaseSuspension();
    expect((await tick).state).toBe("stabilizing");
  });
});
