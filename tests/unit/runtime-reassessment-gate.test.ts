import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeReassessmentGate } from "../../src/app/runtime-reassessment-gate.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeReassessmentGate", () => {
  it("suppresses an unchanged state and exposes safe aggregate counts", async () => {
    const decisions: string[] = [];
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: async (event: string) => {
        seen.push(event);
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
      onDecision: ({ outcome, reason, stats }) => {
        decisions.push(
          `${outcome}:${reason ?? "none"}:${String(stats.requested)}:${String(stats.suppressed)}`,
        );
      },
    });

    gate.request({
      event: "safety_failed",
      stateKey: "failed:stuck:REFLEX_FAILED",
      causeKey: "reflex:stuck",
    });
    gate.request({
      event: "safety_failed",
      stateKey: "failed:stuck:REFLEX_FAILED",
      causeKey: "reflex:stuck",
    });
    await gate.stop();

    expect(seen).toEqual(["safety_failed"]);
    expect(gate.stats).toMatchObject({
      requested: 2,
      started: 1,
      completed: 1,
      failed: 0,
      suppressed: 1,
    });
    expect(decisions).toContain("suppressed:unchanged_state:2:1");
  });

  it("runs a changed explicit state immediately despite the legacy cooldown", async () => {
    const releases: (() => void)[] = [];
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: (event: string) => {
        seen.push(event);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
    });

    gate.request({ event: "safety_failed", stateKey: "danger:new" });
    releases.shift()?.();
    gate.request({ event: "safety_stabilized", stateKey: "danger:cleared" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(seen).toEqual(["safety_failed", "safety_stabilized"]);
    const stopped = gate.stop();
    releases.shift()?.();
    await stopped;
  });

  it("does not count an unsuccessful reassessment as completion", async () => {
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: async (event: string) => {
        seen.push(event);
        return "failed" as const;
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
    });

    gate.request({ event: "safety_failed", stateKey: "danger:active" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(gate.stats).toMatchObject({
      started: 1,
      completed: 0,
      failed: 1,
      cancelled: 0,
    });

    gate.request({ event: "safety_failed", stateKey: "danger:active" });
    await gate.stop();
    expect(seen).toEqual(["safety_failed", "safety_failed"]);
    expect(gate.stats.completed).toBe(0);
  });

  it("retries a completed state after a newer state was accepted", async () => {
    const releases: (() => void)[] = [];
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: (event: string) => {
        seen.push(event);
        return new Promise<"completed">((resolve) => {
          releases.push(() => resolve("completed"));
        });
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
    });

    gate.request({ event: "safety_failed", stateKey: "danger:active" });
    releases.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    gate.request({ event: "safety_stabilized", stateKey: "danger:cleared" });
    gate.request({ event: "safety_failed", stateKey: "danger:active" });
    expect(seen).toEqual(["safety_failed", "safety_stabilized"]);

    releases.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toEqual([
      "safety_failed",
      "safety_stabilized",
      "safety_failed",
    ]);
    releases.shift()?.();
    await gate.stop();
  });

  it("does not restore an old completed key when newer work is pending", async () => {
    const releases: (() => void)[] = [];
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: (event: string) => {
        seen.push(event);
        return new Promise<"completed">((resolve) => {
          releases.push(() => resolve("completed"));
        });
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
    });

    gate.request({ event: "safety_failed", stateKey: "danger:active" });
    gate.request({ event: "safety_stabilized", stateKey: "danger:cleared" });
    releases.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    gate.request({ event: "safety_failed", stateKey: "danger:active" });
    expect(seen).toEqual(["safety_failed", "safety_stabilized"]);
    releases.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toEqual([
      "safety_failed",
      "safety_stabilized",
      "safety_failed",
    ]);
    releases.shift()?.();
    await gate.stop();
  });

  it("accepts a fresh transition after an earlier tick was cancelled", async () => {
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: async (event: string) => {
        seen.push(event);
        return "completed" as const;
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
    });
    const staleGeneration = gate.captureGeneration();

    gate.cancelPending("owner_message");
    gate.request(
      { event: "safety_failed", stateKey: "danger:new" },
      staleGeneration,
    );
    gate.request({ event: "safety_failed", stateKey: "danger:new" });
    await gate.stop();

    expect(seen).toEqual(["safety_failed"]);
    expect(gate.stats).toMatchObject({ completed: 1, suppressed: 1 });
  });

  it("drops stale pending work when the active state recurs", async () => {
    let release!: () => void;
    const seen: string[] = [];
    const decisions: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: async (event: string) => {
        seen.push(event);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
      onDecision: ({ event, outcome, reason }) =>
        decisions.push(`${event}:${outcome}:${reason ?? "none"}`),
    });

    gate.request({ event: "safety_failed", stateKey: "danger:active" });
    gate.request({ event: "safety_stabilized", stateKey: "danger:pending" });
    gate.request({ event: "safety_failed", stateKey: "danger:active" });
    release();
    await gate.stop();

    expect(seen).toEqual(["safety_failed"]);
    expect(decisions).toContain("safety_stabilized:suppressed:stale_state");
    expect(decisions).toContain("safety_failed:suppressed:unchanged_state");
  });

  it("replaces same-priority pending work with the latest state", async () => {
    let release!: () => void;
    const seen: string[] = [];
    const decisions: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: async (event: string) => {
        seen.push(event);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
      onDecision: ({ event, outcome, reason }) =>
        decisions.push(`${event}:${outcome}:${reason ?? "none"}`),
    });

    gate.request({ event: "safety_failed", stateKey: "danger:stuck" });
    gate.request({ event: "safety_failed", stateKey: "danger:drowning" });
    gate.request({ event: "safety_failed", stateKey: "danger:lava" });
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toEqual(["safety_failed", "safety_failed"]);
    expect(decisions).toContain("safety_failed:suppressed:superseded");

    release();
    await gate.stop();
  });

  it("lets a newer stabilization replace a pending failure in the same stream", async () => {
    let release!: () => void;
    const seen: string[] = [];
    const decisions: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: async (event: string) => {
        seen.push(event);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      priority: (event) =>
        ({ active: 4, safety_failed: 4, safety_stabilized: 1 })[event] ?? 0,
      cooldownMs: 30_000,
      onError: () => undefined,
      onDecision: ({ event, outcome, reason }) =>
        decisions.push(`${event}:${outcome}:${reason ?? "none"}`),
    });

    gate.request({ event: "active", stateKey: "active", causeKey: "other" });
    gate.request({
      event: "safety_failed",
      stateKey: "danger:failed",
      causeKey: "reflex:stuck",
    });
    gate.request({
      event: "safety_stabilized",
      stateKey: "danger:stable",
      causeKey: "reflex:stuck",
    });
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(seen).toEqual(["active", "safety_stabilized"]);
    expect(decisions).toContain("safety_failed:suppressed:superseded");
    release();
    await gate.stop();
  });

  it("serializes requests and coalesces a burst by priority after cooldown", async () => {
    vi.useFakeTimers();
    const releases: (() => void)[] = [];
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: (event: string) => {
        seen.push(event);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      priority: (event) => ({ low: 1, medium: 2, high: 3 })[event] ?? 0,
      cooldownMs: 30_000,
      onError: () => undefined,
    });

    gate.request("low");
    gate.request("medium");
    gate.request("high");
    expect(seen).toEqual(["low"]);

    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(seen).toEqual(["low"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(["low", "high"]);

    const stopped = gate.stop();
    releases.shift()?.();
    await stopped;
  });

  it("drops queued work and waits for the active request during stop", async () => {
    let release: (() => void) | undefined;
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: (event: string) => {
        seen.push(event);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
    });

    gate.request("active");
    gate.request("queued");
    const stopped = gate.stop();
    expect(seen).toEqual(["active"]);
    release?.();
    await stopped;
    expect(seen).toEqual(["active"]);
  });

  it("cancels pending work without stopping the gate or aborting active work", async () => {
    vi.useFakeTimers();
    const releases: (() => void)[] = [];
    const seen: string[] = [];
    const decisions: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: (event: string) => {
        seen.push(event);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
      onDecision: ({ outcome, reason }) =>
        decisions.push(`${outcome}:${reason ?? "none"}`),
    });

    gate.request("active");
    gate.request("cancelled-pending");
    gate.cancelPending("owner_message");
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual(["active"]);
    expect(decisions).toContain("suppressed:owner_message");

    gate.request("later");
    expect(seen).toEqual(["active", "later"]);
    const stopped = gate.stop();
    releases.shift()?.();
    await stopped;
  });

  it("rejects an event produced by work that started before cancellation", async () => {
    const seen: string[] = [];
    const gate = new RuntimeReassessmentGate({
      run: async (event: string) => {
        seen.push(event);
      },
      priority: () => 1,
      cooldownMs: 0,
      onError: () => undefined,
    });
    const staleGeneration = gate.captureGeneration();

    gate.cancelPending();
    gate.request("stale-tick-result", staleGeneration);
    expect(seen).toEqual([]);

    gate.request("fresh-tick-result");
    await gate.stop();
    expect(seen).toEqual(["fresh-tick-result"]);
  });
});
