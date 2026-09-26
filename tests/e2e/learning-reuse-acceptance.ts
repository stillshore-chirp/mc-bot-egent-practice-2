export interface LearningHypothesisSnapshot {
  readonly skillIds: ReadonlySet<string>;
  readonly successfulDerivedSkillIds: ReadonlySet<string>;
  readonly revisionVersionsBySkill: ReadonlyMap<string, ReadonlySet<number>>;
  readonly revisionDefinitionsBySkill: ReadonlyMap<
    string,
    ReadonlyMap<number, LearningSkillDefinition>
  >;
  readonly successfulDerivedHypothesesByRunId: ReadonlyMap<
    string,
    { readonly skillId: string; readonly skillVersion: number }
  >;
  readonly evidenceRevisionsByRunId: ReadonlyMap<
    string,
    LearningEvidenceRevision
  >;
}

export interface LearningSkillDefinition {
  readonly conditions: readonly string[];
  readonly body: string;
  readonly expectedOutcome: string;
  readonly confidence: number;
}

export interface LearningEvidenceRevision {
  readonly receiptRunId: string;
  readonly receiptSkillIdAtUse: string | null;
  readonly receiptSkillVersionAtUse: number | null;
  readonly skillId: string;
  readonly operationName: string;
  readonly observedOutcome: string;
  readonly skillVersionAtUse: number;
  readonly revisionVersion: number;
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
    }
  | {
      readonly source: "receipt_linked_revision_from_first_dig";
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
  readonly firstDigEvidenceRevisionPresent: boolean;
  readonly firstDigEvidenceRevisionMatchesOutcome: boolean;
  readonly firstDigEvidenceRevisionHasMaterialChange: boolean;
  readonly firstDigEvidenceRevisionHasNoNewSkills: boolean;
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
  const evidenceRevision = current.evidenceRevisionsByRunId.get(
    outcome.operationId,
  );
  const evidenceRevisionMatchesOutcome =
    evidenceRevision !== undefined &&
    skillId !== undefined &&
    skillVersion !== undefined &&
    evidenceRevision.operationName === "dig" &&
    evidenceRevision.observedOutcome === "successful" &&
    evidenceRevision.receiptRunId === outcome.operationId &&
    evidenceRevision.receiptSkillIdAtUse === skillId &&
    evidenceRevision.receiptSkillVersionAtUse === skillVersion &&
    evidenceRevision.skillId === skillId &&
    evidenceRevision.skillVersionAtUse === skillVersion &&
    evidenceRevision.revisionVersion > skillVersion;
  const evidenceRevisionHasMaterialChange =
    evidenceRevision !== undefined &&
    evidenceRevisionMatchesOutcome &&
    hasMaterialRevisionChange(
      current.revisionDefinitionsBySkill
        .get(evidenceRevision.skillId)
        ?.get(evidenceRevision.skillVersionAtUse),
      current.revisionDefinitionsBySkill
        .get(evidenceRevision.skillId)
        ?.get(evidenceRevision.revisionVersion),
    );
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
    firstDigEvidenceRevisionPresent: evidenceRevision !== undefined,
    firstDigEvidenceRevisionMatchesOutcome: evidenceRevisionMatchesOutcome,
    firstDigEvidenceRevisionHasMaterialChange:
      evidenceRevisionHasMaterialChange,
    firstDigEvidenceRevisionHasNoNewSkills: [...current.skillIds].every(
      (currentSkillId) => baseline.skillIds.has(currentSkillId),
    ),
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

  const evidenceRevision = evidenceRevisionForOutcome(outcome, current);
  const noNewSkills = [...current.skillIds].every((skillId) =>
    baseline.skillIds.has(skillId),
  );
  if (
    evidenceRevision !== undefined &&
    baseline.skillIds.has(evidenceRevision.skillId) &&
    noNewSkills
  ) {
    return {
      source: "receipt_linked_revision_from_first_dig",
      skillId: evidenceRevision.skillId,
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

/** Verify an exact successful operation-to-revision link with a material change. */
export function evidenceRevisionForOutcome(
  outcome: FirstDigOutcome,
  snapshot: LearningHypothesisSnapshot,
): LearningEvidenceRevision | undefined {
  if (
    outcome.kind !== "dig" ||
    outcome.status !== "successful" ||
    outcome.skillId === undefined ||
    outcome.skillVersion === undefined
  ) {
    return undefined;
  }
  const evidenceRevision = snapshot.evidenceRevisionsByRunId.get(
    outcome.operationId,
  );
  if (
    evidenceRevision?.operationName !== "dig" ||
    evidenceRevision.observedOutcome !== "successful" ||
    evidenceRevision.receiptRunId !== outcome.operationId ||
    evidenceRevision.receiptSkillIdAtUse !== outcome.skillId ||
    evidenceRevision.receiptSkillVersionAtUse !== outcome.skillVersion ||
    evidenceRevision.skillId !== outcome.skillId ||
    evidenceRevision.skillVersionAtUse !== outcome.skillVersion ||
    evidenceRevision.revisionVersion <= outcome.skillVersion ||
    !snapshot.skillIds.has(evidenceRevision.skillId) ||
    !snapshot.revisionVersionsBySkill
      .get(evidenceRevision.skillId)
      ?.has(evidenceRevision.revisionVersion) ||
    !hasMaterialRevisionChange(
      snapshot.revisionDefinitionsBySkill
        .get(evidenceRevision.skillId)
        ?.get(evidenceRevision.skillVersionAtUse),
      snapshot.revisionDefinitionsBySkill
        .get(evidenceRevision.skillId)
        ?.get(evidenceRevision.revisionVersion),
    )
  ) {
    return undefined;
  }
  return evidenceRevision;
}

export function hasMaterialRevisionChange(
  before: LearningSkillDefinition | undefined,
  after: LearningSkillDefinition | undefined,
): boolean {
  return (
    before !== undefined &&
    after !== undefined &&
    (JSON.stringify(before.conditions) !== JSON.stringify(after.conditions) ||
      before.body !== after.body ||
      before.expectedOutcome !== after.expectedOutcome ||
      before.confidence !== after.confidence)
  );
}
