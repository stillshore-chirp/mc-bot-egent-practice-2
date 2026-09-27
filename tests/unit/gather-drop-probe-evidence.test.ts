import { describe, expect, it } from "vitest";

import {
  bucketGatherDropProbeCount,
  bucketGatherDropProbeFacing,
  bucketGatherDropProbePosition,
} from "../e2e/gather-drop-probe-evidence.js";

describe("gather drop probe public evidence buckets", () => {
  const origin = { x: 0, y: 64, z: 0 };
  const target = { x: 1.5, y: 64.5, z: -4.5 };

  it("retains only coarse position classes", () => {
    expect(bucketGatherDropProbePosition(origin, origin, target)).toBe(
      "origin",
    );
    expect(
      bucketGatherDropProbePosition({ x: 1.5, y: 64.5, z: -3 }, origin, target),
    ).toBe("target_area");
    expect(
      bucketGatherDropProbePosition({ x: 0, y: 64, z: -7 }, origin, target),
    ).toBe("fixture_area");
    expect(
      bucketGatherDropProbePosition({ x: 40, y: 64, z: 40 }, origin, target),
    ).toBe("outside_fixture_area");
    expect(bucketGatherDropProbePosition(undefined, origin, target)).toBe(
      "unknown",
    );
  });

  it("buckets angle drift across wraparound", () => {
    expect(bucketGatherDropProbeFacing(179, -179, "degrees")).toBe("unchanged");
    expect(bucketGatherDropProbeFacing(0, Math.PI / 2, "radians")).toBe(
      "changed",
    );
    expect(bucketGatherDropProbeFacing(undefined, 0, "radians")).toBe(
      "unknown",
    );
  });

  it("classifies counts without retaining values", () => {
    expect(bucketGatherDropProbeCount(0)).toBe("zero");
    expect(bucketGatherDropProbeCount(1)).toBe("one_or_more");
    expect(bucketGatherDropProbeCount(undefined)).toBe("unknown");
    expect(bucketGatherDropProbeCount(-1)).toBe("unknown");
  });
});
