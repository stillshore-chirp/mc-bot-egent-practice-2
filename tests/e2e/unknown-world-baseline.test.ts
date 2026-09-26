import { describe, expect, it } from "vitest";

import { withFrozenTicks } from "./world-oracle.js";
import { captureReproducibleUnknownWorldBaseline } from "./unknown-world-baseline.js";

function fakeRcon(commands: string[]) {
  let frozen = false;
  return {
    command: async (command: string): Promise<string> => {
      commands.push(command);
      if (command === "tick freeze") frozen = true;
      if (command === "tick unfreeze") frozen = false;
      if (command === "tick query")
        return frozen ? "The game is frozen" : "The game is running normally";
      return "";
    },
  };
}

describe("unknown world baseline reproducibility", () => {
  it("force-loads first, then requires consecutive bounded comparisons", async () => {
    const events: string[] = [];
    const commands: string[] = [];
    const fail = (code: string): never => {
      throw new Error(code);
    };
    let captures = 0;
    let comparisons = 0;

    await captureReproducibleUnknownWorldBaseline({
      forceLoadSource: async () => {
        events.push("load_source");
      },
      forceLoadDestination: async () => {
        events.push("load_destination");
      },
      waitForTickWindow: async () => {
        events.push(`tick_window_${captures}`);
      },
      withFrozenTicks: (operation) =>
        withFrozenTicks(fakeRcon(commands), operation, fail, {
          onFrozen: () => events.push("frozen"),
          onUnfrozen: () => events.push("unfrozen"),
        }),
      captureBaseline: async () => {
        captures += 1;
        events.push(`capture_${captures}`);
      },
      compareBaseline: async () => {
        comparisons += 1;
        events.push(`compare_${comparisons}`);
        return comparisons !== 1;
      },
      fail,
    });

    expect(events).toEqual([
      "load_source",
      "load_destination",
      "capture_1",
      "tick_window_1",
      "compare_1",
      "capture_2",
      "tick_window_2",
      "compare_2",
      "capture_3",
      "tick_window_3",
      "compare_3",
      "frozen",
      "capture_4",
      "compare_4",
      "unfrozen",
    ]);
    expect(commands).toEqual([
      "tick freeze",
      "tick query",
      "tick unfreeze",
      "tick query",
    ]);
  });

  it("stops after the finite window limit when no comparison matches", async () => {
    let captures = 0;
    let waits = 0;
    let frozen = false;
    const fail = (code: string): never => {
      throw new Error(code);
    };

    await expect(
      captureReproducibleUnknownWorldBaseline({
        forceLoadSource: async () => undefined,
        forceLoadDestination: async () => undefined,
        waitForTickWindow: async () => {
          waits += 1;
        },
        withFrozenTicks: async (operation) => {
          frozen = true;
          await operation();
          frozen = false;
        },
        captureBaseline: async () => {
          captures += 1;
        },
        compareBaseline: async () => false,
        fail,
      }),
    ).rejects.toThrow("WORLD_ORACLE_FIXTURE_BASELINE_NOT_REPRODUCIBLE");

    expect(captures).toBe(6);
    expect(waits).toBe(6);
    expect(frozen).toBe(false);
  });

  it("keeps a frozen baseline mismatch strict and unfreezes", async () => {
    const commands: string[] = [];
    const fail = (code: string): never => {
      throw new Error(code);
    };
    let comparisons = 0;

    await expect(
      captureReproducibleUnknownWorldBaseline({
        forceLoadSource: async () => undefined,
        forceLoadDestination: async () => undefined,
        waitForTickWindow: async () => undefined,
        withFrozenTicks: (operation) =>
          withFrozenTicks(fakeRcon(commands), operation, fail),
        captureBaseline: async () => undefined,
        compareBaseline: async () => {
          comparisons += 1;
          return comparisons < 3;
        },
        fail,
      }),
    ).rejects.toThrow("WORLD_ORACLE_INITIAL_BASELINE_MISMATCH");

    expect(comparisons).toBe(3);
    expect(commands).toEqual([
      "tick freeze",
      "tick query",
      "tick unfreeze",
      "tick query",
    ]);
  });
});
