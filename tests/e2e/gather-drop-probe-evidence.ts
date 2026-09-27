import type {
  PlayerItemCollectionOutcome,
  PlayerItemCollectionPathFailureReason,
  PlayerOperation,
  PlayerOperationResult,
} from "../../src/minecraft/player-body.js";
import type { PlayerBodyObservation } from "../../src/minecraft/player-body-observation.js";

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
export type GatherDropProbeDeltaBucket =
  "unchanged" | "increased" | "decreased" | "unknown";
export type GatherDropProbeVisibleEntityBucket =
  "none" | "single" | "multiple" | "unknown";

export interface GatherOperationBodyObservationBuckets {
  readonly observed: boolean;
  readonly position: GatherDropProbePositionBucket;
  readonly birchBlockVisible: boolean | "unknown";
  readonly nearbyDropCount: GatherDropProbeVisibleEntityBucket;
  readonly requestedDropVisible: boolean | "not_applicable" | "unknown";
  readonly candidateSearchMayBeTruncated: boolean | "unknown";
  readonly birchInventoryCount: GatherDropProbeCountBucket;
}

export interface GatherOperationBodyTransitionBuckets {
  readonly before: GatherOperationBodyObservationBuckets;
  readonly after: GatherOperationBodyObservationBuckets;
  readonly facingChange: GatherDropProbeFacingBucket;
  readonly birchInventoryDelta: GatherDropProbeDeltaBucket;
}

export interface ScopedExecuteProbe {
  shouldCapture(operation: PlayerOperation): boolean;
  record(operation: PlayerOperation, result: PlayerOperationResult): void;
}

export interface GatherDropProbeOperationEvidence {
  readonly operationKind: "dig" | "collect_item";
  readonly targetMatchesFixtureTarget: boolean | "not_applicable";
  readonly status: PlayerOperationResult["status"];
  readonly itemCollectionOutcome:
    PlayerItemCollectionOutcome | "not_applicable" | "unknown";
  readonly pathFailureReason:
    PlayerItemCollectionPathFailureReason | "not_applicable" | "unknown";
  readonly recoveryRequired: boolean;
  readonly transition: GatherOperationBodyTransitionBuckets;
}

export interface GatherDropProbeCapture extends ScopedExecuteProbe {
  enable(): void;
  disable(): void;
  snapshot(): readonly GatherDropProbeOperationEvidence[];
  counts(): GatherDropProbeCaptureCounts;
}

export interface GatherDropProbeCaptureCounts {
  readonly attempted: number;
  readonly recorded: number;
  readonly overflow: number;
}

export const GATHER_DROP_PROBE_OPERATION_LIMIT = 4;

export async function withScopedExecuteProbeRestoration<T>(
  restore: (() => void) | undefined,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } finally {
    restore?.();
  }
}

/** Capture only coarse post-follow-up Body evidence, with no raw IDs or text. */
export function createGatherDropProbeCapture(input: {
  readonly origin: GatherDropProbePoint;
  readonly target: GatherDropProbePoint;
}): GatherDropProbeCapture {
  let enabled = false;
  let attemptedCount = 0;
  let reservedCount = 0;
  let overflowCount = 0;
  const evidence: GatherDropProbeOperationEvidence[] = [];
  return {
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    shouldCapture(operation) {
      if (
        !enabled ||
        (operation.kind !== "dig" && operation.kind !== "collect_item")
      ) {
        return false;
      }
      attemptedCount += 1;
      if (reservedCount >= GATHER_DROP_PROBE_OPERATION_LIMIT) {
        overflowCount += 1;
        return false;
      }
      reservedCount += 1;
      return true;
    },
    record(operation, result) {
      if (
        evidence.length >= GATHER_DROP_PROBE_OPERATION_LIMIT ||
        evidence.length >= reservedCount ||
        result.operation.kind !== operation.kind ||
        (operation.kind !== "dig" && operation.kind !== "collect_item")
      ) {
        return;
      }
      evidence.push({
        operationKind: operation.kind,
        targetMatchesFixtureTarget:
          operation.kind === "dig"
            ? samePoint(operation.position, input.target)
            : "not_applicable",
        status: result.status,
        itemCollectionOutcome:
          operation.kind === "collect_item"
            ? (result.itemCollectionOutcome ?? "unknown")
            : "not_applicable",
        pathFailureReason:
          operation.kind === "collect_item"
            ? (result.itemCollectionPathFailureReason ?? "unknown")
            : "not_applicable",
        recoveryRequired: result.recoveryRequired,
        transition: projectGatherOperationBodyTransition({
          before: result.before,
          after: result.after,
          origin: input.origin,
          target: input.target,
          ...(operation.kind === "collect_item"
            ? { requestedEntityId: operation.entityId }
            : {}),
        }),
      });
    },
    snapshot() {
      return evidence.slice();
    },
    counts() {
      return {
        attempted: attemptedCount,
        recorded: evidence.length,
        overflow: overflowCount,
      };
    },
  };
}

