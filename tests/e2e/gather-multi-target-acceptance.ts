import type { GatherDropReadbackClass } from "./gather-drop-readback.js";

export const GATHER_MULTI_TARGET_ITEMS = ["oak_log", "birch_log"] as const;
export type GatherMultiTargetItem = (typeof GATHER_MULTI_TARGET_ITEMS)[number];

export interface GatherMultiTargetOracleSample {
  readonly blockPresent: Readonly<Record<GatherMultiTargetItem, boolean>>;
  readonly inventoryCount: Readonly<Record<GatherMultiTargetItem, number>>;
  readonly completedGatherCount: number;
}

export interface GatherOperationOutcome {
  readonly operationId?: string | undefined;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly observedAt?: string | undefined;
}

export interface GatherMultiTargetContinuityDiagnostic {
  readonly caseStarted: boolean;
  readonly fixtureConfigured: boolean;
  readonly freshBodyObservationConfirmed: boolean;
  readonly initialOwnerRequestObserved: boolean;
  readonly shortFollowupSent: boolean;
  readonly followupOwnerIntentObserved: boolean;
  readonly followupOwnerResolutionObserved: boolean;
  readonly firstTargetServerAndBodyProgressObserved: boolean;
  /** A new dig judgment was observed after follow-up; no owner-goal link is implied. */
  readonly postFollowupDigJudgmentObserved: boolean;
  /** A post-follow-up dig judgment preceded the second successful dig/pickup pair. */
  readonly postFollowupDigJudgmentBeforeSecondTargetObserved: boolean;
  readonly secondTargetGatherPairObserved: boolean;
  readonly secondTargetServerAndBodyProgressObserved: boolean;
  readonly fixtureCleanupConfirmed: boolean;
  readonly oakDropReadbackClass: GatherDropReadbackClass;
  readonly birchDropReadbackClass: GatherDropReadbackClass;
}

export interface GatherActionPairTimes {
  readonly digAt: number;
  readonly pickupAt: number;
}

export interface GatherOwnerProposalSummary {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
}

export interface GatherOwnerGoalSummary {
  readonly ownerProposalId?: string;
  readonly title?: string;
  readonly source?: string;
  readonly status?: string;
}

export interface GatherOwnerJudgmentSummary {
  readonly proposalId?: string;
  readonly proposalDisposition?: string;
}

export interface GatherMultiTargetJudgment {
  readonly revision?: number | undefined;
  readonly decidedAt?: string | undefined;
  readonly kind?: string | undefined;
  readonly operationKind?: string | undefined;
}

export function gatherMultiTargetPassEvidence(
  diagnostic: GatherMultiTargetContinuityDiagnostic,
  completedBodyGatherCount: number,
): Readonly<Record<string, boolean | number | string>> {
  return { ...diagnostic, completedBodyGatherCount };
}

/** Require a newly created proposal or its linked goal to name the follow-up target. */
export function newBirchGatherProposalIds(input: {
  readonly proposals: readonly GatherOwnerProposalSummary[];
  readonly goals: readonly GatherOwnerGoalSummary[];
  readonly previousProposalIds: ReadonlySet<string>;
}): readonly string[] {
  const namesBirch = (title: string | undefined): boolean =>
    /\bbirch(?:_log)?\b|白樺|しらかば|シラカバ/iu.test(title ?? "");
  return input.proposals
    .filter(
      (proposal) =>
        !input.previousProposalIds.has(proposal.id) &&
        (namesBirch(proposal.title) ||
          input.goals.some(
            (goal) =>
              goal.ownerProposalId === proposal.id && namesBirch(goal.title),
          )),
    )
    .map(({ id }) => id);
}

export function hasNewBirchGatherIntent(input: {
  readonly proposals: readonly GatherOwnerProposalSummary[];
  readonly goals: readonly GatherOwnerGoalSummary[];
  readonly previousProposalIds: ReadonlySet<string>;
}): boolean {
  return newBirchGatherProposalIds(input).length > 0;
}

export function hasResolvedBirchGatherOwnerGoal(input: {
  readonly proposals: readonly GatherOwnerProposalSummary[];
  readonly judgments: readonly GatherOwnerJudgmentSummary[];
  readonly goals: readonly GatherOwnerGoalSummary[];
  readonly proposalIds: ReadonlySet<string>;
}): boolean {
  const resolvedProposalIds = new Set([
    ...input.proposals
      .filter(
        ({ id, status }) =>
          input.proposalIds.has(id) &&
          (status === "adopted" || status === "compromised"),
      )
      .map(({ id }) => id),
    ...input.judgments
      .filter(
        ({ proposalId, proposalDisposition }) =>
          proposalId !== undefined &&
          input.proposalIds.has(proposalId) &&
          (proposalDisposition === "adopted" ||
            proposalDisposition === "compromised"),
      )
      .map(({ proposalId }) => proposalId),
  ]);
  return input.goals.some(
    ({ ownerProposalId, source, status }) =>
      ownerProposalId !== undefined &&
      resolvedProposalIds.has(ownerProposalId) &&
      source === "owner" &&
      (status === "active" || status === "completed"),
  );
}

