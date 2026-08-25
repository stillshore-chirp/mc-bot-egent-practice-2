import { describe, expect, it } from "vitest";
import { verifyGatherCompletion } from "../../src/verification/conditions.js";
import { diffSnapshots } from "../../src/verification/snapshot-diff.js";
import { createSnapshot } from "../support/fake-minecraft.js";

describe("Minecraft verification", () => {
  it("uses inventory increase rather than total inventory as gathered count", () => {
    const before = createSnapshot({
      inventory: [{ name: "oak_log", count: 5 }],
    });
    const after = createSnapshot({
      inventory: [{ name: "oak_log", count: 8 }],
    });
    expect(
      verifyGatherCompletion(before, after, "oak_log", 3, "owner", 3),
    ).toMatchObject({
      collectedCount: 3,
      heldCount: 8,
    });
    expect(() =>
      verifyGatherCompletion(before, after, "oak_log", 4, "owner", 3),
    ).toThrow("below requested count");
  });

  it("computes position and inventory deltas", () => {
    const before = createSnapshot({
      position: { x: 0, y: 64, z: 0 },
      inventory: [{ name: "oak_log", count: 1 }],
    });
    const after = createSnapshot({
      position: { x: 3, y: 64, z: 4 },
      inventory: [{ name: "oak_log", count: 3 }],
    });
    expect(diffSnapshots(before, after)).toMatchObject({
      movedDistance: 5,
      inventoryDelta: { oak_log: 2 },
    });
  });
});
