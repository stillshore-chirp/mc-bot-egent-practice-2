export const COMPANION_HOSTILE_FIXTURE_COUNT = 100;
export const COMPANION_HOSTILE_DETAIL_LIMIT = 16;
export const COMPANION_HOSTILE_PURPOSE_FIXTURE_COUNT = 4;
export const COMPANION_HOSTILE_PURPOSE_CASE_BUDGET = {
  llmCalls: 18,
  totalTokens: 160_000,
} as const;
export const COMPANION_HOSTILE_PURPOSE_CASE_DEADLINE_MS = 6 * 60_000;
export const COMPANION_HOSTILE_PURPOSE_RUN_BUDGET = {
  durationMs: 9 * 60_000,
  ...COMPANION_HOSTILE_PURPOSE_CASE_BUDGET,
} as const;

export function companionHostilePurposeModeAllowed(input: {
  readonly selected: boolean;
  readonly targetCase: string | undefined;
  readonly noGptDiagnosticSelected: boolean;
}): boolean {
  return (
    !input.selected ||
    (input.targetCase === "companion_intent_collection" &&
      !input.noGptDiagnosticSelected)
  );
}

export interface CompanionHostileObservationEvidence {
  readonly serverCountBefore: number;
  readonly serverCountAfter: number;
  readonly fixtureConfiguredAt: number;
  readonly requestSentAt: number;
  readonly observationAt: string;
  readonly nearbyHostilesObservedAt: string;
  readonly source: string;
  readonly aggregateSource: string;
  readonly countScope: string;
  readonly aggregateCount: number;
  readonly zombieCount: number;
  readonly worldAbsenceEstablished: boolean;
  readonly candidateLimit: number;
  readonly detailOutputLimit: number;
  readonly entityOutputLimit: number;
  readonly detailCount: number;
  readonly candidateSearchMayBeTruncated: boolean;
}

export function companionHostileObservationConfirmed(
  input: CompanionHostileObservationEvidence,
): boolean {
  const observationAt = Date.parse(input.observationAt);
  const nearbyObservedAt = Date.parse(input.nearbyHostilesObservedAt);
  return (
    input.serverCountBefore === 0 &&
    input.serverCountAfter === COMPANION_HOSTILE_FIXTURE_COUNT &&
    Number.isFinite(input.fixtureConfiguredAt) &&
    Number.isFinite(input.requestSentAt) &&
    input.requestSentAt >= input.fixtureConfiguredAt &&
    Number.isFinite(observationAt) &&
    observationAt >= input.fixtureConfiguredAt &&
    observationAt >= input.requestSentAt &&
    nearbyObservedAt === observationAt &&
    input.source === "client_received_unoccluded_nearby_hostiles" &&
    input.aggregateSource === "client_received_hostile_entity_candidates" &&
    input.countScope === "client_entity_table_within_max_distance" &&
    input.aggregateCount === COMPANION_HOSTILE_FIXTURE_COUNT &&
    input.zombieCount === COMPANION_HOSTILE_FIXTURE_COUNT &&
    !input.worldAbsenceEstablished &&
    input.candidateLimit >= COMPANION_HOSTILE_FIXTURE_COUNT &&
    input.detailOutputLimit === COMPANION_HOSTILE_DETAIL_LIMIT &&
    input.entityOutputLimit === COMPANION_HOSTILE_DETAIL_LIMIT &&
    input.detailCount <= COMPANION_HOSTILE_DETAIL_LIMIT &&
    !input.candidateSearchMayBeTruncated
  );
}

export interface CompanionHostilePurposeMoveEvidence {
  readonly requestSentAt: number;
  readonly judgment: {
    readonly kind?: string;
    readonly operationKind?: string;
    readonly decidedAt?: string;
  };
  readonly operation: {
    readonly kind: string;
    readonly status: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly sameLife?: boolean;
    readonly recoveryRequired: boolean;
  };
  readonly bodyCountBefore: number;
  readonly bodyCountAfter: number;
  readonly serverCountBefore: number;
  readonly serverCountAfter: number;
  readonly bodyDistanceBefore: number;
  readonly bodyDistanceAfter: number;
  readonly serverDistanceBefore: number;
  readonly serverDistanceAfter: number;
  readonly bodyServerDistanceAligned: boolean;
  readonly bodyServerPositionAligned: boolean;
  readonly bodyServerHealthAligned: boolean;
  readonly bodyHealthDidNotDecrease: boolean;
  readonly serverHealthDidNotDecrease: boolean;
}

