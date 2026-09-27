export interface ArmorProposalResolutionSnapshot {
  readonly proposals: readonly {
    readonly id: string;
    readonly createdAt?: string;
    readonly status?: string;
    readonly resolution?: string;
  }[];
  readonly goals: readonly {
    readonly id: string;
    readonly ownerProposalId?: string;
    readonly title?: string;
    readonly status?: string;
    readonly source?: string;
    readonly updatedAt?: string;
  }[];
  readonly judgments: readonly {
    readonly proposalId?: string;
    readonly proposalDisposition?: string;
    readonly kind?: string;
    readonly operationKind?: string;
    readonly decidedAt?: string;
  }[];
  readonly outcomes: readonly {
    readonly operationId: string;
    readonly kind?: string;
    readonly status?: string;
    readonly observedAt?: string;
  }[];
}

export type ArmorProposalResolutionClass =
  | "direct_proposal_equip_judgment"
  | "owner_goal_equip_judgment"
  | "awaiting_new_proposal"
  | "awaiting_proposal_resolution"
  | "awaiting_owner_goal"
  | "awaiting_equip_judgment"
  | "declined"
  | "ambiguous"
  | "unlinked_or_autonomous_goal"
  | "wrong_goal_intent"
  | "invalid_timeline";

export interface ArmorProposalResolutionEvidence {
  readonly classification: ArmorProposalResolutionClass;
  readonly ownerProposalResolved: boolean;
  readonly linkedHelmetGoalConfirmed: boolean;
  readonly equipJudgmentAfterProposal: boolean;
  readonly successfulEquipOutcomeAfterJudgment: boolean;
}

export interface ArmorProposalResolutionInput {
  readonly baselineProposalIds: ReadonlySet<string>;
  readonly baselineOutcomeIds: ReadonlySet<string>;
  readonly ownerRequestSentAt: string;
  readonly snapshot: ArmorProposalResolutionSnapshot;
}

const ACCEPTED_DISPOSITIONS = new Set(["adopted", "compromised"]);
const DECLINED_DISPOSITIONS = new Set(["declined", "rejected", "dismissed"]);