/** Flatten bounded evidence into scalar fields accepted by the safe artifact. */
export function flattenGatherDropProbeEvidence(
  samples: readonly GatherDropProbeOperationEvidence[],
  counts: GatherDropProbeCaptureCounts = {
    attempted: samples.length,
    recorded: samples.length,
    overflow: 0,
  },
): Readonly<Record<string, boolean | number | string>> {
  const bounded = samples.slice(0, GATHER_DROP_PROBE_OPERATION_LIMIT);
  const flattened: Record<string, boolean | number | string> = {
    bodyExecuteProbeOperationCount: bounded.length,
    bodyExecuteProbeAttemptedCount: counts.attempted,
    bodyExecuteProbeRecordedCount: counts.recorded,
    bodyExecuteProbeOverflowCount: counts.overflow,
    bodyExecuteProbeUnrecordedCount: Math.max(
      0,
      counts.attempted - counts.overflow - counts.recorded,
    ),
  };
  bounded.forEach((sample, index) => {
    const prefix = `bodyExecuteProbe${index + 1}`;
    flattened[`${prefix}OperationKind`] = sample.operationKind;
    flattened[`${prefix}TargetMatchesFixtureTarget`] =
      sample.targetMatchesFixtureTarget;
    flattened[`${prefix}Status`] = sample.status;
    flattened[`${prefix}ItemCollectionOutcome`] = sample.itemCollectionOutcome;
    flattened[`${prefix}PathFailureReason`] = sample.pathFailureReason;
    flattened[`${prefix}RecoveryRequired`] = sample.recoveryRequired;
    flattened[`${prefix}FacingChange`] = sample.transition.facingChange;
    flattened[`${prefix}BirchInventoryDelta`] =
      sample.transition.birchInventoryDelta;
    for (const stage of ["before", "after"] as const) {
      const observation = sample.transition[stage];
      flattened[`${prefix}${capitalize(stage)}Observed`] = observation.observed;
      flattened[`${prefix}${capitalize(stage)}PositionBucket`] =
        observation.position;
      flattened[`${prefix}${capitalize(stage)}BirchBlockVisible`] =
        observation.birchBlockVisible;
      flattened[`${prefix}${capitalize(stage)}NearbyDropCount`] =
        observation.nearbyDropCount;
      flattened[`${prefix}${capitalize(stage)}RequestedDropVisible`] =
        observation.requestedDropVisible;
      flattened[`${prefix}${capitalize(stage)}CandidateSearchMayBeTruncated`] =
        observation.candidateSearchMayBeTruncated;
      flattened[`${prefix}${capitalize(stage)}BirchInventoryCount`] =
        observation.birchInventoryCount;
    }
  });
  return flattened;
}

const scopedExecuteProbeMarker = Symbol("scopedExecuteProbe");
type AsyncMethod = (this: unknown, ...args: unknown[]) => Promise<unknown>;