export function companionHostilePurposeMoveConfirmed(
  input: CompanionHostilePurposeMoveEvidence,
): boolean {
  const decidedAt = Date.parse(input.judgment.decidedAt ?? "");
  const startedAt = Date.parse(input.operation.startedAt);
  const completedAt = Date.parse(input.operation.completedAt);
  const distances = [
    input.bodyDistanceBefore,
    input.bodyDistanceAfter,
    input.serverDistanceBefore,
    input.serverDistanceAfter,
  ];
  return (
    Number.isFinite(input.requestSentAt) &&
    Number.isFinite(decidedAt) &&
    Number.isFinite(startedAt) &&
    Number.isFinite(completedAt) &&
    decidedAt >= input.requestSentAt &&
    startedAt >= decidedAt &&
    startedAt >= input.requestSentAt &&
    completedAt >= startedAt &&
    input.judgment.kind === "act" &&
    input.judgment.operationKind === input.operation.kind &&
    (input.operation.kind === "move_to" ||
      input.operation.kind === "move_relative") &&
    input.operation.status === "successful" &&
    input.operation.sameLife === true &&
    !input.operation.recoveryRequired &&
    input.bodyCountBefore === COMPANION_HOSTILE_PURPOSE_FIXTURE_COUNT &&
    input.bodyCountAfter === COMPANION_HOSTILE_PURPOSE_FIXTURE_COUNT &&
    input.serverCountBefore === COMPANION_HOSTILE_PURPOSE_FIXTURE_COUNT &&
    input.serverCountAfter === COMPANION_HOSTILE_PURPOSE_FIXTURE_COUNT &&
    distances.every((distance) => Number.isFinite(distance) && distance >= 0) &&
    input.bodyDistanceBefore <= 6 &&
    input.bodyDistanceAfter >= input.bodyDistanceBefore + 0.75 &&
    input.serverDistanceAfter >= input.serverDistanceBefore + 0.75 &&
    input.bodyServerDistanceAligned &&
    input.bodyServerPositionAligned &&
    input.bodyServerHealthAligned &&
    input.bodyHealthDidNotDecrease &&
    input.serverHealthDidNotDecrease
  );
}

export interface CompanionHostileNextActionJudgment {
  readonly revision?: number;
  readonly decidedAt?: string;
  readonly kind?: string;
  readonly operationKind?: string;
}

export function companionHostileSameGoalNextActionObserved(input: {
  readonly goalIdBefore: string;
  readonly goalIdAfter: string | undefined;
  readonly goalStatusAfter: string | undefined;
  readonly afterRevision: number;
  readonly actionCompletedAt: string;
  readonly judgments: readonly CompanionHostileNextActionJudgment[];
}): boolean {
  const actionCompletedAt = Date.parse(input.actionCompletedAt);
  if (
    input.goalIdBefore.trim().length === 0 ||
    input.goalIdAfter !== input.goalIdBefore ||
    input.goalStatusAfter !== "active" ||
    !Number.isSafeInteger(input.afterRevision) ||
    !Number.isFinite(actionCompletedAt)
  ) {
    return false;
  }
  return input.judgments.some(
    ({ revision, decidedAt, kind, operationKind }) => {
      const judgmentAt = Date.parse(decidedAt ?? "");
      return (
        revision !== undefined &&
        revision > input.afterRevision &&
        Number.isFinite(judgmentAt) &&
        judgmentAt >= actionCompletedAt &&
        kind === "act" &&
        typeof operationKind === "string" &&
        operationKind.trim().length > 0
      );
    },
  );
}

export interface CompanionOwnerGoal {
  readonly ownerProposalId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly source?: string;
  readonly updatedAt?: string;
}

export interface CompanionOwnerProposal {
  readonly id: string;
  readonly status?: string;
}

export interface CompanionOwnerJudgment {
  readonly proposalId?: string;
  readonly proposalDisposition?: string;
}

export function ownerGoalAndObservationFreshAfterRequest(input: {
  readonly goalId: string | undefined;
  readonly expectedGoalId: string;
  readonly goalUpdatedAt: string | undefined;
  readonly observationAt: number | undefined;
  readonly requestSentAt: number;
}): boolean {
  const goalUpdatedAt = Date.parse(input.goalUpdatedAt ?? "");
  return (
    input.goalId === input.expectedGoalId &&
    Number.isFinite(input.requestSentAt) &&
    Number.isFinite(goalUpdatedAt) &&
    goalUpdatedAt >= input.requestSentAt &&
    input.observationAt !== undefined &&
    Number.isFinite(input.observationAt) &&
    input.observationAt >= input.requestSentAt
  );
}

function resolvedProposalIds(input: {
  readonly proposals: readonly CompanionOwnerProposal[];
  readonly judgments: readonly CompanionOwnerJudgment[];
}): ReadonlySet<string> {
  return new Set([
    ...input.proposals
      .filter(({ status }) => status === "adopted" || status === "compromised")
      .map(({ id }) => id),
    ...input.judgments.flatMap(({ proposalId, proposalDisposition }) =>
      proposalId !== undefined &&
      (proposalDisposition === "adopted" ||
        proposalDisposition === "compromised")
        ? [proposalId]
        : [],
    ),
  ]);
}

