import { describe, expect, it } from "vitest";

import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("damage response targeted E2E case", () => {
  it("selects only damage_response without unrelated prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("damage_response");
    expect(isCaseSelectedForTarget("damage_response", "damage_response")).toBe(
      true,
    );
    for (const caseId of [
      "runtime_contract",
      "autonomous_life",
      "food_intent_continuity",
      "unknown_composite",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("damage_response", caseId)).toBe(false);
    }
  });
});
