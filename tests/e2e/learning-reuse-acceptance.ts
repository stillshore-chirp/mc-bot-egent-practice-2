export interface LearningHypothesisSnapshot {
  readonly skillIds: ReadonlySet<string>;
  readonly successfulDerivedSkillIds: ReadonlySet<string>;
  readonly revisionVersionsBySkill: ReadonlyMap<string, ReadonlySet<number>>;
  readonly successfulDerivedHypothesesByRunId: ReadonlyMap<
    string,
    { readonly skillId: string; readonly skillVersion: number }
  >;
}

export interface FirstDigOutcome {
  readonly operationId: string;
  readonly kind?: string;
  readonly status?: string;
  readonly skillId?: string;
  readonly skillVersion?: number;
}

export type FirstDigLearningEvidence =
  | {
      readonly source: "derived_from_first_dig";
      readonly skillId: string;
    }
  | {
      readonly source: "preexisting_hypothesis_used";
      readonly skillId: string;
    };

export interface FirstDigLearningDiagnostic {
  readonly outcomeKind: "dig" | "other" | "unknown";
  readonly outcomeStatus:
    | "successful"
    | "failed"
    | "interrupted"
    | "cancelled"
    | "unverified"
    | "unknown";
  readonly outcomeHasSkillAtUse: boolean;
  readonly baselineHasOutcomeSkill: boolean;
  readonly baselineOutcomeSkillIsTrustedDerived: boolean;
  readonly currentHasOutcomeSkill: boolean;
  readonly currentOutcomeSkillIsTrustedDerived: boolean;
  readonly currentOutcomeSkillHasUsedRevision: boolean;
  readonly firstDigDerivedHypothesisPresent: boolean;
  readonly firstDigDerivedHypothesisIsTrustedDerived: boolean;
  readonly firstDigDerivedHypothesisHasRevision: boolean;
  readonly firstDigDerivedHypothesisMatchesOutcome: boolean;
  readonly baselineSkillCount: number;
  readonly baselineTrustedDerivedSkillCount: number;
  readonly currentSkillCount: number;
  readonly currentTrustedDerivedSkillCount: number;
}

/** Project hypothesis evidence to fixed, identifier-free failure diagnostics. */
export function firstDigLearningDiagnostic(
  outcome: FirstDigOutcome,
  baseline: LearningHypothesisSnapshot,
  current: LearningHypothesisSnapshot,
): FirstDigLearningDiagnostic {
  const { skillId, skillVersion } = outcome;
  const hasSkillAtUse = skillId !== undefined && skillVersion !== undefined;
  const derived = current.successfulDerivedHypothesesByRunId.get(
    outcome.operationId,
  );
  const derivedIsTrusted =
    derived !== undefined &&
    current.skillIds.has(derived.skillId) &&
    current.successfulDerivedSkillIds.has(derived.skillId);
  const derivedHasRevision =
    derived !== undefined &&
    current.revisionVersionsBySkill
      .get(derived.skillId)
      ?.has(derived.skillVersion) === true;
  const status =
    outcome.status === "successful" ||
    outcome.status === "failed" ||
    outcome.status === "interrupted" ||
    outcome.status === "cancelled" ||
    outcome.status === "unverified"
      ? outcome.status
      : "unknown";

  return {
    outcomeKind:
      outcome.kind === "dig"
        ? "dig"
        : outcome.kind === undefined
          ? "unknown"
          : "other",
    outcomeStatus: status,
    outcomeHasSkillAtUse: hasSkillAtUse,
    baselineHasOutcomeSkill:
      skillId !== undefined && baseline.skillIds.has(skillId),
    baselineOutcomeSkillIsTrustedDerived:
      skillId !== undefined && baseline.successfulDerivedSkillIds.has(skillId),
    currentHasOutcomeSkill:
      skillId !== undefined && current.skillIds.has(skillId),
    currentOutcomeSkillIsTrustedDerived:
      skillId !== undefined && current.successfulDerivedSkillIds.has(skillId),
    currentOutcomeSkillHasUsedRevision:
      skillId !== undefined &&
      skillVersion !== undefined &&
      current.revisionVersionsBySkill.get(skillId)?.has(skillVersion) === true,
    firstDigDerivedHypothesisPresent: derived !== undefined,
    firstDigDerivedHypothesisIsTrustedDerived: derivedIsTrusted,
    firstDigDerivedHypothesisHasRevision: derivedHasRevision,
    firstDigDerivedHypothesisMatchesOutcome:
      derived !== undefined &&
      skillId !== undefined &&
      skillVersion !== undefined &&
      derived.skillId === skillId &&
      derived.skillVersion === skillVersion,
    baselineSkillCount: baseline.skillIds.size,
    baselineTrustedDerivedSkillCount: baseline.successfulDerivedSkillIds.size,
    currentSkillCount: current.skillIds.size,
    currentTrustedDerivedSkillCount: current.successfulDerivedSkillIds.size,
  };
}

/** Select a trusted hypothesis created by this dig or already used by it. */
export function firstDigLearningEvidence(
  outcome: FirstDigOutcome,
  baseline: LearningHypothesisSnapshot,
  current: LearningHypothesisSnapshot,
): FirstDigLearningEvidence | undefined {
  if (outcome.kind !== "dig" || outcome.status !== "successful")
    return undefined;

  const derived = current.successfulDerivedHypothesesByRunId.get(
    outcome.operationId,
  );
  if (
    derived !== undefined &&
    current.skillIds.has(derived.skillId) &&
    current.successfulDerivedSkillIds.has(derived.skillId) &&
    current.revisionVersionsBySkill
      .get(derived.skillId)
      ?.has(derived.skillVersion)
  ) {
    return {
      source: "derived_from_first_dig",
      skillId: derived.skillId,
    };
  }

  const { skillId, skillVersion } = outcome;
  if (
    skillId === undefined ||
    skillVersion === undefined ||
    !baseline.skillIds.has(skillId) ||
    !baseline.successfulDerivedSkillIds.has(skillId) ||
    !current.skillIds.has(skillId) ||
    !current.revisionVersionsBySkill.get(skillId)?.has(skillVersion)
  ) {
    return undefined;
  }

  return {
    source: "preexisting_hypothesis_used",
    skillId,
  };
}
