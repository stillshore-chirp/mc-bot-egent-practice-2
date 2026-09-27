import { describe, expect, it } from "vitest";

import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("armor capability targeted E2E case", () => {
  it("selects armor_capability without unrelated prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("armor_capability");
    expect(
      isCaseSelectedForTarget("armor_capability", "armor_capability"),
    ).toBe(true);
    for (const caseId of [
      "runtime_contract",
      "autonomous_life",
      "game_action_discretion",
      "food_intent_continuity",
      "unknown_composite",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("armor_capability", caseId)).toBe(false);
    }
  });
});
