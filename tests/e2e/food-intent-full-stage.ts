export interface FoodIntentDecisionSnapshot {
  readonly proposals: readonly { readonly id: string }[];
  readonly recentJudgments: readonly {
    readonly revision?: number;
    readonly decidedAt?: string;
    readonly kind?: string;
    readonly operationKind?: string;
    readonly proposalId?: string;
    readonly proposalDisposition?: string;
  }[];
  readonly recentOutcomes: readonly {
    readonly operationId: string;
    readonly kind?: string;
  }[];
  readonly activeOperation?: {
    readonly operationId: string;
    readonly kind: string;
  };
}

const RESOLVED_PROPOSAL_DISPOSITIONS = new Set([
  "adopted",
  "compromised",
  "declined",
]);

const NEGATED_FULLNESS =
  /(?:満腹|お腹(?:が)?いっぱい)(?:では|じゃ)(?:ありません|ない(?:です)?|なくて?|なくても)|\b(?:i(?:'m| am)|he is|she is|it is)\s+not full\b|\bnot full\b/iu;
const AFFIRMATIVE_FULLNESS =
  /満腹|お腹(?:が)?いっぱい|\b(?:i(?:'m| am)|he is|she is|it is)\s+full\b|\b(?:food|hunger)(?: bar| level)? is full\b/iu;
const AFFIRMATIVE_NO_HUNGER =
  /空腹(?:では|じゃ)(?:ありません|ない(?:です)?)|お腹(?:が)?空いて(?:いません|いない|ない)|\bnot hungry\b/iu;
const DECLINES_EATING =
  /食べ(?:ません|ない(?:です)?|る必要(?:は|が)(?:ありません|ない)|なくても(?:いい|大丈夫)(?:です)?)|\b(?:i\s+)?(?:won't|will not|can't|cannot|am not going to|don't need to|do not need to)\s+eat\b/iu;

/**
 * A full-hunger stage requires an affirmative explanation for not eating.
 * Keep this a small language check: the stage already establishes the context,
 * while the explicit negative/question/quote exclusions prevent mention-only
 * text from satisfying the acceptance predicate.
 */
export function explainsFullHunger(text: string): boolean {
  const unquoted = text.replace(
    /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|‘[^’]*’|`[^`]*`/gu,
    " ",
  );
  const sentences = unquoted
    .split(/(?<=[.!?。！？])\s*|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const isAffirmativeExplanation = (candidate: string): boolean => {
    if (
      /[?？]|(?:です|ます|でしょう|だ)?か\s*$/iu.test(candidate) ||
      NEGATED_FULLNESS.test(candidate)
    ) {
      return false;
    }
    return (
      (AFFIRMATIVE_FULLNESS.test(candidate) ||
        AFFIRMATIVE_NO_HUNGER.test(candidate)) &&
      DECLINES_EATING.test(candidate)
    );
  };

  return (
    sentences.some(isAffirmativeExplanation) ||
    sentences.some((sentence, index) => {
      const nextSentence = sentences[index + 1];
      return (
        nextSentence !== undefined &&
        isAffirmativeExplanation(`${sentence} ${nextSentence}`)
      );
    })
  );
}

function judgmentKey(
  judgment: FoodIntentDecisionSnapshot["recentJudgments"][number],
): string {
  return [
    judgment.revision ?? "",
    judgment.decidedAt ?? "",
    judgment.kind ?? "",
    judgment.operationKind ?? "",
    judgment.proposalId ?? "",
    judgment.proposalDisposition ?? "",
  ].join(":");
}

function newJudgmentsSince(
  before: FoodIntentDecisionSnapshot,
  after: FoodIntentDecisionSnapshot,
): FoodIntentDecisionSnapshot["recentJudgments"] {
  const previousJudgments = new Set(before.recentJudgments.map(judgmentKey));
  return after.recentJudgments.filter(
    (judgment) => !previousJudgments.has(judgmentKey(judgment)),
  );
}

export function hasNewResolvedOwnerProposalSince(
  before: FoodIntentDecisionSnapshot,
  after: FoodIntentDecisionSnapshot,
): boolean {
  const previousProposalIds = new Set(before.proposals.map(({ id }) => id));
  return newJudgmentsSince(before, after).some(
    (judgment) =>
      judgment.proposalId !== undefined &&
      !previousProposalIds.has(judgment.proposalId) &&
      RESOLVED_PROPOSAL_DISPOSITIONS.has(judgment.proposalDisposition ?? ""),
  );
}

export function hasNewNonConsumingDecisionSince(
  before: FoodIntentDecisionSnapshot,
  after: FoodIntentDecisionSnapshot,
): boolean {
  return newJudgmentsSince(before, after).some(
    ({ kind, operationKind }) =>
      kind === "wait" ||
      kind === "complete" ||
      kind === "continue" ||
      (kind === "act" &&
        operationKind !== undefined &&
        operationKind !== "consume"),
  );
}

export function hasNewConsumeDecisionSince(
  before: FoodIntentDecisionSnapshot,
  after: FoodIntentDecisionSnapshot,
): boolean {
  if (
    newJudgmentsSince(before, after).some(
      ({ kind, operationKind }) =>
        kind === "act" && operationKind === "consume",
    )
  ) {
    return true;
  }
  const previousOutcomeIds = new Set(
    before.recentOutcomes.map(({ operationId }) => operationId),
  );
  return (
    after.recentOutcomes.some(
      ({ operationId, kind }) =>
        !previousOutcomeIds.has(operationId) && kind === "consume",
    ) ||
    (after.activeOperation?.kind === "consume" &&
      before.activeOperation?.operationId !== after.activeOperation.operationId)
  );
}
