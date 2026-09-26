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
