import type { GatherMultiTargetItem } from "./gather-multi-target-acceptance.js";

export interface GatherTargetProposal {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
}

export interface GatherTargetGoal {
  readonly ownerProposalId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly source?: string;
}

export interface GatherTargetJudgment {
  readonly proposalId?: string;
  readonly decidedAt?: string;
  readonly proposalDisposition?: string;
}

type ResolvedGatherTargetJudgment = GatherTargetJudgment & {
  readonly proposalId: string;
};

export interface GatherTargetOutcome {
  readonly operationId: string;
  readonly kind?: string;
  readonly status?: string;
  readonly observedAt?: string;
}

export interface SuccessfulGatherBodyOutcomeSummary {
  readonly totalCount: number;
  /** Sorted, identifier-free `operation=count` pairs for safe diagnostics. */
  readonly kindCounts: string;
}

export interface GatherTargetDiscoveryObservation {
  readonly observedAt?: string;
  readonly visibleBlockNames?: readonly string[];
}

/** Require a new successful Body view/move before a fresh observation reveals the target. */
export function gatherTargetVisibleAfterBodyAction(input: {
  readonly item: GatherMultiTargetItem;
  readonly previousOperationIds: ReadonlySet<string>;
  readonly acceptedAt: number;
  readonly outcomes: readonly GatherTargetOutcome[];
  readonly observation: GatherTargetDiscoveryObservation | undefined;
}): boolean {
  const observationAt = Date.parse(input.observation?.observedAt ?? "");
  if (
    !Number.isFinite(input.acceptedAt) ||
    !Number.isFinite(observationAt) ||
    observationAt <= input.acceptedAt
  ) {
    return false;
  }
  const visibleTarget = input.observation?.visibleBlockNames?.some(
    (name) => name.toLowerCase().replace(/^minecraft:/u, "") === input.item,
  );
  if (!visibleTarget) return false;

  return input.outcomes.some((outcome) => {
    const outcomeAt = Date.parse(outcome.observedAt ?? "");
    return (
      !input.previousOperationIds.has(outcome.operationId) &&
      (outcome.kind === "look" ||
        outcome.kind === "look_sweep" ||
        outcome.kind === "move_to" ||
        outcome.kind === "move_relative") &&
      outcome.status === "successful" &&
      Number.isFinite(outcomeAt) &&
      outcomeAt >= input.acceptedAt &&
      outcomeAt < observationAt
    );
  });
}

function targetTitleMatches(
  title: string | undefined,
  item: GatherMultiTargetItem,
): boolean {
  const value = title ?? "";
  return item === "oak_log"
    ? /\boak(?:_log|\s+logs?)?\b|オーク(?:の)?(?:原木|ログ)?|おーく(?:の)?(?:原木|ログ)?/iu.test(
        value,
      )
    : /\bbirch(?:_log|\s+logs?)?\b|白樺(?:の)?(?:原木|ログ)?|しらかば(?:の)?(?:原木|ログ)?|シラカバ(?:の)?(?:原木|ログ)?/iu.test(
        value,
      );
}

export function newGatherTargetProposalIds(input: {
  readonly item: GatherMultiTargetItem;
  readonly proposals: readonly GatherTargetProposal[];
  readonly goals: readonly GatherTargetGoal[];
  readonly previousProposalIds: ReadonlySet<string>;
}): readonly string[] {
  return input.proposals
    .filter(
      (proposal) =>
        !input.previousProposalIds.has(proposal.id) &&
        (targetTitleMatches(proposal.title, input.item) ||
          input.goals.some(
            (goal) =>
              goal.ownerProposalId === proposal.id &&
              targetTitleMatches(goal.title, input.item),
          )),
    )
    .map(({ id }) => id);
}