/** Install one case-scoped wrapper and return an idempotent exact restore. */
export function installScopedExecuteProbe(
  prototype: object,
  getProbe: () => ScopedExecuteProbe | undefined,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "execute");
  if (typeof descriptor?.value !== "function")
    throw new Error("execute method is unavailable");
  const original = descriptor.value as AsyncMethod;
  if (Object.hasOwn(original, scopedExecuteProbeMarker))
    throw new Error("execute method is already wrapped");

  const wrapped: AsyncMethod = async function (
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const operation = args[0] as PlayerOperation;
    const probe = getProbe();
    if (!probe?.shouldCapture(operation)) return original.apply(this, args);
    const result = await original.apply(this, args);
    if (getProbe() === probe) {
      try {
        probe.record(operation, result as PlayerOperationResult);
      } catch {
        // Diagnostics must not change the operation result.
      }
    }
    return result;
  };
  Object.defineProperty(wrapped, scopedExecuteProbeMarker, { value: true });
  Object.defineProperty(prototype, "execute", {
    ...descriptor,
    value: wrapped,
  });

  let restored = false;
  return () => {
    if (restored) return;
    if (
      Object.getOwnPropertyDescriptor(prototype, "execute")?.value !== wrapped
    )
      throw new Error("execute method changed while probe was installed");
    Object.defineProperty(prototype, "execute", descriptor);
    restored = true;
  };
}

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

export function bucketGatherDropProbeCountDelta(
  before: number | undefined,
  after: number | undefined,
): GatherDropProbeDeltaBucket {
  if (
    before === undefined ||
    after === undefined ||
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after) ||
    before < 0 ||
    after < 0
  ) {
    return "unknown";
  }
  if (after === before) return "unchanged";
  return after > before ? "increased" : "decreased";
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function projectGatherOperationBodyTransition(input: {
  readonly before: PlayerBodyObservation | null;
  readonly after: PlayerBodyObservation | null;
  readonly origin: GatherDropProbePoint;
  readonly target: GatherDropProbePoint;
  readonly requestedEntityId?: number;
}): GatherOperationBodyTransitionBuckets {
  const before = projectObservation(
    input.before,
    input.origin,
    input.target,
    input.requestedEntityId,
  );
  const after = projectObservation(
    input.after,
    input.origin,
    input.target,
    input.requestedEntityId,
  );
  return {
    before: before.buckets,
    after: after.buckets,
    facingChange: bucketGatherDropProbeFacing(
      input.before?.self.yaw,
      input.after?.self.yaw,
      "radians",
    ),
    birchInventoryDelta: bucketGatherDropProbeCountDelta(
      before.inventoryCount,
      after.inventoryCount,
    ),
  };
}

function projectObservation(
  observation: PlayerBodyObservation | null,
  origin: GatherDropProbePoint,
  target: GatherDropProbePoint,
  requestedEntityId: number | undefined,
): {
  readonly buckets: GatherOperationBodyObservationBuckets;
  readonly inventoryCount: number | undefined;
} {
  if (observation === null) {
    return {
      buckets: {
        observed: false,
        position: "unknown",
        birchBlockVisible: "unknown",
        nearbyDropCount: "unknown",
        requestedDropVisible:
          requestedEntityId === undefined ? "not_applicable" : "unknown",
        candidateSearchMayBeTruncated: "unknown",
        birchInventoryCount: "unknown",
      },
      inventoryCount: undefined,
    };
  }
  const birchInventoryCount = observation.self.inventory
    .filter(({ name }) => name === "birch_log")
    .reduce((total, { count }) => total + count, 0);
  const nearbyDrops = observation.perception.entities.filter(
    ({ name, position }) => name === "item" && distance(position, target) <= 3,
  );
  return {
    buckets: {
      observed: true,
      position: bucketGatherDropProbePosition(
        observation.self.position,
        origin,
        target,
      ),
      birchBlockVisible: observation.perception.blocks.some(
        ({ name, position }) =>
          name === "birch_log" &&
          position.x === target.x &&
          position.y === target.y &&
          position.z === target.z,
      ),
      nearbyDropCount:
        nearbyDrops.length === 0
          ? "none"
          : nearbyDrops.length === 1
            ? "single"
            : "multiple",
      requestedDropVisible:
        requestedEntityId === undefined
          ? "not_applicable"
          : nearbyDrops.some(({ id }) => id === requestedEntityId),
      candidateSearchMayBeTruncated:
        observation.perception.candidateSearchMayBeTruncated,
      birchInventoryCount: bucketGatherDropProbeCount(birchInventoryCount),
    },
    inventoryCount: birchInventoryCount,
  };
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

function samePoint(
  left: GatherDropProbePoint,
  right: GatherDropProbePoint,
): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}
