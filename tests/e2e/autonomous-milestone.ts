export interface AutonomousMilestoneOutcome {
  readonly status?: string;
  readonly observedAt?: string;
}

export interface AutonomousMilestoneJudgment {
  readonly decidedAt?: string;
}

export interface StopHandoffOutcome {
  readonly operationId: string;
  readonly status?: string;
}

export interface StoppedHandoffBoundary {
  readonly stopped: boolean;
  readonly activeCleared: boolean;
  readonly stopGeneration: number;
  readonly previousStopGeneration: number;
  readonly terminalRequired: boolean;
  readonly operationId?: string;
  readonly outcomes: readonly StopHandoffOutcome[];
}

export const PARALLEL_OWNER_APPROACH_MINIMUM_REDUCTION = 0.25;

export type OwnerApproachReductionBucket =
  "none" | "under_minimum" | "minimum_met";

export interface StartedBodyOperationEvidence {
  readonly operationId?: string;
  readonly bodyStartedAt?: string;
}

export interface OwnerProposalEvidence {
  readonly id: string;
  readonly status?: string;
}

export interface OwnerGoalProposalEvidence {
  readonly ownerProposalId?: string;
  readonly source?: string;
  readonly status?: string;
}

export function ownerApproachReductionBucket(
  beforeDistance: number | undefined,
  currentDistance: number | undefined,
  minimumReduction = PARALLEL_OWNER_APPROACH_MINIMUM_REDUCTION,
): OwnerApproachReductionBucket {
  if (
    beforeDistance === undefined ||
    currentDistance === undefined ||
    !Number.isFinite(beforeDistance) ||
    !Number.isFinite(currentDistance) ||
    !Number.isFinite(minimumReduction) ||
    minimumReduction <= 0
  ) {
    return "none";
  }
  const reduction = beforeDistance - currentDistance;
  if (!Number.isFinite(reduction) || reduction <= 0) return "none";
  return reduction >= minimumReduction ? "minimum_met" : "under_minimum";
}

export function hasOwnerApproachWithStartedBodyOperation(
  beforeDistance: number | undefined,
  currentDistance: number | undefined,
  operation: StartedBodyOperationEvidence | undefined,
): boolean {
  return (
    ownerApproachReductionBucket(beforeDistance, currentDistance) ===
      "minimum_met" &&
    (operation?.operationId?.trim().length ?? 0) > 0 &&
    operation?.bodyStartedAt !== undefined &&
    Number.isFinite(Date.parse(operation.bodyStartedAt))
  );
}

export function hasNewActiveOwnerProposalGoal(
  previousProposalIds: readonly string[],
  proposals: readonly OwnerProposalEvidence[],
  goals: readonly OwnerGoalProposalEvidence[],
): boolean {
  const previousIds = new Set(previousProposalIds);
  const acceptedNewProposalIds = new Set(
    proposals
      .filter(
        (proposal) =>
          !previousIds.has(proposal.id) &&
          (proposal.status === "adopted" || proposal.status === "compromised"),
      )
      .map((proposal) => proposal.id),
  );
  return goals.some(
    (goal) =>
      goal.source === "owner" &&
      goal.status === "active" &&
      goal.ownerProposalId !== undefined &&
      acceptedNewProposalIds.has(goal.ownerProposalId),
  );
}

export function hasJudgmentAfterSuccessfulOutcome(
  outcomes: readonly AutonomousMilestoneOutcome[],
  judgments: readonly AutonomousMilestoneJudgment[],
): boolean {
  return outcomes.some((outcome) => {
    if (outcome.status !== "successful" || outcome.observedAt === undefined)
      return false;
    const outcomeAt = Date.parse(outcome.observedAt);
    return (
      Number.isFinite(outcomeAt) &&
      judgments.some((judgment) => {
        if (judgment.decidedAt === undefined) return false;
        const judgmentAt = Date.parse(judgment.decidedAt);
        return Number.isFinite(judgmentAt) && judgmentAt > outcomeAt;
      })
    );
  });
}

export function hasTerminalOutcomeForOperation(
  operationId: string,
  outcomes: readonly StopHandoffOutcome[],
): boolean {
  return outcomes.some(
    (outcome) =>
      outcome.operationId === operationId &&
      (outcome.status === "successful" ||
        outcome.status === "failed" ||
        outcome.status === "interrupted" ||
        outcome.status === "cancelled" ||
        outcome.status === "unverified"),
  );
}

export function hasCancellationOutcomeForOperation(
  operationId: string,
  outcomes: readonly StopHandoffOutcome[],
): boolean {
  return outcomes.some(
    (outcome) =>
      outcome.operationId === operationId &&
      (outcome.status === "interrupted" || outcome.status === "cancelled"),
  );
}

export function isStoppedHandoffBoundaryConfirmed(
  boundary: StoppedHandoffBoundary,
): boolean {
  const terminalConfirmed =
    !boundary.terminalRequired ||
    (boundary.operationId !== undefined &&
      hasTerminalOutcomeForOperation(boundary.operationId, boundary.outcomes));
  return (
    boundary.stopped &&
    boundary.activeCleared &&
    boundary.stopGeneration > boundary.previousStopGeneration &&
    terminalConfirmed
  );
}
