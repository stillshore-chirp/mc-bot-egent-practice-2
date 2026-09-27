export interface GatherDropProbePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type GatherDropProbePositionBucket =
  | "origin"
  | "target_area"
  | "fixture_area"
  | "outside_fixture_area"
  | "unknown";

export type GatherDropProbeFacingBucket = "unchanged" | "changed" | "unknown";

export type GatherDropProbeCountBucket = "zero" | "one_or_more" | "unknown";

export function bucketGatherDropProbePosition(
  position: GatherDropProbePoint | undefined,
  origin: GatherDropProbePoint,
  target: GatherDropProbePoint,
): GatherDropProbePositionBucket {
  if (position === undefined || !isFinitePoint(position)) return "unknown";
  if (distance(position, origin) <= 1.5) return "origin";
  if (distance(position, target) <= 2.5) return "target_area";
  if (distance(position, origin) <= 10) return "fixture_area";
  return "outside_fixture_area";
}

/** Compare radians or degrees while retaining only a coarse movement bucket. */
export function bucketGatherDropProbeFacing(
  referenceAngle: number | undefined,
  currentAngle: number | undefined,
  unit: "radians" | "degrees",
): GatherDropProbeFacingBucket {
  if (
    referenceAngle === undefined ||
    currentAngle === undefined ||
    !Number.isFinite(referenceAngle) ||
    !Number.isFinite(currentAngle)
  ) {
    return "unknown";
  }
  const factor = unit === "radians" ? 1 : Math.PI / 180;
  const delta = Math.atan2(
    Math.sin((currentAngle - referenceAngle) * factor),
    Math.cos((currentAngle - referenceAngle) * factor),
  );
  return Math.abs(delta) <= Math.PI / 6 ? "unchanged" : "changed";
}

export function bucketGatherDropProbeCount(
  count: number | undefined,
): GatherDropProbeCountBucket {
  if (count === undefined || !Number.isSafeInteger(count) || count < 0)
    return "unknown";
  return count === 0 ? "zero" : "one_or_more";
}

function isFinitePoint(point: GatherDropProbePoint): boolean {
  return [point.x, point.y, point.z].every(Number.isFinite);
}

function distance(
  left: GatherDropProbePoint,
  right: GatherDropProbePoint,
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
