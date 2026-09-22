import {
  knownBlockDrops,
  knownSmeltInputs,
} from "../minecraft/general-actions.js";

export type ChoiceMode = "explicit" | "delegated" | "unspecified";

export type ChoicePurposeFit = "direct" | "compatible" | "unknown";
export type ChoicePermission = "allowed" | "denied" | "unknown";
export type ChoiceSafety = "allowed" | "blocked" | "unknown";
export type ChoiceImpact = "low" | "medium" | "high";
export type ChoiceOperationClass =
  | "natural_resource"
  | "world_change"
  | "movement"
  | "communication"
  | "unknown";

/**
 * Authorization must be supplied by the trusted request boundary. It is not
 * inferred from a model-selected tool argument or from candidate metadata.
 */
export type SafeChoiceAuthorization =
  | { readonly kind: "delegated_low_impact" }
  | {
      readonly kind: "owner_bounded_resource";
      /** High-level goal captured at the trusted owner request boundary. */
      readonly goal: string;
      /** Canonical resource IDs authorized by that owner goal. */
      readonly allowedResources: readonly string[];
      /** Canonical inventory item the owner asked to obtain. */
      readonly targetItem: string;
      /** `*` permits one observed item from the bounded allowed resource set. */
      readonly selectionRequired?: boolean;
      /** Exact quantity extracted from the owner message. */
      readonly targetCount: number;
      readonly maxCount: number;
    }
  | {
      readonly kind: "owner_scoped_change";
      readonly scopeId: string;
      readonly maxImpact: Exclude<ChoiceImpact, "low">;
    };

export interface SafeChoiceCandidate {
  readonly id: string;
  readonly label: string;
  readonly action: string;
  readonly observed: boolean;
  readonly purposeFit: ChoicePurposeFit;
  readonly permission: ChoicePermission;
  readonly safety: ChoiceSafety;
  readonly reversible: boolean;
  readonly impact: ChoiceImpact;
  /** Required for medium/high-impact extension operations. */
  readonly operationClass?: ChoiceOperationClass;
  /** Required when a scoped world change is authorized. */
  readonly scopeId?: string;
  /** Provider-observed bounded quantity for a natural-resource operation. */
  readonly requestedCount?: number;
  /** Canonical provider resource ID for resource authorization matching. */
  readonly resourceName?: string;
  /** Canonical inventory item delivered by the whole candidate plan. */
  readonly goalItem?: string;
  /** Verified intermediate inventory items that may advance preparation only. */
  readonly intermediateItems?: readonly string[];
  readonly distance?: number;
  readonly order?: number;
}

export interface SafeChoiceRequest {
  readonly mode: ChoiceMode;
  readonly candidates: readonly SafeChoiceCandidate[];
  readonly requestedId?: string | undefined;
  /** Defaults to delegated low-impact selection. */
  readonly authorization?: SafeChoiceAuthorization;
}

export type SafeChoiceClarificationCode =
  | "CHOICE_NOT_DELEGATED"
  | "CHOICE_NOT_OBSERVED"
  | "CHOICE_NOT_CONFIRMED"
  | "CHOICE_BLOCKED"
  | "CHOICE_REQUESTED_UNSAFE";

export type SafeChoiceDecision =
  | {
      readonly outcome: "selected";
      readonly candidate: SafeChoiceCandidate;
      readonly reason: string;
    }
  | {
      readonly outcome: "clarify";
      readonly code: SafeChoiceClarificationCode;
      readonly question: string;
      readonly candidates: readonly SafeChoiceCandidate[];
    };

/**
 * Choose only from facts that were observed and have already passed the
 * deterministic safety and permission boundaries. The language model may
 * describe the goal, but it cannot turn an unknown or protected candidate
 * into an executable choice.
 */
