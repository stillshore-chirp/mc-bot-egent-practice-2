import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";

export type SafeUnknownOperationKind =
  (typeof playerOperationNames)[number] | "unknown";

export interface UnknownTaskVisibilityEvidence {
  readonly status: "available" | "unknown";
  readonly targetBlockVisible?: boolean;
  readonly wallMaterialVisible?: boolean;
}

export type UnknownTargetDiscoveryActionKind =
  "look" | "look_sweep" | "move_to" | "move_relative";

export interface EntityRotation {
  readonly yaw: number;
  readonly pitch: number;
}

export type UnknownHandoffDependencyState =
  "not_started" | "pending" | "resumed";

// The fixture wall and task target are along +X; Java yaw -90 faces east (+X).
export const UNKNOWN_FIXTURE_YAW = -90;
export const UNKNOWN_FIXTURE_PITCH = 0;
const FACING_TOLERANCE_DEGREES = 2;

const knownOperationNames = new Set<string>(playerOperationNames);

export function safeUnknownOperationKind(
  value: string | undefined,
): SafeUnknownOperationKind {
  return value !== undefined && knownOperationNames.has(value)
    ? (value as SafeUnknownOperationKind)
    : "unknown";
}

/** Keep the controlled obstacle tied to the movement that made it eligible. */
export function isSameStartedTravelOperation(
  active:
    | {
        readonly kind: string;
        readonly operationId: string;
        readonly bodyStartedAt?: string;
      }
    | undefined,
  operationId: string,
): boolean {
  return (
    (active?.kind === "move_to" || active?.kind === "move_relative") &&
    active.operationId === operationId &&
    typeof active.bodyStartedAt === "string"
  );
}

export function unknownHandoffCaseBlockCode(
  caseId: string,
  state: UnknownHandoffDependencyState,
): "UNKNOWN_HANDOFF_DEPENDENCY_FAILED" | undefined {
  return caseId !== "unknown_composite" && state === "pending"
    ? "UNKNOWN_HANDOFF_DEPENDENCY_FAILED"
    : undefined;
}

export function classifyUnknownTaskVisibility(
  visibleBlockNames: readonly string[] | undefined,
): UnknownTaskVisibilityEvidence {
  if (visibleBlockNames === undefined) return { status: "unknown" };
  const normalizedNames = new Set(
    visibleBlockNames.map((name) =>
      name.toLowerCase().replace(/^minecraft:/u, ""),
    ),
  );
  return {
    status: "available",
    targetBlockVisible: normalizedNames.has("blue_wool"),
    wallMaterialVisible: normalizedNames.has("stone"),
  };
}

/** Require a hidden pre-task target, an AI Body view/move, then a fresh visible observation. */
export function unknownTargetDiscoveredAfterBodyAction(input: {
  readonly taskSentAt: number | undefined;
  readonly preTaskObservation:
    | {
        readonly observedAt?: string;
        readonly visibleBlockNames?: readonly string[];
      }
    | undefined;
  readonly preTaskActiveOperationIds: readonly string[];
  readonly outcomes: readonly {
    readonly operationId: string;
    readonly kind?: string;
    readonly status?: string;
    readonly observedAt?: string;
  }[];
  readonly observation:
    | {
        readonly observedAt?: string;
        readonly visibleBlockNames?: readonly string[];
      }
    | undefined;
}): UnknownTargetDiscoveryActionKind | undefined {
  const taskSentAt = input.taskSentAt;
  const preTaskAt = Date.parse(input.preTaskObservation?.observedAt ?? "");
  const observationAt = Date.parse(input.observation?.observedAt ?? "");
  const preTaskVisibility = classifyUnknownTaskVisibility(
    input.preTaskObservation?.visibleBlockNames,
  );
  const currentVisibility = classifyUnknownTaskVisibility(
    input.observation?.visibleBlockNames,
  );
  if (
    taskSentAt === undefined ||
    !Number.isFinite(taskSentAt) ||
    !Number.isFinite(preTaskAt) ||
    preTaskAt >= taskSentAt ||
    preTaskVisibility.status !== "available" ||
    preTaskVisibility.targetBlockVisible !== false ||
    !Number.isFinite(observationAt) ||
    observationAt <= taskSentAt ||
    currentVisibility.status !== "available" ||
    currentVisibility.targetBlockVisible !== true
  ) {
    return undefined;
  }

  const actionKinds: readonly UnknownTargetDiscoveryActionKind[] = [
    "look",
    "look_sweep",
    "move_to",
    "move_relative",
  ];
  const preTaskActiveOperationIds = new Set(input.preTaskActiveOperationIds);
  const action = input.outcomes.find((outcome) => {
    const outcomeAt = Date.parse(outcome.observedAt ?? "");
    return (
      !preTaskActiveOperationIds.has(outcome.operationId) &&
      actionKinds.includes(outcome.kind as UnknownTargetDiscoveryActionKind) &&
      outcome.status === "successful" &&
      Number.isFinite(outcomeAt) &&
      outcomeAt > taskSentAt &&
      outcomeAt < observationAt
    );
  });
  return action?.kind as UnknownTargetDiscoveryActionKind | undefined;
}

