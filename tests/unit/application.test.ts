import { describe, expect, it } from "vitest";

import {
  reflexReassessmentForTransition,
  taskExpectsMovement,
} from "../../src/app/application.js";
import type { ReflexState } from "../../src/reflexes/reflex-coordinator.js";

const failed = (code = "REFLEX_FAILED"): ReflexState => ({
  state: "failed",
  incident: {
    kind: "stuck",
    reason: "movement stopped",
    priority: 100,
    observation: {
      subject: "bot",
      source: "minecraft",
      observedAt: "2026-09-22T00:00:00.000Z",
      dimension: "overworld",
      position: { x: 0, y: 64, z: 0 },
      oxygen: 20,
      oxygenState: "not_applicable",
      inWater: false,
    },
  },
  failure: {
    category: "safety",
    code,
    message: "recovery failed",
    retryable: false,
  },
});

describe("application reflex policy", () => {
  it("expects movement only from a running movement phase", () => {
    expect(
      taskExpectsMovement({ status: "running", phase: "following" }, 8, 3),
    ).toBe(true);
    expect(
      taskExpectsMovement({ status: "running", phase: "following" }, 3, 3),
    ).toBe(false);
    expect(
      taskExpectsMovement(
        { status: "running", phase: "following" },
        undefined,
        3,
      ),
    ).toBe(false);
    expect(
      taskExpectsMovement({ status: "suspended", phase: "following" }, 8, 3),
    ).toBe(false);
    expect(taskExpectsMovement({ status: "running", phase: "completed" })).toBe(
      false,
    );
    expect(taskExpectsMovement(undefined)).toBe(false);
  });

  it("uses the active follow task range instead of the configured fallback", () => {
    const task = {
      kind: "follow_player",
      status: "running",
      phase: "following",
      input: { range: 10 },
    };

    expect(taskExpectsMovement(task, 8, 3)).toBe(false);
    expect(taskExpectsMovement(task, 11, 3)).toBe(true);
  });

  it("requests reassessment once per meaningful reflex state transition", () => {
    const safe: ReflexState = { state: "safe" };
    const stabilizing: ReflexState = {
      state: "stabilizing",
      incident: {
        kind: "stuck",
        reason: "movement stopped",
        priority: 100,
        observation: {
          subject: "bot",
          source: "minecraft",
          observedAt: "2026-08-25T00:00:00.000Z",
          dimension: "overworld",
          position: { x: 0, y: 64, z: 0 },
          oxygen: 20,
          oxygenState: "not_applicable",
          inWater: false,
        },
      },
    };

    expect(reflexReassessmentForTransition(safe, failed())).toBe(
      "safety_failed",
    );
    expect(reflexReassessmentForTransition(failed(), failed())).toBeUndefined();
    expect(
      reflexReassessmentForTransition(failed(), stabilizing),
    ).toBeUndefined();
    expect(reflexReassessmentForTransition(stabilizing, safe)).toBe(
      "safety_stabilized",
    );
    expect(reflexReassessmentForTransition(failed(), safe)).toBe(
      "safety_stabilized",
    );
    expect(reflexReassessmentForTransition(safe, safe)).toBeUndefined();
  });
});
