import { describe, expect, it } from "vitest";
import {
  assessDescentRoute,
  type DescentWaypoint,
} from "../../src/decision/safe-descent.js";

const origin = { x: 0, y: 68, z: 0 };
const landing = (
  y: number,
  changes: Partial<DescentWaypoint> = {},
): DescentWaypoint => ({
  position: { x: 1, y, z: 0 },
  observed: true,
  landingSafe: true,
  hostileDistance: null,
  ...changes,
});

describe("safe descent decision", () => {
  it("permits one observed short fall with ample remaining health", () => {
    expect(assessDescentRoute(origin, 20, [landing(64)])).toEqual({
      allowed: true,
      predictedMaxDamage: 2,
    });
  });

  it.each([
    [landing(62), "drop_too_high"],
    [landing(64, { observed: false }), "route_unobserved"],
    [landing(64, { landingSafe: false }), "landing_unsafe"],
    [landing(64, { hostileDistance: 3 }), "hostile_nearby"],
    [landing(66), "no_descent"],
  ] as const)("rejects an unsafe route for %s", (waypoint, reason) => {
    expect(assessDescentRoute(origin, 20, [waypoint])).toMatchObject({
      allowed: false,
      reason,
    });
  });

  it("rejects a fall when the conservative damage estimate leaves too little health", () => {
    expect(assessDescentRoute(origin, 15, [landing(64)])).toMatchObject({
      allowed: false,
      reason: "health_too_low",
    });
  });

  it("budgets repeated falls across the whole route", () => {
    const route = [
      landing(64),
      { ...landing(60), position: { x: 2, y: 60, z: 0 } },
      { ...landing(56), position: { x: 3, y: 56, z: 0 } },
    ];
    expect(assessDescentRoute(origin, 20, route)).toMatchObject({
      allowed: false,
      reason: "health_too_low",
      predictedMaxDamage: 6,
    });
  });
});