/** Unknown counts, missing pickup outcomes, and nonpositive deltas never pass. */
export function unknownTargetPickupConfirmed(input: {
  readonly targetRemoved: boolean | undefined;
  readonly inventoryDelta: number | undefined;
  readonly matchingTargetPickupEventObserved: boolean;
}): boolean {
  return (
    input.targetRemoved === true &&
    input.inventoryDelta !== undefined &&
    Number.isSafeInteger(input.inventoryDelta) &&
    input.inventoryDelta > 0 &&
    input.matchingTargetPickupEventObserved
  );
}

export function unknownTargetCollectionMatchesFreshBlueWool(input: {
  readonly operationKind: string | undefined;
  readonly status: string | undefined;
  readonly targetVisibleEntityId: number | undefined;
  readonly targetVisibleAt: string | undefined;
  readonly requestedEntityId: number | undefined;
  readonly pickupEntityId: number | undefined;
  readonly effectType: string | undefined;
  readonly effectEntityId: number | undefined;
  readonly collectedItemName: string | undefined;
  readonly taskSentAt: number | undefined;
  readonly operationStartedAt: string | undefined;
  readonly pickupObservedAt: string | undefined;
  readonly operationCompletedAt: string | undefined;
}): boolean {
  const taskSentAt = input.taskSentAt;
  const targetVisibleAt = Date.parse(input.targetVisibleAt ?? "");
  const operationStartedAt = Date.parse(input.operationStartedAt ?? "");
  const pickupObservedAt = Date.parse(input.pickupObservedAt ?? "");
  const operationCompletedAt = Date.parse(input.operationCompletedAt ?? "");
  return (
    input.operationKind === "collect_item" &&
    input.status === "successful" &&
    input.effectType === "item_collected" &&
    input.requestedEntityId !== undefined &&
    input.targetVisibleEntityId !== undefined &&
    input.targetVisibleEntityId === input.requestedEntityId &&
    input.pickupEntityId === input.requestedEntityId &&
    input.effectEntityId === input.requestedEntityId &&
    input.collectedItemName === "blue_wool" &&
    taskSentAt !== undefined &&
    Number.isFinite(taskSentAt) &&
    Number.isFinite(targetVisibleAt) &&
    targetVisibleAt >= taskSentAt &&
    Number.isFinite(operationStartedAt) &&
    operationStartedAt >= taskSentAt &&
    Number.isFinite(pickupObservedAt) &&
    pickupObservedAt >= targetVisibleAt &&
    pickupObservedAt >= operationStartedAt &&
    Number.isFinite(operationCompletedAt) &&
    pickupObservedAt <= operationCompletedAt
  );
}

export function hasNewOwnerProposalGoalForUnknownTask(input: {
  readonly previousProposalIds: readonly string[];
  readonly proposals: readonly {
    readonly id: string;
    readonly status?: string;
  }[];
  readonly goals: readonly {
    readonly source?: string;
    readonly status?: string;
    readonly ownerProposalId?: string;
    readonly updatedAt?: string;
  }[];
  readonly taskSentAt: number | undefined;
}): boolean {
  const taskSentAt = input.taskSentAt;
  if (taskSentAt === undefined || !Number.isFinite(taskSentAt)) return false;
  const previousIds = new Set(input.previousProposalIds);
  const acceptedNewProposalIds = new Set(
    input.proposals
      .filter(
        (proposal) =>
          !previousIds.has(proposal.id) &&
          (proposal.status === "adopted" || proposal.status === "compromised"),
      )
      .map((proposal) => proposal.id),
  );
  return input.goals.some((goal) => {
    const updatedAt = Date.parse(goal.updatedAt ?? "");
    return (
      goal.source === "owner" &&
      (goal.status === "active" || goal.status === "completed") &&
      goal.ownerProposalId !== undefined &&
      acceptedNewProposalIds.has(goal.ownerProposalId) &&
      Number.isFinite(updatedAt) &&
      updatedAt >= taskSentAt
    );
  });
}

export function parseEntityRotation(reply: string): EntityRotation | undefined {
  const match =
    /\[\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:[fFdD])?\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:[fFdD])?\s*\]\s*$/u.exec(
      reply.trim(),
    );
  if (match === null) return undefined;
  const yaw = Number(match[1]);
  const pitch = Number(match[2]);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return undefined;
  return { yaw, pitch };
}

export function isFacingUnknownFixture(
  rotation: EntityRotation | undefined,
): boolean {
  return (
    rotation !== undefined &&
    angularDistance(rotation.yaw, UNKNOWN_FIXTURE_YAW) <=
      FACING_TOLERANCE_DEGREES &&
    Math.abs(rotation.pitch - UNKNOWN_FIXTURE_PITCH) <= FACING_TOLERANCE_DEGREES
  );
}

function angularDistance(left: number, right: number): number {
  const normalized = ((((left - right) % 360) + 540) % 360) - 180;
  return Math.abs(normalized);
}
