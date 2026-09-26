import { describe, expect, it } from "vitest";

import {
  firstDigLearningEvidence,
  type LearningHypothesisSnapshot,
} from "../e2e/learning-reuse-acceptance.js";

describe("first dig learning acceptance", () => {
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
    successfulDerivedHypothesesByRunId: new Map(
      input.successfulDerivedHypothesesByRunId ?? [],
    ),
  };
}