/** Pairs successful dig -> later pickup outcomes in observed order. */
export function successfulGatherActionPairs(
  outcomes: readonly GatherOperationOutcome[],
): readonly GatherActionPairTimes[] {
  const digTimes = outcomes
    .filter(({ kind, status }) => kind === "dig" && status === "successful")
    .map(({ observedAt }) => Date.parse(observedAt ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const pickupTimes = outcomes
    .filter(
      ({ kind, status }) => kind === "collect_item" && status === "successful",
    )
    .map(({ observedAt }) => Date.parse(observedAt ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  let pickupIndex = 0;
  const pairs: GatherActionPairTimes[] = [];
  for (const digTime of digTimes) {
    while (pickupIndex < pickupTimes.length) {
      const pickupTime = pickupTimes[pickupIndex];
      if (pickupTime === undefined || pickupTime > digTime) break;
      pickupIndex += 1;
    }
    if (pickupIndex < pickupTimes.length) {
      const pickupTime = pickupTimes[pickupIndex];
      if (pickupTime !== undefined)
        pairs.push({ digAt: digTime, pickupAt: pickupTime });
      pickupIndex += 1;
    }
  }
  return pairs;
}

/** Counts only successful dig -> pickup pairs with distinct pickup outcomes. */
export function countCompletedGatherActions(
  outcomes: readonly GatherOperationOutcome[],
): number {
  return successfulGatherActionPairs(outcomes).length;
}

export function identifyFirstGatheredTarget(
  sample: GatherMultiTargetOracleSample,
  baseline: Readonly<Record<GatherMultiTargetItem, number>>,
): GatherMultiTargetItem | undefined {
  if (sample.completedGatherCount < 1) return undefined;

  for (const item of GATHER_MULTI_TARGET_ITEMS) {
    const remaining = GATHER_MULTI_TARGET_ITEMS.find(
      (candidate) => candidate !== item,
    );
    if (
      remaining !== undefined &&
      !sample.blockPresent[item] &&
      sample.inventoryCount[item] === baseline[item] + 1 &&
      sample.blockPresent[remaining] &&
      sample.inventoryCount[remaining] === baseline[remaining]
    ) {
      return item;
    }
  }
  return undefined;
}

export function confirmsSecondGatheredTarget(input: {
  readonly sample: GatherMultiTargetOracleSample;
  readonly baseline: Readonly<Record<GatherMultiTargetItem, number>>;
  readonly postFollowupDigJudgmentBeforeSecondTargetObserved: boolean;
  readonly secondTargetGatherPairObserved: boolean;
}): boolean {
  return (
    input.postFollowupDigJudgmentBeforeSecondTargetObserved &&
    input.secondTargetGatherPairObserved &&
    input.sample.completedGatherCount >= 2 &&
    GATHER_MULTI_TARGET_ITEMS.every(
      (item) =>
        !input.sample.blockPresent[item] &&
        input.sample.inventoryCount[item] === input.baseline[item] + 1,
    )
  );
}

export function gatherMultiTargetJudgmentKey(
  judgment: GatherMultiTargetJudgment,
): string {
  return `${judgment.revision ?? ""}:${judgment.decidedAt ?? ""}`;
}

/** Observe a new post-follow-up dig judgment without claiming proposal causality. */
export function hasNewPostFollowupDigJudgment(
  judgments: readonly GatherMultiTargetJudgment[],
  previousJudgmentKeys: ReadonlySet<string>,
  followupSentAt: string | undefined,
): boolean {
  const followupTime = Date.parse(followupSentAt ?? "");
  if (!Number.isFinite(followupTime)) return false;
  return hasNewPostFollowupDigJudgmentInWindow(
    judgments,
    previousJudgmentKeys,
    followupTime,
  );
}

/**
 * Confirms temporal evidence before the second dig without claiming that the
 * judgment is causally linked to an owner proposal.
 */
export function hasNewPostFollowupDigJudgmentBeforeSecondDig(input: {
  readonly judgments: readonly GatherMultiTargetJudgment[];
  readonly previousJudgmentKeys: ReadonlySet<string>;
  readonly followupSentAt: string | undefined;
  readonly secondDigAt: string | undefined;
}): boolean {
  const followupTime = Date.parse(input.followupSentAt ?? "");
  const secondDigTime = Date.parse(input.secondDigAt ?? "");
  if (
    !Number.isFinite(followupTime) ||
    !Number.isFinite(secondDigTime) ||
    followupTime >= secondDigTime
  ) {
    return false;
  }
  return hasNewPostFollowupDigJudgmentInWindow(
    input.judgments,
    input.previousJudgmentKeys,
    followupTime,
    secondDigTime,
  );
}

/** Return successful dig/pickup pairs first observed after the follow-up. */
export function postFollowupGatherActionPairs(input: {
  readonly outcomes: readonly GatherOperationOutcome[];
  readonly previousOutcomeIds: ReadonlySet<string>;
  readonly followupSentAt: string | undefined;
}): readonly GatherActionPairTimes[] {
  const followupTime = Date.parse(input.followupSentAt ?? "");
  if (!Number.isFinite(followupTime)) return [];
  const postFollowupOutcomes = input.outcomes.filter(
    (outcome) =>
      outcome.operationId !== undefined &&
      !input.previousOutcomeIds.has(outcome.operationId),
  );
  return successfulGatherActionPairs(postFollowupOutcomes).filter(
    ({ digAt, pickupAt }) => followupTime < digAt && digAt < pickupAt,
  );
}

function hasNewPostFollowupDigJudgmentInWindow(
  judgments: readonly GatherMultiTargetJudgment[],
  previousJudgmentKeys: ReadonlySet<string>,
  followupTime: number,
  beforeTime = Number.POSITIVE_INFINITY,
): boolean {
  return judgments.some((judgment) => {
    const decidedAt = Date.parse(judgment.decidedAt ?? "");
    return (
      judgment.kind === "act" &&
      judgment.operationKind === "dig" &&
      !previousJudgmentKeys.has(gatherMultiTargetJudgmentKey(judgment)) &&
      Number.isFinite(decidedAt) &&
      followupTime < decidedAt &&
      decidedAt < beforeTime
    );
  });
}
