import { describe, expect, it } from "vitest";

import {
  DAMAGE_RESPONSE_CASE_BUDGET,
  classifyRconActiveEffectsReply,
  damageResponseCleanupDisposition,
  runBudgetCoversCase,
} from "./ai-player-live.js";
import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("damage response targeted E2E case", () => {
  it("keeps one bounded measurement within the run wrapper", () => {
    expect(DAMAGE_RESPONSE_CASE_BUDGET).toEqual({
      llmCalls: 8,
      totalTokens: 75_000,
    });
    expect(
      runBudgetCoversCase(
        { llmCalls: 160, totalTokens: 800_000 },
        DAMAGE_RESPONSE_CASE_BUDGET,
      ),
    ).toBe(true);
    expect(
      runBudgetCoversCase(
        { llmCalls: 6, totalTokens: 35_000 },
        DAMAGE_RESPONSE_CASE_BUDGET,
      ),
    ).toBe(false);
  });

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

describe("damage response fixture diagnostics", () => {
  it("recognizes the known no-effects reply and keeps other replies unknown", () => {
    expect(
      classifyRconActiveEffectsReply(
        "Found no elements matching active_effects",
      ),
    ).toBe("empty");
    expect(classifyRconActiveEffectsReply("[]")).toBe("empty");
    expect(classifyRconActiveEffectsReply('[{id: "minecraft:hunger"}]')).toBe(
      "active",
    );
    expect(
      classifyRconActiveEffectsReply("Found no elements matching Health"),
    ).toBe("unknown");
  });

  it("retains the primary failure when cleanup also fails", () => {
    expect(
      damageResponseCleanupDisposition(
        "DAMAGE_RESPONSE_BASELINE_EFFECTS_STATE_UNAVAILABLE",
        false,
      ),
    ).toEqual({
      primaryFailureCode: "DAMAGE_RESPONSE_BASELINE_EFFECTS_STATE_UNAVAILABLE",
      cleanupFailureCode: "DAMAGE_RESPONSE_FIXTURE_CLEANUP_NOT_CONFIRMED",
      throwCleanupFailure: false,
    });
  });

  it("uses the cleanup failure when no earlier failure exists", () => {
    expect(damageResponseCleanupDisposition(undefined, false)).toEqual({
      cleanupFailureCode: "DAMAGE_RESPONSE_FIXTURE_CLEANUP_NOT_CONFIRMED",
      throwCleanupFailure: true,
    });
    expect(damageResponseCleanupDisposition(undefined, true)).toBeUndefined();
  });
});
