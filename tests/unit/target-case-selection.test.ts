import { describe, expect, it } from "vitest";

import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "../e2e/target-case-selection.js";

describe("targeted E2E case selection", () => {
  it("runs only learning_reuse and its autonomous_life prerequisite", () => {
    expect(TARGETABLE_CASES).toContain("learning_reuse");
    expect(isCaseSelectedForTarget("learning_reuse", "learning_reuse")).toBe(
      true,
    );
    expect(isCaseSelectedForTarget("learning_reuse", "autonomous_life")).toBe(
      true,
    );
    for (const caseId of [
      "runtime_contract",
      "unknown_composite",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("learning_reuse", caseId)).toBe(false);
    }
  });

  it("preserves the autonomous_life prerequisite for unknown_composite", () => {
    expect(
      isCaseSelectedForTarget("unknown_composite", "autonomous_life"),
    ).toBe(true);
    expect(
      isCaseSelectedForTarget("unknown_composite", "unknown_composite"),
    ).toBe(true);
    expect(isCaseSelectedForTarget("unknown_composite", "learning_reuse")).toBe(
      false,
    );
  });

  it("runs skill acceptance targets with only their bounded learning chain", () => {
    const skillTargets = [
      "skill_compactness_and_knowledge_separation",
      "skill_exchange",
    ] as const;
    for (const targetCase of skillTargets) {
      expect(TARGETABLE_CASES).toContain(targetCase);
      for (const selectedCase of [
        "autonomous_life",
        "learning_reuse",
        targetCase,
      ]) {
        expect(isCaseSelectedForTarget(targetCase, selectedCase)).toBe(true);
      }
      for (const skippedCase of [
        "runtime_contract",
        "observation_boundary",
        "persistent_memory_restart",
        ...skillTargets.filter((skillCase) => skillCase !== targetCase),
        "game_action_discretion",
        "unknown_composite",
        "parallel_dialogue_stop",
        "integrated_result",
      ]) {
        expect(isCaseSelectedForTarget(targetCase, skippedCase)).toBe(false);
      }
    }
  });

  it("does not add autonomous_life to unrelated target cases", () => {
    expect(
      isCaseSelectedForTarget("game_action_discretion", "autonomous_life"),
    ).toBe(false);
    expect(
      isCaseSelectedForTarget("parallel_dialogue_stop", "autonomous_life"),
    ).toBe(false);
  });

  it("selects every case when no target is configured", () => {
    expect(isCaseSelectedForTarget(undefined, "autonomous_life")).toBe(true);
    expect(isCaseSelectedForTarget(undefined, "integrated_result")).toBe(true);
  });
});
