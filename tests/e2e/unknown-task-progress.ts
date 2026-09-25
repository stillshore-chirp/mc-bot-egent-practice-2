export interface ProgressPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ProgressWorldSnapshot {
  readonly position: ProgressPosition;
  readonly blockRegionChanged: boolean;
  readonly inventorySignature: string;
}

export type UnknownProgressKind = "blocks" | "position" | "inventory";
export type UnknownDistanceBucket =
  "under_2" | "2_to_under_5" | "5_to_under_10" | "10_or_more";
export type UnknownTaskProgressSampleStatus =
  "not_sampled" | "available" | "unavailable" | "partial" | "capped";

export interface UnknownTaskProgressAggregate {
  readonly sampleCount: number;
  readonly sampleLimitReached: boolean;
  readonly maxDisplacementBucket: UnknownDistanceBucket;
  readonly nearestTargetDistanceBucket: UnknownDistanceBucket;
  readonly movedCloserToTarget: boolean;
  readonly blocksObserved: boolean;
  readonly positionObserved: boolean;
  readonly inventoryObserved: boolean;
}

export interface UnknownTaskProgressSample {
  readonly taskSentAt: number | undefined;
  readonly sampledAt: number;
  readonly startingPosition: ProgressPosition;
  readonly targetPosition: ProgressPosition;
  readonly currentPosition: ProgressPosition;
  readonly beforeWorld: ProgressWorldSnapshot;
  readonly currentWorld: ProgressWorldSnapshot;
}

const MAX_SAMPLE_COUNT = 64;
const MIN_POSITION_PROGRESS_DISTANCE = 1.25;
const MIN_CLOSER_DISTANCE = 0.25;
const DISTANCE_BUCKETS: readonly UnknownDistanceBucket[] = [
  "under_2",
  "2_to_under_5",
  "5_to_under_10",
  "10_or_more",
];

export function recordUnknownTaskProgressSample(
  previous: UnknownTaskProgressAggregate | undefined,
  sample: UnknownTaskProgressSample,
): UnknownTaskProgressAggregate | undefined {
  if (
    sample.taskSentAt === undefined ||
    !Number.isFinite(sample.taskSentAt) ||
    !Number.isFinite(sample.sampledAt) ||
    sample.sampledAt <= sample.taskSentAt
  ) {
    return previous;
  }

  const displacement = distance(
    sample.startingPosition,
    sample.currentPosition,
  );
  const initialTargetDistance = distance(
    sample.startingPosition,
    sample.targetPosition,
  );
  const currentTargetDistance = distance(
    sample.currentPosition,
    sample.targetPosition,
  );
  if (
    displacement === undefined ||
    initialTargetDistance === undefined ||
    currentTargetDistance === undefined
  ) {
    return previous;
  }

  const displacementBucket = distanceBucket(displacement);
  const targetDistanceBucket = distanceBucket(currentTargetDistance);
  const kinds = progressKinds(sample.beforeWorld, sample.currentWorld);
  const sampleCount = Math.min(
    (previous?.sampleCount ?? 0) + 1,
    MAX_SAMPLE_COUNT,
  );
  return {
    sampleCount,
    sampleLimitReached:
      sampleCount === MAX_SAMPLE_COUNT || previous?.sampleLimitReached === true,
    maxDisplacementBucket: maxBucket(
      previous?.maxDisplacementBucket,
      displacementBucket,
    ),
    nearestTargetDistanceBucket: minBucket(
      previous?.nearestTargetDistanceBucket,
      targetDistanceBucket,
    ),
    movedCloserToTarget:
      previous?.movedCloserToTarget === true ||
      currentTargetDistance < initialTargetDistance - MIN_CLOSER_DISTANCE,
    blocksObserved:
      previous?.blocksObserved === true || kinds.includes("blocks"),
    positionObserved:
      previous?.positionObserved === true || kinds.includes("position"),
    inventoryObserved:
      previous?.inventoryObserved === true || kinds.includes("inventory"),
  };
}

function progressKinds(
  before: ProgressWorldSnapshot,
  current: ProgressWorldSnapshot,
): readonly UnknownProgressKind[] {
  const kinds: UnknownProgressKind[] = [];
  if (!before.blockRegionChanged && current.blockRegionChanged)
    kinds.push("blocks");
  const positionDistance = distance(before.position, current.position);
  if (
    positionDistance !== undefined &&
    positionDistance >= MIN_POSITION_PROGRESS_DISTANCE
  ) {
    kinds.push("position");
  }
  if (before.inventorySignature !== current.inventorySignature)
    kinds.push("inventory");
  return kinds;
}

function distance(
  left: ProgressPosition,
  right: ProgressPosition,
): number | undefined {
  if (
    ![left.x, left.y, left.z, right.x, right.y, right.z].every(Number.isFinite)
  ) {
    return undefined;
  }
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function distanceBucket(distanceValue: number): UnknownDistanceBucket {
  if (distanceValue < 2) return "under_2";
  if (distanceValue < 5) return "2_to_under_5";
  if (distanceValue < 10) return "5_to_under_10";
  return "10_or_more";
}

function bucketRank(bucket: UnknownDistanceBucket): number {
  return DISTANCE_BUCKETS.indexOf(bucket);
}

function maxBucket(
  previous: UnknownDistanceBucket | undefined,
  current: UnknownDistanceBucket,
): UnknownDistanceBucket {
  return previous !== undefined && bucketRank(previous) > bucketRank(current)
    ? previous
    : current;
}

function minBucket(
  previous: UnknownDistanceBucket | undefined,
  current: UnknownDistanceBucket,
): UnknownDistanceBucket {
  return previous !== undefined && bucketRank(previous) < bucketRank(current)
    ? previous
    : current;
}
