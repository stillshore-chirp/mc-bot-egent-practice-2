import { describe, expect, it } from "vitest";

import {
  countBoundedConsultedSkillIds,
  evidenceRevisionForOutcome,
  firstDigLearningDiagnostic,
  firstDigLearningEvidence,
  type LearningEvidenceRevision,
  type LearningSkillDefinition,
  type LearningHypothesisSnapshot,
} from "../e2e/learning-reuse-acceptance.js";

describe("bounded Skill reference evidence", () => {
  it("counts only unique references in the persisted library", () => {
    const persistedSkillIds = new Set(["skill-a", "skill-b", "skill-c"]);

    expect(
      countBoundedConsultedSkillIds(
        ["skill-a", "skill-a", "stale-skill"],
        persistedSkillIds,
      ),
    ).toBe(1);
  });

  it("requires a non-empty proper subset of persisted skills", () => {
    const persistedSkillIds = new Set(["skill-a", "skill-b"]);

    expect(countBoundedConsultedSkillIds([], persistedSkillIds)).toBe(
      undefined,
    );
    expect(
      countBoundedConsultedSkillIds(["skill-a", "skill-b"], persistedSkillIds),
    ).toBeUndefined();
  });
});

describe("first dig learning acceptance", () => {
  it("projects first-dig snapshot membership without exposing identifiers", () => {
    const baseline = snapshot({ skillIds: ["private-baseline-skill"] });
    const current = snapshot({
      skillIds: ["private-used-skill"],
      successfulDerivedSkillIds: ["private-used-skill"],
      revisionVersionsBySkill: [["private-used-skill", [1, 2]]],
      successfulDerivedHypothesesByRunId: [
        [
          "private-operation-id",
          { skillId: "private-used-skill", skillVersion: 2 },
        ],
      ],
    });

    const diagnostic = firstDigLearningDiagnostic(
      {
        operationId: "private-operation-id",
        kind: "dig",
        status: "successful",
        skillId: "private-used-skill",
        skillVersion: 2,
      },
      baseline,
      current,
    );

    expect(diagnostic).toMatchObject({
      outcomeKind: "dig",
      outcomeStatus: "successful",
      outcomeHasSkillAtUse: true,
      baselineHasOutcomeSkill: false,
      baselineOutcomeSkillIsTrustedDerived: false,
      currentHasOutcomeSkill: true,
      currentOutcomeSkillIsTrustedDerived: true,
      currentOutcomeSkillHasUsedRevision: true,
      firstDigDerivedHypothesisPresent: true,
      firstDigDerivedHypothesisIsTrustedDerived: true,
      firstDigDerivedHypothesisHasRevision: true,
      firstDigDerivedHypothesisMatchesOutcome: true,
      baselineSkillCount: 1,
      baselineTrustedDerivedSkillCount: 0,
      currentSkillCount: 1,
      currentTrustedDerivedSkillCount: 1,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
  });

  it("uses fixed safe labels for unknown outcome kind and status", () => {
    expect(
      firstDigLearningDiagnostic(
        {
          operationId: "private-operation-id",
          kind: "unrecognized-operation",
          status: "unrecognized-status",
        },
        snapshot(),
        snapshot(),
      ),
    ).toMatchObject({ outcomeKind: "other", outcomeStatus: "unknown" });
  });

  it("accepts a successful hypothesis derived from the exact first-dig receipt", () => {
    const baseline = snapshot();
    const current = snapshot({
      skillIds: ["derived-skill"],
      successfulDerivedSkillIds: ["derived-skill"],
      revisionVersionsBySkill: [["derived-skill", [1]]],
      successfulDerivedHypothesesByRunId: [
        ["first-dig", { skillId: "derived-skill", skillVersion: 1 }],
      ],
    });

    expect(
      firstDigLearningEvidence(
        { operationId: "first-dig", kind: "dig", status: "successful" },
        baseline,
        current,
      ),
    ).toEqual({
      source: "derived_from_first_dig",
      skillId: "derived-skill",
    });
  });

  it("accepts a baseline trusted-derived hypothesis when its used version is added later", () => {
    const baseline = snapshot({
      skillIds: ["existing-skill"],
      successfulDerivedSkillIds: ["existing-skill"],
      revisionVersionsBySkill: [["existing-skill", [1]]],
    });
    const current = snapshot({
      skillIds: ["existing-skill"],
      successfulDerivedSkillIds: ["existing-skill"],
      revisionVersionsBySkill: [["existing-skill", [1, 2]]],
    });

    expect(
      firstDigLearningEvidence(
        {
          operationId: "first-dig",
          kind: "dig",
          status: "successful",
          skillId: "existing-skill",
          skillVersion: 2,
        },
        baseline,
        current,
      ),
    ).toEqual({
      source: "preexisting_hypothesis_used",
      skillId: "existing-skill",
    });
  });

  it("accepts an existing Skill materially revised from the exact successful first-dig receipt", () => {
    const usedDefinition = definition({ body: "採掘前に対象を確認する。" });
    const revisedDefinition = definition({
      conditions: ["対象と足場を確認できた"],
      body: "採掘前に対象と足場を確かめ、採掘後に所持品の変化を確認する。",
      confidence: 0.6,
    });
    const baseline = snapshot({
      skillIds: ["existing-skill"],
      revisionVersionsBySkill: [["existing-skill", [1]]],
      revisionDefinitionsBySkill: [["existing-skill", [[1, usedDefinition]]]],
    });
    const current = snapshot({
      skillIds: ["existing-skill"],
      revisionVersionsBySkill: [["existing-skill", [1, 2]]],
      revisionDefinitionsBySkill: [
        [
          "existing-skill",
          [
            [1, usedDefinition],
            [2, revisedDefinition],
          ],
        ],
      ],
      evidenceRevisionsByRunId: [
        [
          "first-dig",
          {
            skillId: "existing-skill",
            operationName: "dig",
            observedOutcome: "successful",
            skillVersionAtUse: 1,
            revisionVersion: 2,
          },
        ],
      ],
    });
    const outcome = {
      operationId: "first-dig",
      kind: "dig",
      status: "successful",
      skillId: "existing-skill",
      skillVersion: 1,
    };

    expect(firstDigLearningEvidence(outcome, baseline, current)).toEqual({
      source: "receipt_linked_revision_from_first_dig",
      skillId: "existing-skill",
    });
    expect(
      firstDigLearningDiagnostic(outcome, baseline, current),
    ).toMatchObject({
      firstDigEvidenceRevisionPresent: true,
      firstDigEvidenceRevisionMatchesOutcome: true,
      firstDigEvidenceRevisionHasMaterialChange: true,
      firstDigEvidenceRevisionHasNoNewSkills: true,
    });
  });

  it("rejects the existing-Skill revision path when a new Skill was added", () => {
    const usedDefinition = definition();
    const current = snapshot({
      skillIds: ["existing-skill", "new-skill"],
      revisionVersionsBySkill: [["existing-skill", [1, 2]]],
      revisionDefinitionsBySkill: [
        [
          "existing-skill",
          [
            [1, usedDefinition],
            [2, definition({ body: "updated body" })],
          ],
        ],
      ],
      evidenceRevisionsByRunId: [
        [
          "first-dig",
          {
            skillId: "existing-skill",
            operationName: "dig",
            observedOutcome: "successful",
            skillVersionAtUse: 1,
            revisionVersion: 2,
          },
        ],
      ],
    });

    expect(
      firstDigLearningEvidence(
        {
          operationId: "first-dig",
          kind: "dig",
          status: "successful",
          skillId: "existing-skill",
          skillVersion: 1,
        },
        snapshot({
          skillIds: ["existing-skill"],
          revisionDefinitionsBySkill: [
            ["existing-skill", [[1, usedDefinition]]],
          ],
        }),
        current,
      ),
    ).toBeUndefined();
  });

  it("requires exact receipt operation, outcome, skill, and used version", () => {
    const definitions: [number, LearningSkillDefinition][] = [
      [1, definition()],
      [2, definition({ body: "materially revised" })],
      [3, definition({ expectedOutcome: "a later material revision" })],
    ];
    const mismatchedLinks = [
      {
        skillId: "existing-skill",
        operationName: "dig",
        observedOutcome: "successful",
        skillVersionAtUse: 1,
        revisionVersion: 2,
        receiptRunId: "different-run",
      },
      {
        skillId: "existing-skill",
        operationName: "dig",
        observedOutcome: "successful",
        skillVersionAtUse: 1,
        revisionVersion: 2,
        receiptSkillIdAtUse: "other-skill",
      },
      {
        skillId: "existing-skill",
        operationName: "dig",
        observedOutcome: "successful",
        skillVersionAtUse: 1,
        revisionVersion: 2,
        receiptSkillVersionAtUse: 2,
      },
      {
        skillId: "existing-skill",
        operationName: "move_to",
        observedOutcome: "successful",
        skillVersionAtUse: 1,
        revisionVersion: 2,
      },
      {
        skillId: "existing-skill",
        operationName: "dig",
        observedOutcome: "failed",
        skillVersionAtUse: 1,
        revisionVersion: 2,
      },
      {
        skillId: "other-skill",
        operationName: "dig",
        observedOutcome: "successful",
        skillVersionAtUse: 1,
        revisionVersion: 2,
      },
      {
        skillId: "existing-skill",
        operationName: "dig",
        observedOutcome: "successful",
        skillVersionAtUse: 2,
        revisionVersion: 3,
      },
    ];
    const outcome = {
      operationId: "first-dig",
      kind: "dig",
      status: "successful",
      skillId: "existing-skill",
      skillVersion: 1,
    };

    for (const link of mismatchedLinks) {
      expect(
        evidenceRevisionForOutcome(
          outcome,
          snapshot({
            skillIds: ["existing-skill"],
            revisionVersionsBySkill: [["existing-skill", [1, 2, 3]]],
            revisionDefinitionsBySkill: [["existing-skill", [...definitions]]],
            evidenceRevisionsByRunId: [["first-dig", link]],
          }),
        ),
      ).toBeUndefined();
    }
  });

  it("rejects an evidence revision without a material condition, body, expected-outcome, or confidence change", () => {
    const unchangedDefinition = definition();
    const current = snapshot({
      skillIds: ["existing-skill"],
      revisionVersionsBySkill: [["existing-skill", [1, 2]]],
      revisionDefinitionsBySkill: [
        [
          "existing-skill",
          [
            [1, unchangedDefinition],
            [2, unchangedDefinition],
          ],
        ],
      ],
      evidenceRevisionsByRunId: [
        [
          "first-dig",
          {
            skillId: "existing-skill",
            operationName: "dig",
            observedOutcome: "successful",
            skillVersionAtUse: 1,
            revisionVersion: 2,
          },
        ],
      ],
    });

    expect(
      firstDigLearningEvidence(
        {
          operationId: "first-dig",
          kind: "dig",
          status: "successful",
          skillId: "existing-skill",
          skillVersion: 1,
        },
        snapshot({ skillIds: ["existing-skill"] }),
        current,
      ),
    ).toBeUndefined();
  });

  it("verifies a later dig's trusted same-Skill revision from the exact used version", () => {
    const usedDefinition = definition({ body: "first update" });
    const current = snapshot({
      skillIds: ["learned-skill"],
      revisionVersionsBySkill: [["learned-skill", [1, 2, 3]]],
      revisionDefinitionsBySkill: [
        [
          "learned-skill",
          [
            [1, definition()],
            [2, usedDefinition],
            [3, definition({ expectedOutcome: "world and inventory changed" })],
          ],
        ],
      ],
      evidenceRevisionsByRunId: [
        [
          "second-dig",
          {
            skillId: "learned-skill",
            operationName: "dig",
            observedOutcome: "successful",
            skillVersionAtUse: 2,
            revisionVersion: 3,
          },
        ],
      ],
    });

    expect(
      evidenceRevisionForOutcome(
        {
          operationId: "second-dig",
          kind: "dig",
          status: "successful",
          skillId: "learned-skill",
          skillVersion: 2,
        },
        current,
      ),
    ).toMatchObject({
      skillId: "learned-skill",
      skillVersionAtUse: 2,
      revisionVersion: 3,
    });
  });

  it.each([
    {
      label: "an unrelated derivation",
      baseline: snapshot(),
      current: snapshot({
        skillIds: ["other-skill"],
        successfulDerivedSkillIds: ["other-skill"],
        revisionVersionsBySkill: [["other-skill", [1]]],
        successfulDerivedHypothesesByRunId: [
          ["other-dig", { skillId: "other-skill", skillVersion: 1 }],
        ],
      }),
      skillId: undefined,
      skillVersion: undefined,
    },
    {
      label: "a non-derived skill used by the first dig",
      baseline: snapshot({
        skillIds: ["imported-skill"],
        revisionVersionsBySkill: [["imported-skill", [1]]],
      }),
      current: snapshot(),
      skillId: "imported-skill",
      skillVersion: 1,
    },
    {
      label: "a version missing from the current revision history",
      baseline: snapshot({
        skillIds: ["existing-skill"],
        successfulDerivedSkillIds: ["existing-skill"],
        revisionVersionsBySkill: [["existing-skill", [1]]],
      }),
      current: snapshot({
        skillIds: ["existing-skill"],
        successfulDerivedSkillIds: ["existing-skill"],
        revisionVersionsBySkill: [["existing-skill", [1]]],
      }),
      skillId: "existing-skill",
      skillVersion: 2,
    },
  ])("rejects $label", ({ baseline, current, skillId, skillVersion }) => {
    expect(
      firstDigLearningEvidence(
        {
          operationId: "first-dig",
          kind: "dig",
          status: "successful",
          ...(skillId === undefined ? {} : { skillId }),
          ...(skillVersion === undefined ? {} : { skillVersion }),
        },
        baseline,
        current,
      ),
    ).toBeUndefined();
  });

  it("does not treat failed or non-dig outcomes as the learning fixture", () => {
    const empty = snapshot();

    expect(
      firstDigLearningEvidence(
        { operationId: "first-dig", kind: "dig", status: "failed" },
        empty,
        empty,
      ),
    ).toBeUndefined();
    expect(
      firstDigLearningEvidence(
        { operationId: "first-dig", kind: "move_to", status: "successful" },
        empty,
        empty,
      ),
    ).toBeUndefined();
  });
});

function snapshot(
  input: {
    skillIds?: string[];
    successfulDerivedSkillIds?: string[];
    revisionVersionsBySkill?: [string, number[]][];
    successfulDerivedHypothesesByRunId?: [
      string,
      { skillId: string; skillVersion: number },
    ][];
    revisionDefinitionsBySkill?: [
      string,
      [number, LearningSkillDefinition][],
    ][];
    evidenceRevisionsByRunId?: [
      string,
      Omit<
        LearningEvidenceRevision,
        "receiptRunId" | "receiptSkillIdAtUse" | "receiptSkillVersionAtUse"
      > &
        Partial<
          Pick<
            LearningEvidenceRevision,
            "receiptRunId" | "receiptSkillIdAtUse" | "receiptSkillVersionAtUse"
          >
        >,
    ][];
  } = {},
): LearningHypothesisSnapshot {
  return {
    skillIds: new Set(input.skillIds ?? []),
    successfulDerivedSkillIds: new Set(input.successfulDerivedSkillIds ?? []),
    revisionVersionsBySkill: new Map(
      (input.revisionVersionsBySkill ?? []).map(([skillId, versions]) => [
        skillId,
        new Set(versions),
      ]),
    ),
    revisionDefinitionsBySkill: new Map(
      (input.revisionDefinitionsBySkill ?? []).map(([skillId, revisions]) => [
        skillId,
        new Map(revisions),
      ]),
    ),
    successfulDerivedHypothesesByRunId: new Map(
      input.successfulDerivedHypothesesByRunId ?? [],
    ),
    evidenceRevisionsByRunId: new Map(
      (input.evidenceRevisionsByRunId ?? []).map(
        ([runId, evidenceRevision]) => [
          runId,
          {
            ...evidenceRevision,
            receiptRunId: evidenceRevision.receiptRunId ?? runId,
            receiptSkillIdAtUse:
              evidenceRevision.receiptSkillIdAtUse ?? evidenceRevision.skillId,
            receiptSkillVersionAtUse:
              evidenceRevision.receiptSkillVersionAtUse ??
              evidenceRevision.skillVersionAtUse,
          },
        ],
      ),
    ),
  };
}

function definition(
  overrides: Partial<LearningSkillDefinition> = {},
): LearningSkillDefinition {
  return {
    conditions: ["対象を確認できた"],
    body: "対象を掘って結果を確かめる。",
    expectedOutcome: "対象と所持品の変化を確認する。",
    confidence: 0.4,
    ...overrides,
  };
}
