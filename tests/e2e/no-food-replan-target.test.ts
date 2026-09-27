import { describe, expect, it } from "vitest";

import {
  classifyNoFoodReplanDecision,
  isNoFoodReplanPurposeAfterOutcome,
  noFoodReplanBeforeCallBlockReason,
  noFoodReplanOraclesConfirmed,
  NO_FOOD_REPLAN_CASE_BUDGET,
  runBudgetCoversCase,
} from "./ai-player-live.js";
import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("no-food replan targeted E2E case", () => {
  it("blocks provider sends at the call, observed-token, and unknown-usage boundary", () => {
    expect(
      noFoodReplanBeforeCallBlockReason(
        NO_FOOD_REPLAN_CASE_BUDGET.llmCalls - 1,
        0,
        NO_FOOD_REPLAN_CASE_BUDGET.totalTokens - 1,
      ),
    ).toBeUndefined();
    expect(
      noFoodReplanBeforeCallBlockReason(
        NO_FOOD_REPLAN_CASE_BUDGET.llmCalls,
        0,
        0,
      ),
    ).toBe("CASE_LLM_BUDGET_EXCEEDED");
    expect(
      noFoodReplanBeforeCallBlockReason(
        0,
        0,
        NO_FOOD_REPLAN_CASE_BUDGET.totalTokens,
      ),
    ).toBe("CASE_LLM_BUDGET_EXCEEDED");
    expect(noFoodReplanBeforeCallBlockReason(0, 1, 0)).toBe(
      "LLM_USAGE_PARTIAL_OR_UNKNOWN",
    );
    expect(
      runBudgetCoversCase(
        { llmCalls: 160, totalTokens: 800_000 },
        NO_FOOD_REPLAN_CASE_BUDGET,
      ),
    ).toBe(true);
    expect(
      runBudgetCoversCase(
        {
          llmCalls: NO_FOOD_REPLAN_CASE_BUDGET.llmCalls - 1,
          totalTokens: NO_FOOD_REPLAN_CASE_BUDGET.totalTokens,
        },
        NO_FOOD_REPLAN_CASE_BUDGET,
      ),
    ).toBe(false);
  });

  it("requires Body and RCON Health and Food to agree on a no-food oracle", () => {
    expect(noFoodReplanOraclesConfirmed(4, 4, 13, 13, true, true)).toBe(true);
    expect(noFoodReplanOraclesConfirmed(4, 3, 13, 13, true, true)).toBe(false);
    expect(noFoodReplanOraclesConfirmed(4, 4, 13, 12, true, true)).toBe(false);
  });

  it("accepts only a Purpose judgment timestamped after the successful outcome", () => {
    expect(
      isNoFoodReplanPurposeAfterOutcome(
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBe(true);
    expect(
      isNoFoodReplanPurposeAfterOutcome(
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBe(false);
    expect(
      isNoFoodReplanPurposeAfterOutcome(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBe(false);
  });

  it("selects no_food_replan without unrelated prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("no_food_replan");
    expect(isCaseSelectedForTarget("no_food_replan", "no_food_replan")).toBe(
      true,
    );
    for (const caseId of [
      "runtime_contract",
      "autonomous_life",
      "food_intent_continuity",
      "damage_response",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("no_food_replan", caseId)).toBe(false);
    }
  });

  it("projects only fixed decision classes", () => {
    expect(classifyNoFoodReplanDecision("act", "consume")).toBe("consume");
    expect(classifyNoFoodReplanDecision("act", "move_to")).toBe("alternative");
    expect(classifyNoFoodReplanDecision("wait", undefined)).toBe("wait");
    expect(classifyNoFoodReplanDecision("act", "untrusted-value")).toBe(
      "unknown",
    );
  });
});
