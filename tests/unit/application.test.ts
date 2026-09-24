import { describe, expect, it } from "vitest";

import {
  isSpatialHazardIncident,
  reflexReassessmentForTransition,
  runtimeReassessmentState,
  SafetyReassessmentEpisodes,
  taskExpectsMovement,
} from "../../src/app/application.js";
import { RuntimeReassessmentGate } from "../../src/app/runtime-reassessment-gate.js";
import type { ReflexState } from "../../src/reflexes/reflex-coordinator.js";

const failed = (
  code = "REFLEX_FAILED",
): Extract<ReflexState, { state: "failed" }> => ({
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
  it("remembers environmental incidents as locations but not equipment or low vitals", () => {
    const base = failed();
    for (const kind of ["hazard", "damage", "hostile", "stuck"] as const) {
      expect(
        isSpatialHazardIncident({
          ...base,
          incident: { ...base.incident, kind },
        }),
      ).toBe(true);
    }
    for (const kind of ["equipment", "critical_health", "hunger"] as const) {
      expect(
        isSpatialHazardIncident({
          ...base,
          incident: { ...base.incident, kind },
        }),
      ).toBe(false);
    }
    expect(isSpatialHazardIncident({ state: "safe" })).toBe(false);
  });

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

  it("builds stable safe keys for causes and state changes", () => {
    const failedState = failed("REFLEX_NOT_STABLE");
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

    expect(
      runtimeReassessmentState("safety_failed", safe, failedState),
    ).toEqual({
      stateKey: "safety:failed:stuck:REFLEX_NOT_STABLE",
      causeKey: "reflex:stuck",
    });
    expect(
      runtimeReassessmentState("safety_stabilized", stabilizing, safe),
    ).toEqual({
      stateKey: "safety:stabilized:stuck",
      causeKey: "reflex:stuck",
    });
    const nextStabilizing: ReflexState = {
      ...stabilizing,
      startedAt: "2026-08-25T00:05:00.000Z",
    };
    expect(
      runtimeReassessmentState("safety_stabilized", nextStabilizing, safe),
    ).toEqual({
      stateKey: "safety:stabilized:stuck",
      causeKey: "reflex:stuck",
    });
    const retriedFailure: ReflexState = {
      ...failedState,
      startedAt: "2026-09-22T00:05:00.000Z",
    };
    expect(
      runtimeReassessmentState("safety_failed", stabilizing, retriedFailure),
    ).toEqual({
      stateKey:
        "safety:failed:stuck:REFLEX_NOT_STABLE:attempt:2026-09-22T00:05:00_000Z",
      causeKey: "reflex:stuck",
    });
    expect(
      runtimeReassessmentState("connection_recovered", safe, safe),
    ).toEqual({
      stateKey: "connection:recovered",
      causeKey: "connection",
    });
    expect(
      runtimeReassessmentState("connection_recovered", safe, safe, 2),
    ).toEqual({
      stateKey: "connection:recovered:2",
      causeKey: "connection",
    });
  });

  it("groups brief repeated recoveries but immediately reports failure and a new episode", async () => {
    const episodes = new SafetyReassessmentEpisodes(60_000);
    const decisions: string[] = [];
    const delivered: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: async (event: string) => {
        delivered.push(event);
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
      onDecision: ({ outcome, reason }) =>
        decisions.push(`${outcome}:${reason ?? "none"}`),
    });
    const recovered = {
      stateKey: "safety:stabilized:hostile",
      causeKey: "reflex:hostile",
    };
    gate.request({
      event: "safety_stabilized",
      ...episodes.state("safety_stabilized", recovered, 0),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    gate.request({
      event: "safety_stabilized",
      ...episodes.state("safety_stabilized", recovered, 10_000),
    });
    expect(delivered).toEqual(["safety_stabilized"]);
    expect(decisions).toContain("suppressed:unchanged_state");

    gate.request({
      event: "safety_stabilized",
      ...episodes.state("safety_stabilized", recovered, 75_000),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    gate.request({
      event: "safety_failed",
      ...episodes.state(
        "safety_failed",
        {
          stateKey: "safety:failed:hostile:REFLEX_NOT_STABLE",
          causeKey: "reflex:hostile",
        },
        76_000,
      ),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    gate.request({
      event: "safety_stabilized",
      ...episodes.state("safety_stabilized", recovered, 77_000),
    });
    await gate.stop();
    expect(delivered).toEqual([
      "safety_stabilized",
      "safety_stabilized",
      "safety_failed",
      "safety_stabilized",
    ]);
  });
});
