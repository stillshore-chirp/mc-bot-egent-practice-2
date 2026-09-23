import type { Position } from "../domain/snapshot.js";

export const safeDescentLimits = {
  maxDrop: 5,
  maxPredictedDamage: 4,
  minimumRemainingHealth: 14,
  hostileClearance: 8,
} as const;

export type DescentBlockReason =
  | "route_unobserved"
  | "landing_unsafe"
  | "hostile_nearby"
  | "drop_too_high"
  | "health_too_low"
  | "no_descent";

export interface DescentWaypoint {
  readonly position: Position;
  readonly observed: boolean;
  readonly landingSafe: boolean;
  readonly hostileDistance: number | null;
}

export type DescentDecision =
  | { readonly allowed: true; readonly predictedMaxDamage: number }
  | {
      readonly allowed: false;
      readonly reason: DescentBlockReason;
      readonly predictedMaxDamage: number;
    };

/**
 * This deliberately overestimates ordinary fall damage by one health point
 * per drop. It never subtracts for armor, enchantments, water, or effects.
 */
export function assessDescentRoute(
  origin: Position,
  health: number,
  waypoints: readonly DescentWaypoint[],
): DescentDecision {
  if (
    !Number.isFinite(health) ||
    health <= 0 ||
    waypoints.length === 0 ||
    waypoints.length > 64
  ) {
    return {
      allowed: false,
      reason: "route_unobserved",
      predictedMaxDamage: 0,
    };
  }
  let previous = origin;
  let predictedMaxDamage = 0;
  let hasDescent = false;
  for (const waypoint of waypoints) {
    const next = waypoint.position;
    if (
      !waypoint.observed ||
      ![next.x, next.y, next.z].every(Number.isFinite) ||
      Math.abs(next.x - previous.x) > 1 ||
      Math.abs(next.z - previous.z) > 1
    ) {
      return { allowed: false, reason: "route_unobserved", predictedMaxDamage };
    }
    if (!waypoint.landingSafe) {
      return { allowed: false, reason: "landing_unsafe", predictedMaxDamage };
    }
    if (
      waypoint.hostileDistance !== null &&
      waypoint.hostileDistance < safeDescentLimits.hostileClearance
    ) {
      return { allowed: false, reason: "hostile_nearby", predictedMaxDamage };
    }
    const drop = previous.y - next.y;
    if (drop > safeDescentLimits.maxDrop) {
      return { allowed: false, reason: "drop_too_high", predictedMaxDamage };
    }
    if (drop > 2) {
      hasDescent = true;
      predictedMaxDamage += Math.ceil(drop - 2);
    }
    previous = next;
  }
  if (!hasDescent) {
    return { allowed: false, reason: "no_descent", predictedMaxDamage };
  }
  if (
    predictedMaxDamage > safeDescentLimits.maxPredictedDamage ||
    health - predictedMaxDamage < safeDescentLimits.minimumRemainingHealth
  ) {
    return { allowed: false, reason: "health_too_low", predictedMaxDamage };
  }
  return { allowed: true, predictedMaxDamage };
}
