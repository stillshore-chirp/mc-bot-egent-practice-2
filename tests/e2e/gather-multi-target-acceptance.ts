import type { GatherDropReadbackClass } from "./gather-drop-readback.js";

export const GATHER_MULTI_TARGET_ITEMS = ["oak_log", "birch_log"] as const;
export type GatherMultiTargetItem = (typeof GATHER_MULTI_TARGET_ITEMS)[number];

type ParsedInventoryTag =
  | {
      readonly kind: "scalar";
      readonly value: string;
      readonly quoted: boolean;
    }
  | {
      readonly kind: "compound";
      readonly fields: readonly {
        readonly key: string;
        readonly value: ParsedInventoryTag;
      }[];
    }
  | { readonly kind: "list"; readonly values: readonly ParsedInventoryTag[] };

/** Parse only top-level inventory stacks; malformed or ambiguous replies fail closed. */
export function parseGatherMultiTargetInventoryReply(
  reply: string,
): Readonly<Record<GatherMultiTargetItem, number>> | undefined {
  const marker = /entity data:\s*/iu.exec(reply);
  if (marker === null) return undefined;

  try {
    const parser = new InventoryTagParser(
      reply.slice(marker.index + marker[0].length),
    );
    const root = parser.parseRootList();
    if (
      !parser.isAtEnd() ||
      root.values.some((value) => value.kind !== "compound")
    )
      return undefined;

    const counts: Record<GatherMultiTargetItem, number> = {
      oak_log: 0,
      birch_log: 0,
    };
    for (const value of root.values) {
      if (value.kind !== "compound") return undefined;
      const ids = value.fields.filter(({ key }) => key === "id");
      if (ids.length !== 1 || ids[0]?.value.kind !== "scalar") return undefined;
      const id = ids[0].value.value;
      const target = GATHER_MULTI_TARGET_ITEMS.find(
        (item) => id === `minecraft:${item}`,
      );
      if (target === undefined) continue;

      const stackCounts = value.fields.filter(
        ({ key }) => key === "count" || key === "Count",
      );
      const stackCount = stackCounts[0]?.value;
      if (
        stackCounts.length !== 1 ||
        stackCount?.kind !== "scalar" ||
        stackCount.quoted ||
        !/^\d+[bBsSlL]?$/u.test(stackCount.value)
      ) {
        return undefined;
      }
      const amount = Number.parseInt(
        stackCount.value.replace(/[bBsSlL]$/u, ""),
        10,
      );
      if (!Number.isSafeInteger(amount) || amount < 0) return undefined;
      counts[target] += amount;
      if (!Number.isSafeInteger(counts[target])) return undefined;
    }
    return counts;
  } catch {
    return undefined;
  }
}

class InventoryTagParser {
  private position = 0;

  constructor(private readonly source: string) {}

  parseRootList(): Extract<ParsedInventoryTag, { kind: "list" }> {
    const parsed = this.parseValue();
    if (parsed.kind !== "list") throw new Error("expected list");
    return parsed;
  }

  isAtEnd(): boolean {
    this.skipWhitespace();
    return this.position === this.source.length;
  }

  private parseValue(): ParsedInventoryTag {
    this.skipWhitespace();
    const next = this.source[this.position];
    if (next === "{") return this.parseCompound();
    if (next === "[") return this.parseList();
    if (next === '"' || next === "'")
      return { kind: "scalar", value: this.parseQuoted(), quoted: true };
    const start = this.position;
    while (
      this.position < this.source.length &&
      ![",", "]", "}"].includes(this.source[this.position] ?? "")
    ) {
      this.position += 1;
    }
    const value = this.source.slice(start, this.position).trim();
    if (value.length === 0) throw new Error("empty value");
    return { kind: "scalar", value, quoted: false };
  }

  private parseCompound(): Extract<ParsedInventoryTag, { kind: "compound" }> {
    this.expect("{");
    this.skipWhitespace();
    const fields: { key: string; value: ParsedInventoryTag }[] = [];
    if (this.consume("}")) return { kind: "compound", fields };
    while (this.position < this.source.length) {
      const key = this.parseKey();
      this.expect(":");
      fields.push({ key, value: this.parseValue() });
      this.skipWhitespace();
      if (this.consume("}")) return { kind: "compound", fields };
      this.expect(",");
    }
    throw new Error("unterminated compound");
  }

  private parseList(): Extract<ParsedInventoryTag, { kind: "list" }> {
    this.expect("[");
    this.skipWhitespace();
    const values: ParsedInventoryTag[] = [];
    if (this.consume("]")) return { kind: "list", values };
    while (this.position < this.source.length) {
      values.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return { kind: "list", values };
      this.expect(",");
    }
    throw new Error("unterminated list");
  }

