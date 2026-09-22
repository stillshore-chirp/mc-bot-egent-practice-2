import {
  chooseSafeCandidate,
  type ChoiceMode,
  type SafeChoiceAuthorization,
  type SafeChoiceCandidate,
  type SafeChoiceDecision,
} from "./safe-choice.js";

export interface SafeActionStep {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface SafeActionCandidate extends SafeChoiceCandidate {
  readonly steps: readonly SafeActionStep[];
}

export interface SafeActionObservationRequest {
  /** The high-level goal selected by the agent; never an authorization grant. */
  readonly goal: string;
  readonly count: number;
  readonly maxCandidates: number;
}

export interface SafeActionPlanRequest {
  readonly mode: ChoiceMode;
  readonly candidates: readonly SafeActionCandidate[];
  readonly requestedId?: string | undefined;
  readonly maxSteps: number;
  /** Remaining quantity for a bounded replan loop, when applicable. */
  readonly remainingCount?: number;
  /** Must come from the trusted owner/request boundary, never the model. */
  readonly authorization?: SafeChoiceAuthorization;
}

export type SafeActionPlanDecision =
  | {
      readonly outcome: "planned";
      readonly candidate: SafeActionCandidate;
      readonly reason: string;
      readonly steps: readonly SafeActionStep[];
    }
  | Extract<SafeChoiceDecision, { outcome: "clarify" }>;

/**
 * Selects a provider-observed candidate and preserves its bounded executable
 * steps. Candidate metadata is trusted only from the observation boundary;
 * the executor still validates each returned tool call before running it.
 */
export function planSafeAction(
  request: SafeActionPlanRequest,
): SafeActionPlanDecision {
  if (!Number.isInteger(request.maxSteps) || request.maxSteps < 1) {
    return clarify(
      request.candidates,
      "安全な実行手順の上限を確認できないため、操作を開始しません。",
    );
  }

  const executableCandidates = request.candidates.filter((candidate) =>
    hasBoundedSteps(candidate, request.maxSteps),
  );
  if (request.candidates.length > 0 && executableCandidates.length === 0) {
    return clarify(
      request.candidates,
      "候補は観測しましたが、実行手順の安全性と上限を確認できないため開始しません。",
    );
  }
  const choice = chooseSafeCandidate({
    mode: request.mode,
    candidates: executableCandidates,
    requestedId: request.requestedId,
    ...(request.authorization === undefined
      ? {}
      : { authorization: request.authorization }),
  });
  if (choice.outcome === "clarify") return choice;
  const candidate = executableCandidates.find(
    ({ id }) => id === choice.candidate.id,
  );
  if (candidate === undefined) {
    return clarify(
      request.candidates,
      "選択した候補の実行手順を再確認できないため、操作を開始しません。",
    );
  }

  if (
    !isAuthorizedBound(candidate, request.authorization, request.remainingCount)
  ) {
    return clarify(
      request.candidates,
      "候補の影響範囲または数量上限を確認できないため、操作を開始しません。",
    );
  }

  return {
    outcome: "planned",
    candidate,
    reason: choice.reason,
    steps: candidate.steps,
  };
}

function hasBoundedSteps(
  candidate: SafeActionCandidate,
  maxSteps: number,
): boolean {
  if (candidate.steps.length < 1 || candidate.steps.length > maxSteps)
    return false;
  return candidate.steps.every(
    (step) =>
      step.tool.length > 0 &&
      step.tool !== "plan_safe_action" &&
      isRecord(step.input),
  );
}

function isAuthorizedBound(
  candidate: SafeActionCandidate,
  authorization: SafeChoiceAuthorization | undefined,
  remainingCount: number | undefined,
): boolean {
  if (authorization?.kind !== "owner_bounded_resource") return true;
  if (candidate.operationClass !== "natural_resource") return false;
  if (authorization.goal.trim().length === 0) return false;
  if (
    candidate.resourceName === undefined ||
    !authorization.allowedResources.includes(candidate.resourceName)
  )
    return false;
  if (!stepsMatchResource(candidate, candidate.resourceName)) return false;
  if (
    authorization.targetItem !== "*" &&
    candidate.goalItem !== authorization.targetItem
  )
    return false;
  if (
    authorization.targetItem === "*" &&
    (candidate.goalItem === undefined ||
      !authorization.allowedResources.includes(candidate.goalItem))
  )
    return false;
  if (
    !Number.isInteger(authorization.targetCount) ||
    authorization.targetCount < 1 ||
    authorization.targetCount > authorization.maxCount
  )
    return false;
  const requestedCount = candidate.requestedCount;
  if (typeof requestedCount !== "number" || !Number.isInteger(requestedCount))
    return false;
  if (
    remainingCount !== undefined &&
    (!Number.isInteger(remainingCount) ||
      remainingCount < 1 ||
      requestedCount > remainingCount)
  )
    return false;
  return (
    requestedCount > 0 &&
    requestedCount <= authorization.targetCount &&
    requestedCount <= authorization.maxCount
  );
}

function stepsMatchResource(
  candidate: SafeActionCandidate,
  resourceName: string,
): boolean {
  const declaredResources = candidate.steps.flatMap((step) => {
    const input = step.input;
    return ["resource", "resourceName", "block", "blockName"].flatMap((key) =>
      typeof input[key] === "string" ? [input[key]] : [],
    );
  });
  return declaredResources.every((value) => value === resourceName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clarify(
  candidates: readonly SafeActionCandidate[],
  question: string,
): SafeActionPlanDecision {
  return {
    outcome: "clarify",
    code: "CHOICE_NOT_CONFIRMED",
    question,
    candidates,
  };
}