export function chooseSafeCandidate(
  request: SafeChoiceRequest,
): SafeChoiceDecision {
  const candidates = request.candidates;
  const requested =
    request.requestedId === undefined
      ? undefined
      : candidates.find(({ id }) => id === request.requestedId);

  if (request.mode === "explicit") {
    if (requested === undefined) {
      return clarify(
        "CHOICE_NOT_OBSERVED",
        candidates,
        "指定された対象を現在の観測で確認できません。対象をもう一度指定してください。",
      );
    }
    if (!isEligible(requested, request.authorization)) {
      return clarify(
        "CHOICE_REQUESTED_UNSAFE",
        candidates,
        `指定された${safeLabel(requested.label)}は安全条件を確認できないため実行しません。別の対象を指定してください。`,
      );
    }
    return selected(requested, false);
  }

  if (request.mode !== "delegated") {
    return clarify(
      "CHOICE_NOT_DELEGATED",
      candidates,
      "対象の選択条件が決まっていません。対象を指定するか、安全な候補の選択を任せると伝えてください。",
    );
  }

  if (requested !== undefined) {
    if (!isEligible(requested, request.authorization)) {
      return clarify(
        "CHOICE_REQUESTED_UNSAFE",
        candidates,
        `指定された${safeLabel(requested.label)}は安全条件を確認できないため実行しません。別の対象を指定してください。`,
      );
    }
    return selected(requested, false);
  }

  const eligible = candidates.filter((candidate) =>
    isEligible(candidate, request.authorization),
  );
  if (eligible.length === 0) {
    return noEligibleCandidate(candidates);
  }

  const choice = [...eligible].sort(compareCandidates)[0];
  if (choice === undefined) {
    return noEligibleCandidate(candidates);
  }
  return selected(choice, true);
}

function isEligible(
  candidate: SafeChoiceCandidate,
  authorization: SafeChoiceAuthorization | undefined,
): boolean {
  const commonSafety =
    candidate.observed &&
    candidate.purposeFit !== "unknown" &&
    candidate.permission === "allowed" &&
    candidate.safety === "allowed";
  if (!commonSafety) return false;

  if (candidate.reversible && candidate.impact === "low") return true;

  const trustedAuthorization = authorization ?? {
    kind: "delegated_low_impact",
  };
  if (
    trustedAuthorization.kind === "owner_bounded_resource" &&
    trustedAuthorization.targetItem !== "*" &&
    candidate.action === "smelt_item" &&
    candidate.operationClass === "world_change" &&
    candidate.scopeId === "inventory" &&
    candidate.impact === "low" &&
    candidate.goalItem === trustedAuthorization.targetItem &&
    trustedAuthorization.goal.trim().length > 0 &&
    Number.isInteger(trustedAuthorization.targetCount) &&
    trustedAuthorization.targetCount > 0 &&
    Number.isInteger(trustedAuthorization.maxCount) &&
    trustedAuthorization.targetCount <= trustedAuthorization.maxCount &&
    Number.isInteger(candidate.requestedCount) &&
    (candidate.requestedCount ?? 0) > 0 &&
    (candidate.requestedCount ?? 0) <= trustedAuthorization.targetCount
  ) {
    const requiredInput = knownSmeltInputs[trustedAuthorization.targetItem];
    return (
      requiredInput !== undefined &&
      trustedAuthorization.allowedResources.some(
        (resource) => knownBlockDrops[resource] === requiredInput,
      )
    );
  }
  if (
    trustedAuthorization.kind === "owner_bounded_resource" &&
    trustedAuthorization.goal.trim().length > 0 &&
    trustedAuthorization.allowedResources.length > 0 &&
    candidate.resourceName !== undefined &&
    trustedAuthorization.allowedResources.includes(candidate.resourceName) &&
    matchesAuthorizedGoalItem(candidate, trustedAuthorization) &&
    candidate.operationClass === "natural_resource" &&
    candidate.impact === "medium" &&
    Number.isInteger(trustedAuthorization.targetCount) &&
    trustedAuthorization.targetCount > 0 &&
    Number.isInteger(trustedAuthorization.maxCount) &&
    trustedAuthorization.targetCount <= trustedAuthorization.maxCount
  ) {
    return (
      Number.isInteger(trustedAuthorization.maxCount) &&
      trustedAuthorization.maxCount > 0
    );
  }

  return (
    trustedAuthorization.kind === "owner_scoped_change" &&
    candidate.operationClass === "world_change" &&
    candidate.scopeId === trustedAuthorization.scopeId &&
    impactRank(candidate.impact) <= impactRank(trustedAuthorization.maxImpact)
  );
}

