import { describe, expect, it } from "vitest";

import {
  escapeTarget,
  nearestItemDropPosition,
} from "../../src/minecraft/mineflayer-client.js";

describe("Mineflayer deterministic safety policy", () => {
  it("chooses a normalized escape target away from nearby hostiles", () => {
    const target = escapeTarget(
      { x: 0, y: 64, z: 0 },
      [
        { x: 2, y: 64, z: 0 },
        { x: 0, y: 64, z: 2 },
      ],
      16,
    );

    expect(target).toBeDefined();
    expect(target?.x).toBeLessThan(0);
    expect(target?.z).toBeLessThan(0);
    expect(Math.hypot(target?.x ?? 0, target?.z ?? 0)).toBeCloseTo(16);
  });

  it("returns no target without an observed hostile", () => {
    expect(escapeTarget({ x: 0, y: 64, z: 0 }, [])).toBeUndefined();
  });

  it("moves perpendicular to symmetric hostiles instead of toward either one", () => {
    const target = escapeTarget(
      { x: 0, y: 64, z: 0 },
      [
        { x: 2, y: 64, z: 0 },
        { x: -2, y: 64, z: 0 },
      ],
      16,
    );

    expect(Math.abs(target?.x ?? 16)).toBeLessThan(0.01);
    expect(Math.abs(target?.z ?? 0)).toBeCloseTo(16);
  });

  it("does not move toward the nearest threat when farther threats are grouped opposite", () => {
    const origin = { x: 0, y: 64, z: 0 };
    const threats = [
      { x: 1, y: 64, z: 0 },
      { x: -7, y: 64, z: 1 },
      { x: -7, y: 64, z: -1 },
    ];
    const target = escapeTarget(origin, threats, 16);

    const nearestBefore = 1;
    const nearestAfter = Math.hypot((target?.x ?? 0) - 1, target?.z ?? 0);
    expect(nearestAfter).toBeGreaterThan(nearestBefore);
  });

  it("does not select a ray that passes close to an imminent hostile", () => {
    const origin = { x: 0, y: 64, z: 0 };
    const threats = [
      { x: -7, y: 64, z: -3 },
      { x: 0, y: 64, z: 1 },
      { x: 3, y: 64, z: -1 },
    ];
    const target = escapeTarget(origin, threats, 16);
    expect(target).toBeDefined();

    const segmentX = (target?.x ?? 0) - origin.x;
    const segmentZ = (target?.z ?? 0) - origin.z;
    const segmentLengthSquared = segmentX ** 2 + segmentZ ** 2;
    const closestApproach = threats.map((threat) => {
      const projection = Math.max(
        0,
        Math.min(
          1,
          ((threat.x - origin.x) * segmentX +
            (threat.z - origin.z) * segmentZ) /
            segmentLengthSquared,
        ),
      );
      return Math.hypot(
        origin.x + segmentX * projection - threat.x,
        origin.z + segmentZ * projection - threat.z,
      );
    });
    expect(Math.min(...closestApproach)).toBeGreaterThanOrEqual(1);
  });

  it("chooses a finite target when a threat shares the same horizontal position", () => {
    const target = escapeTarget(
      { x: 0, y: 64, z: 0 },
      [{ x: 0, y: 65, z: 0 }],
      16,
    );
    expect(target).toBeDefined();
    expect(Number.isFinite(target?.x)).toBe(true);
    expect(Number.isFinite(target?.z)).toBe(true);
    expect(Math.hypot(target?.x ?? 0, target?.z ?? 0)).toBeCloseTo(16);
  });
});

describe("Mineflayer item drop policy", () => {
  it("selects the nearest actual item inside the bounded dig area", () => {
    const selected = nearestItemDropPosition({ x: 0, y: 64, z: 0 }, "oak_log", [
      { itemName: undefined, position: { x: 0.1, y: 64, z: 0 } },
      { itemName: "jungle_log", position: { x: 1, y: 64, z: 0 } },
      { itemName: "oak_log", position: { x: 3, y: 64, z: 0 } },
      { itemName: "oak_log", position: { x: 2, y: 64, z: 0 } },
      { itemName: "oak_log", position: { x: 9, y: 64, z: 0 } },
    ]);

    expect(selected).toEqual({ x: 2, y: 64, z: 0 });
  });

  it("does not treat an unrelated object entity as an item drop", () => {
    expect(
      nearestItemDropPosition({ x: 0, y: 64, z: 0 }, "oak_log", [
        { itemName: undefined, position: { x: 1, y: 64, z: 0 } },
      ]),
    ).toBeUndefined();
  });
});