function normalized(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function isAcceptedDisposition(value: string | undefined): boolean {
  return ACCEPTED_DISPOSITIONS.has(normalized(value));
}

function isDeclinedDisposition(value: string | undefined): boolean {
  return DECLINED_DISPOSITIONS.has(normalized(value));
}

function hasHelmetEquipIntent(title: string | undefined): boolean {
  const value = normalized(title).replaceAll("_", " ");
  const helmet = /\bhelmet\b|ヘルメット|兜/iu.test(value);
  const equip = /\bequip\b|\bwear\b|\bput on\b|装備|着用|被る|かぶる/iu.test(
    value,
  );
  return helmet && equip;
}

function hasEquipIntent(title: string | undefined): boolean {
  const value = normalized(title);
  return /\bequip\b|\bwear\b|\bput on\b|装備|着用|被る|かぶる/iu.test(value);
}

function parsedTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function result(
  classification: ArmorProposalResolutionClass,
  values: Partial<Omit<ArmorProposalResolutionEvidence, "classification">> = {},
): ArmorProposalResolutionEvidence {
  return {
    classification,
    ownerProposalResolved: false,
    linkedHelmetGoalConfirmed: false,
    equipJudgmentAfterProposal: false,
    successfulEquipOutcomeAfterJudgment: false,
    ...values,
  };
}

/**
 * Joins the owner proposal to either an explicit judgment proposalId or the
 * committed owner goal's ownerProposalId. Only fixed classifications and
 * booleans leave this helper; snapshot text and identifiers are not returned.
 */
export function classifyArmorProposalResolution(
  input: ArmorProposalResolutionInput,
): ArmorProposalResolutionEvidence {
  const requestTime = parsedTime(input.ownerRequestSentAt);
  if (requestTime === undefined) return result("invalid_timeline");

  const newProposals = input.snapshot.proposals.filter(
    ({ id }) => !input.baselineProposalIds.has(id),
  );
  if (newProposals.length === 0) return result("awaiting_new_proposal");
  if (newProposals.length !== 1) return result("ambiguous");

  const proposal = newProposals[0];
  if (proposal === undefined) return result("awaiting_new_proposal");
  const proposalCreatedAt = parsedTime(proposal.createdAt);
  if (proposalCreatedAt !== undefined && proposalCreatedAt <= requestTime)
    return result("invalid_timeline");

  const proposalDispositions = [proposal.status, proposal.resolution].filter(
    (value): value is string => value !== undefined && value.trim() !== "",
  );
  if (proposalDispositions.some(isDeclinedDisposition))
    return result("declined");

  const proposalAccepted = proposalDispositions.some(isAcceptedDisposition);
  const explicitEquipJudgments = input.snapshot.judgments.filter(
    (judgment) =>
      judgment.proposalId === proposal.id &&
      isAcceptedDisposition(judgment.proposalDisposition) &&
      judgment.kind === "act" &&
      judgment.operationKind === "equip",
  );
  if (explicitEquipJudgments.length > 1) return result("ambiguous");

  const explicitEquipJudgment = explicitEquipJudgments[0];
  if (explicitEquipJudgment !== undefined) {
    const decidedAt = parsedTime(explicitEquipJudgment.decidedAt);
    if (
      decidedAt === undefined ||
      decidedAt <= (proposalCreatedAt ?? requestTime)
    )
      return result("invalid_timeline");
    const success = hasSuccessfulEquipOutcomeAfter(
      input,
      decidedAt,
      requestTime,
    );
    return result("direct_proposal_equip_judgment", {
      ownerProposalResolved: true,
      equipJudgmentAfterProposal: true,
      successfulEquipOutcomeAfterJudgment: success,
    });
  }

  if (!proposalAccepted) {
    return result("awaiting_proposal_resolution");
  }

  const linkedGoals = input.snapshot.goals.filter(
    ({ ownerProposalId }) => ownerProposalId === proposal.id,
  );
  if (linkedGoals.length > 1) return result("ambiguous");
  const goal = linkedGoals[0];
  if (goal === undefined) {
    const otherHelmetEquipGoal = input.snapshot.goals.some(
      ({ ownerProposalId, title, status }) =>
        ownerProposalId !== proposal.id &&
        (status === "active" || status === "completed") &&
        hasHelmetEquipIntent(title),
    );
    return result(
      otherHelmetEquipGoal
        ? "unlinked_or_autonomous_goal"
        : "awaiting_owner_goal",
      { ownerProposalResolved: true },
    );
  }

  if (
    goal.source !== "owner" ||
    (goal.status !== "active" && goal.status !== "completed")
  ) {
    return result("unlinked_or_autonomous_goal", {
      ownerProposalResolved: true,
    });
  }
  if (!hasHelmetEquipIntent(goal.title)) {
    return result("wrong_goal_intent", { ownerProposalResolved: true });
  }

  const competingEquipGoal = input.snapshot.goals.some((candidate) => {
    if (
      candidate.id === goal.id ||
      (candidate.status !== "active" && candidate.status !== "completed") ||
      !hasEquipIntent(candidate.title)
    ) {
      return false;
    }
    const updatedAt = parsedTime(candidate.updatedAt);
    return (
      candidate.status === "active" ||
      updatedAt === undefined ||
      updatedAt > requestTime
    );
  });
  if (competingEquipGoal)
    return result("ambiguous", { ownerProposalResolved: true });

  const goalUpdatedAt = parsedTime(goal.updatedAt);
  if (
    proposalCreatedAt === undefined ||
    goalUpdatedAt === undefined ||
    goalUpdatedAt < proposalCreatedAt
  )
    return result("invalid_timeline", { ownerProposalResolved: true });

  const equipJudgments = input.snapshot.judgments.filter(
    (judgment) =>
      judgment.kind === "act" &&
      judgment.operationKind === "equip" &&
      (judgment.proposalId === undefined ||
        judgment.proposalId === proposal.id),
  );
  const postProposalEquipJudgments = equipJudgments.filter((judgment) => {
    const decidedAt = parsedTime(judgment.decidedAt);
    return decidedAt !== undefined && decidedAt > proposalCreatedAt;
  });
  if (postProposalEquipJudgments.length === 0 && equipJudgments.length > 0) {
    return result("invalid_timeline", {
      ownerProposalResolved: true,
      linkedHelmetGoalConfirmed: true,
    });
  }
  if (postProposalEquipJudgments.length > 1) return result("ambiguous");
  const equipJudgment = postProposalEquipJudgments[0];
  if (equipJudgment === undefined) {
    return result("awaiting_equip_judgment", {
      ownerProposalResolved: true,
      linkedHelmetGoalConfirmed: true,
    });
  }

  const decidedAt = parsedTime(equipJudgment.decidedAt);
  if (decidedAt === undefined || decidedAt <= proposalCreatedAt)
    return result("invalid_timeline", {
      ownerProposalResolved: true,
      linkedHelmetGoalConfirmed: true,
    });

  return result("owner_goal_equip_judgment", {
    ownerProposalResolved: true,
    linkedHelmetGoalConfirmed: true,
    equipJudgmentAfterProposal: true,
    successfulEquipOutcomeAfterJudgment: hasSuccessfulEquipOutcomeAfter(
      input,
      decidedAt,
      proposalCreatedAt,
    ),
  });
}

function hasSuccessfulEquipOutcomeAfter(
  input: ArmorProposalResolutionInput,
  judgmentTime: number,
  proposalTime: number,
): boolean {
  return input.snapshot.outcomes.some((outcome) => {
    const observedAt = parsedTime(outcome.observedAt);
    return (
      !input.baselineOutcomeIds.has(outcome.operationId) &&
      outcome.kind === "equip" &&
      outcome.status === "successful" &&
      observedAt !== undefined &&
      observedAt > judgmentTime &&
      observedAt > proposalTime
    );
  });
}
