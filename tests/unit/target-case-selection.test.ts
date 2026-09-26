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