function matchesAuthorizedGoalItem(
  candidate: SafeChoiceCandidate,
  authorization: Extract<
    SafeChoiceAuthorization,
    { kind: "owner_bounded_resource" }
  >,
): boolean {
  if (authorization.targetItem !== "*") {
    return candidate.goalItem === authorization.targetItem;
  }
  return (
    candidate.goalItem !== undefined &&
    authorization.allowedResources.includes(candidate.goalItem)
  );
}

function impactRank(impact: ChoiceImpact): number {
  return impact === "low" ? 1 : impact === "medium" ? 2 : 3;
}

function compareCandidates(
  left: SafeChoiceCandidate,
  right: SafeChoiceCandidate,
): number {
  const purpose = purposeRank(right.purposeFit) - purposeRank(left.purposeFit);
  if (purpose !== 0) return purpose;
  const leftDistance = finiteDistance(left.distance);
  const rightDistance = finiteDistance(right.distance);
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  const order =
    (left.order ?? Number.MAX_SAFE_INTEGER) -
    (right.order ?? Number.MAX_SAFE_INTEGER);
  if (order !== 0) return order;
  return left.id.localeCompare(right.id);
}

function purposeRank(purpose: ChoicePurposeFit): number {
  return purpose === "direct" ? 2 : purpose === "compatible" ? 1 : 0;
}

function finiteDistance(distance: number | undefined): number {
  return distance === undefined || !Number.isFinite(distance)
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, distance);
}

function selected(
  candidate: SafeChoiceCandidate,
  nearest: boolean,
): SafeChoiceDecision {
  const distance =
    candidate.distance === undefined || !Number.isFinite(candidate.distance)
      ? "近さは未確認"
      : `距離${candidate.distance.toFixed(1)}ブロック`;
  return {
    outcome: "selected",
    candidate,
    reason: nearest
      ? `観測済みで、目的に合い、権限と安全条件を確認できた${safeLabel(candidate.label)}を${distance}の最も近い候補として選びます。`
      : `観測済みで、目的に合い、権限と安全条件を確認できた${safeLabel(candidate.label)}を実行候補として選びます。`,
  };
}

function noEligibleCandidate(
  candidates: readonly SafeChoiceCandidate[],
): SafeChoiceDecision {
  const observed = candidates.filter(({ observed }) => observed);
  if (observed.length === 0) {
    return clarify(
      "CHOICE_NOT_OBSERVED",
      candidates,
      "安全に判断できる候補をまだ観測できません。対象を具体的に指定してください。",
    );
  }
  if (
    observed.every(
      ({ safety, permission }) =>
        safety === "blocked" || permission === "denied",
    )
  ) {
    return clarify(
      "CHOICE_BLOCKED",
      candidates,
      "観測した候補は保護対象か権限がないため実行できません。別の候補を指定してください。",
    );
  }
  return clarify(
    "CHOICE_NOT_CONFIRMED",
    candidates,
    "候補は観測しましたが、安全条件か目的への適合を確認できません。実行対象を具体的に指定してください。",
  );
}

function clarify(
  code: SafeChoiceClarificationCode,
  candidates: readonly SafeChoiceCandidate[],
  question: string,
): SafeChoiceDecision {
  return { outcome: "clarify", code, question, candidates };
}

function safeLabel(label: string): string {
  const normalized = label.trim().replace(/\s+/gu, " ");
  return normalized.length > 80 ? normalized.slice(0, 77) + "..." : normalized;
}
