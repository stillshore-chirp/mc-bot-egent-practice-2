import { describe, expect, it } from "vitest";

import {
  partialPathPlans,
  partialPathProbeComplete,
  isInsidePartialPathCorridor,
  type PartialPathProbeEvidence,
} from "./partial-path-probe.js";

describe("partial path probe fixture", () => {
  it("keeps a finite corridor, mid-route barrier, and separate backup regions", () => {
    const plans = partialPathPlans({ x: 0.5, y: 64, z: 0.5 });

    expect(plans.sidewalls.blocks.length).toBe(78);
    expect(plans.barrier.blocks.length).toBe(6);
    expect(
      new Set(
        plans.sidewalls.blocks.map(
          ({ position }) => `${position.x}:${position.y}:${position.z}`,
        ),
      ).size,
    ).toBe(78);
    expect(plans.sidewalls.sourceRegion.minX).toBe(-1);
    expect(plans.sidewalls.sourceRegion.maxX).toBe(11);
    expect(
      plans.sidewalls.blocks.some(
        ({ position }) =>
          position.x === -1 && position.y === 64 && position.z === 0,
      ),
    ).toBe(true);
    expect(
      plans.sidewalls.blocks.find(
        ({ position }) =>
          position.x === 1 && position.y === 64 && position.z === 0,
      )?.block,
    ).toBe("air");
    expect(plans.sidewalls.sourceRegion.maxX).toBeLessThan(
      plans.barrier.backupOrigin.x,
    );
    expect(plans.barrier.sourceRegion.maxX).toBeLessThan(
      plans.sidewalls.backupOrigin.x,
    );
    expect(plans.target.x).toBeGreaterThan(plans.barrierPosition.x);
    expect(plans.sidewalls.backupOrigin).not.toEqual(
      plans.barrier.backupOrigin,
    );
    expect(isInsidePartialPathCorridor({ x: 1.5, z: 0.5 }, plans)).toBe(true);
    expect(isInsidePartialPathCorridor({ x: -0.5, z: 0.5 }, plans)).toBe(false);
  });

  it("requires the failed path, fresh Body view, independent oracle, zero calls, and cleanup", () => {
    const evidence: PartialPathProbeEvidence = {
      gptCalls: 0,
      operationStatus: "failed",
      failureClass: "no_path",
      progressedBeforeBarrier: true,
      barrierInstalledWhileMoveActive: true,
      barrierAheadBeforeUnfreeze: true,
      barrierVisibleBeforeUnfreeze: true,
      stoppedBeforeTarget: true,
      freshBodyObservation: true,
      bodyObservedBarrier: true,
      rconConfirmedBarrier: true,
      restorationVerified: true,
    };

    expect(partialPathProbeComplete(evidence)).toBe(true);
    for (const key of Object.keys(
      evidence,
    ) as (keyof PartialPathProbeEvidence)[]) {
      const value = evidence[key];
      if (typeof value !== "boolean" || key === "barrierVisibleBeforeUnfreeze")
        continue;
      expect(partialPathProbeComplete({ ...evidence, [key]: false })).toBe(
        false,
      );
    }
    expect(
      partialPathProbeComplete({
        ...evidence,
        barrierVisibleBeforeUnfreeze: false,
      }),
    ).toBe(true);
    expect(partialPathProbeComplete({ ...evidence, gptCalls: 1 })).toBe(false);
    expect(
      partialPathProbeComplete({ ...evidence, failureClass: "timeout" }),
    ).toBe(false);
  });
});
