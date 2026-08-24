import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeReassessmentGate } from "../../src/app/runtime-reassessment-gate.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeReassessmentGate", () => {
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
    const gate = new RuntimeReassessmentGate({
      run: (event: string) => {
        seen.push(event);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      priority: () => 1,
      cooldownMs: 30_000,
      onError: () => undefined,
    });

    gate.request("active");
    gate.request("cancelled-pending");
    gate.cancelPending();
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual(["active"]);

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