export function hasResolvedGatherTargetOwnerGoal(input: {
  readonly proposals: readonly GatherTargetProposal[];
  readonly judgments: readonly GatherTargetJudgment[];
  readonly goals: readonly GatherTargetGoal[];
  readonly proposalIds: ReadonlySet<string>;
}): boolean {
  const resolvedProposalIds = resolvedGatherTargetProposalIds(input);
  return input.goals.some(
    ({ ownerProposalId, source, status }) =>
      ownerProposalId !== undefined &&
      resolvedProposalIds.has(ownerProposalId) &&
      source === "owner" &&
      (status === "active" || status === "completed"),
  );
}

function resolvedGatherTargetProposalIds(input: {
  readonly proposals: readonly GatherTargetProposal[];
  readonly judgments: readonly GatherTargetJudgment[];
  readonly proposalIds: ReadonlySet<string>;
}): ReadonlySet<string> {
  return new Set([
    ...input.proposals
      .filter(
        ({ id, status }) =>
          input.proposalIds.has(id) &&
          (status === "adopted" || status === "compromised"),
      )
      .map(({ id }) => id),
    ...input.judgments
      .filter((judgment): judgment is ResolvedGatherTargetJudgment => {
        const { proposalId, proposalDisposition } = judgment;
        return (
          proposalId !== undefined &&
          input.proposalIds.has(proposalId) &&
          (proposalDisposition === "adopted" ||
            proposalDisposition === "compromised")
        );
      })
      .map(({ proposalId }) => proposalId),
  ]);
}

/** Return a count only when one accepted target goal states one explicit quantity. */
export function gatherTargetAcceptedGoalCount(input: {
  readonly item: GatherMultiTargetItem;
  readonly proposals: readonly GatherTargetProposal[];
  readonly judgments: readonly GatherTargetJudgment[];
  readonly goals: readonly GatherTargetGoal[];
  readonly proposalIds: ReadonlySet<string>;
}): number | undefined {
  const resolvedIds = resolvedGatherTargetProposalIds(input);
  const matchingGoals = input.goals.filter(
    ({ ownerProposalId, source, status, title }) =>
      ownerProposalId !== undefined &&
      input.proposalIds.has(ownerProposalId) &&
      resolvedIds.has(ownerProposalId) &&
      source === "owner" &&
      (status === "active" || status === "completed") &&
      targetTitleMatches(title, input.item),
  );
  if (matchingGoals.length !== 1) return undefined;
  const goal = matchingGoals[0];
  if (goal === undefined) return undefined;
  const title = (goal.title ?? "").normalize("NFKC");
  const quantities = [
    ...title.matchAll(
      /(?:^|[^0-9])([0-9]{1,7})\s*(?:個|つ|本|枚|ブロック|items?|blocks?)(?=\s|$|[^0-9])/giu,
    ),
  ];
  if (quantities.length !== 1) return undefined;
  const count = Number(quantities[0]?.[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

/** Count distinct successful Body outcomes, optionally only after goal adoption. */
export function summarizeSuccessfulGatherBodyOutcomes(
  outcomes: readonly GatherTargetOutcome[],
  afterObservedAt?: number,
): SuccessfulGatherBodyOutcomeSummary {
  const operationIds = new Set<string>();
  const kindCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    const observedAt = Date.parse(outcome.observedAt ?? "");
    if (
      outcome.operationId.trim().length === 0 ||
      operationIds.has(outcome.operationId) ||
      outcome.kind === undefined ||
      outcome.status !== "successful" ||
      !Number.isFinite(observedAt) ||
      (afterObservedAt !== undefined &&
        (!Number.isFinite(afterObservedAt) || observedAt <= afterObservedAt))
    ) {
      continue;
    }
    operationIds.add(outcome.operationId);
    kindCounts.set(outcome.kind, (kindCounts.get(outcome.kind) ?? 0) + 1);
  }
  return {
    totalCount: operationIds.size,
    kindCounts:
      [...kindCounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, count]) => `${kind}=${count}`)
        .join(",") || "none",
  };
}
