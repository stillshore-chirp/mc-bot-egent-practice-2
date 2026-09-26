import { describe, expect, it } from "vitest";

import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("food intent targeted E2E case", () => {
  it("selects food_intent_continuity without unrelated prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("food_intent_continuity");
    expect(
      isCaseSelectedForTarget(
        "food_intent_continuity",
        "food_intent_continuity",
      ),
    ).toBe(true);
    for (const caseId of [
      "runtime_contract",
      "autonomous_life",
      "game_action_discretion",
      "unknown_composite",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("food_intent_continuity", caseId)).toBe(
        false,
      );
    }
  });
});
