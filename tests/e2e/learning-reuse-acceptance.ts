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
    !baseline.revisionVersionsBySkill.get(skillId)?.has(skillVersion)
  ) {
    return undefined;
  }

  return {
    source: "preexisting_hypothesis_used",
    skillId,
  };
}