  private parseKey(): string {
    this.skipWhitespace();
    const next = this.source[this.position];
    if (next === '"' || next === "'") return this.parseQuoted();
    const start = this.position;
    while (
      this.position < this.source.length &&
      this.source[this.position] !== ":"
    ) {
      if ([",", "{", "}", "[", "]"].includes(this.source[this.position] ?? ""))
        throw new Error("invalid key");
      this.position += 1;
    }
    const key = this.source.slice(start, this.position).trim();
    if (key.length === 0) throw new Error("empty key");
    return key;
  }

  private parseQuoted(): string {
    const quote = this.source[this.position];
    if (quote !== '"' && quote !== "'") throw new Error("expected quote");
    this.position += 1;
    let result = "";
    while (this.position < this.source.length) {
      const character = this.source[this.position] ?? "";
      this.position += 1;
      if (character === quote) return result;
      if (character === "\\") {
        const escaped = this.source[this.position] ?? "";
        if (escaped.length === 0) throw new Error("unfinished escape");
        result = result.concat(escaped);
        this.position += 1;
      } else {
        result += character;
      }
    }
    throw new Error("unterminated quote");
  }

  private expect(character: string): void {
    this.skipWhitespace();
    if (!this.consume(character)) throw new Error("unexpected token");
  }

  private consume(character: string): boolean {
    if (this.source[this.position] !== character) return false;
    this.position += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.source[this.position] ?? "")) this.position += 1;
  }
}

export interface GatherMultiTargetOracleSample {
  readonly blockPresent: Readonly<Record<GatherMultiTargetItem, boolean>>;
  readonly inventoryCount: Readonly<Record<GatherMultiTargetItem, number>>;
  readonly completedGatherCount: number;
}

export type GatherMultiTargetRconSampleStage =
  "postFollowupPredicate" | "final";
export type GatherMultiTargetRconSampleStatus =
  "not_attempted" | "fresh" | "unavailable";
type InventoryCountBucket = "zero" | "one_or_more" | "unknown";
type InventoryDeltaBucket =
  | "unchanged"
  | "increased_by_one"
  | "increased_by_multiple"
  | "decreased"
  | "unknown";

/** Keep RCON samples useful for diagnosis without publishing exact counts. */
export function gatherMultiTargetRconSampleEvidence(
  stage: GatherMultiTargetRconSampleStage,
  sample: GatherMultiTargetOracleSample | undefined,
  baseline: Readonly<Record<GatherMultiTargetItem, number>> | undefined,
  readStatus: GatherMultiTargetRconSampleStatus,
): Readonly<Record<string, boolean | string>> {
  const safeSample = readStatus === "fresh" ? sample : undefined;
  const status =
    readStatus === "fresh" && safeSample === undefined
      ? "unavailable"
      : readStatus;
  const prefix = `gatherMultiTarget${capitalize(stage)}Rcon`;
  const evidence: Record<string, boolean | string> = {
    [`${prefix}Status`]: status,
  };
  for (const item of GATHER_MULTI_TARGET_ITEMS) {
    const itemLabel = item === "oak_log" ? "OakLog" : "BirchLog";
    evidence[`${prefix}${itemLabel}BlockPresent`] =
      safeSample?.blockPresent[item] ?? "unknown";
    evidence[`${prefix}${itemLabel}BaselineInventoryBucket`] =
      bucketInventoryCount(baseline?.[item]);
    evidence[`${prefix}${itemLabel}CurrentInventoryBucket`] =
      bucketInventoryCount(safeSample?.inventoryCount[item]);
    evidence[`${prefix}${itemLabel}InventoryDeltaBucket`] =
      bucketInventoryDelta(baseline?.[item], safeSample?.inventoryCount[item]);
  }
  return evidence;
}

function bucketInventoryCount(count: number | undefined): InventoryCountBucket {
  if (count === undefined || !Number.isSafeInteger(count) || count < 0)
    return "unknown";
  return count === 0 ? "zero" : "one_or_more";
}

function bucketInventoryDelta(
  baseline: number | undefined,
  current: number | undefined,
): InventoryDeltaBucket {
  if (
    baseline === undefined ||
    current === undefined ||
    !Number.isSafeInteger(baseline) ||
    !Number.isSafeInteger(current) ||
    baseline < 0 ||
    current < 0
  ) {
    return "unknown";
  }
  const delta = current - baseline;
  if (delta === 0) return "unchanged";
  if (delta === 1) return "increased_by_one";
  if (delta > 1) return "increased_by_multiple";
  return "decreased";
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
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