export function freshResolvedOwnerWoodGoalCount(input: {
  readonly goals: readonly CompanionOwnerGoal[];
  readonly proposals: readonly CompanionOwnerProposal[];
  readonly judgments: readonly CompanionOwnerJudgment[];
  readonly updatedAfter: number;
}): number {
  const acceptedProposals = resolvedProposalIds(input);
  return input.goals.filter(
    ({ ownerProposalId, source, status, title, updatedAt }) => {
      const updatedAtMs = Date.parse(updatedAt ?? "");
      return (
        ownerProposalId !== undefined &&
        acceptedProposals.has(ownerProposalId) &&
        source === "owner" &&
        status === "active" &&
        /oak|wood|tree|log|オーク|木材|原木|木/iu.test(title ?? "") &&
        Number.isFinite(updatedAtMs) &&
        updatedAtMs >= input.updatedAfter
      );
    },
  ).length;
}

/** Return a quantity only when one fresh, resolved owner goal describes wood. */
export function singleFreshWoodGoalQuantity(input: {
  readonly goals: readonly CompanionOwnerGoal[];
  readonly proposals: readonly CompanionOwnerProposal[];
  readonly judgments: readonly CompanionOwnerJudgment[];
  readonly updatedAfter: number;
}): number | undefined {
  const acceptedProposals = resolvedProposalIds(input);
  const goals = input.goals.filter(
    ({ ownerProposalId, source, status, title }) =>
      ownerProposalId !== undefined &&
      acceptedProposals.has(ownerProposalId) &&
      source === "owner" &&
      status === "active" &&
      /oak|wood|tree|log|オーク|木材|原木|木/iu.test(title ?? ""),
  );
  if (goals.length !== 1) return undefined;
  const goal = goals[0];
  if (goal === undefined) return undefined;
  const updatedAt = Date.parse(goal.updatedAt ?? "");
  if (!Number.isFinite(updatedAt) || updatedAt < input.updatedAfter)
    return undefined;
  const title = (goal.title ?? "").normalize("NFKC");
  const quantities = [
    ...title.matchAll(
      /(?:^|[^0-9])([0-9]{1,7})\s*(?:個|つ|本|枚|ブロック)(?=\s|$|[^0-9])/giu,
    ),
    ...title.matchAll(
      /\b([0-9]{1,7})\s+(?:(?:oak|birch)\s+)?(?:wood|logs?|blocks?|items?|trees?)\b/giu,
    ),
  ];
  if (quantities.length !== 1) return undefined;
  const count = Number(quantities[0]?.[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

export interface CompanionCollectionOutcome {
  readonly operationId: string;
  readonly kind?: string;
  readonly status?: string;
  readonly observedAt?: string;
}

export interface CompanionGoalJudgment {
  readonly kind?: string;
  readonly decidedAt?: string;
}

export function bodyOakLogInventoryCount(
  inventory: readonly { readonly name: string; readonly count: number }[],
): number {
  return inventory.reduce(
    (total, item) =>
      item.name === "oak_log" &&
      Number.isSafeInteger(item.count) &&
      item.count > 0
        ? total + item.count
        : total,
    0,
  );
}

export function completionJudgmentObservedAfter(input: {
  readonly judgments: readonly CompanionGoalJudgment[];
  readonly achievedAt: number;
}): boolean {
  if (!Number.isFinite(input.achievedAt)) return false;
  return input.judgments.some(({ kind, decidedAt }) => {
    const timestamp = Date.parse(decidedAt ?? "");
    return (
      kind === "complete" &&
      Number.isFinite(timestamp) &&
      timestamp >= input.achievedAt
    );
  });
}

export function successfulCollectionActionObservedAfter(input: {
  readonly outcomes: readonly CompanionCollectionOutcome[];
  readonly previousOperationIds: ReadonlySet<string>;
  readonly requestSentAt: number;
}): boolean {
  if (!Number.isFinite(input.requestSentAt)) return false;
  const seen = new Set<string>();
  return input.outcomes.some((outcome) => {
    const observedAt = Date.parse(outcome.observedAt ?? "");
    if (
      outcome.operationId.trim().length === 0 ||
      seen.has(outcome.operationId) ||
      input.previousOperationIds.has(outcome.operationId) ||
      (outcome.kind !== "dig" && outcome.kind !== "collect_item") ||
      outcome.status !== "successful" ||
      !Number.isFinite(observedAt) ||
      observedAt <= input.requestSentAt
    ) {
      return false;
    }
    seen.add(outcome.operationId);
    return true;
  });
}

export interface CompanionIntentCollectionProgressEvidence {
  readonly successfulBodyCollectionAfterFollowup: boolean;
  readonly inventoryThresholdAchievedAt: number | undefined;
  /** Recorded for diagnosis only; the owner's goal does not constrain source blocks. */
  readonly fixtureLogRemovedFromInitial: number | undefined;
}

export function companionIntentCollectionProgressConfirmed(
  input: CompanionIntentCollectionProgressEvidence,
): boolean {
  return (
    input.successfulBodyCollectionAfterFollowup &&
    input.inventoryThresholdAchievedAt !== undefined &&
    Number.isFinite(input.inventoryThresholdAchievedAt)
  );
}
