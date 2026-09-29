import { describe, expect, it } from "vitest";

import {
  UNDERWATER_ITEM_RECOVERY_CASE_BUDGET,
  runBudgetCoversCase,
  underwaterRecoveryPickupMatchesTarget,
} from "./ai-player-live.js";
import {
  isCaseSelectedForTarget,
  isUnderwaterItemRecoveryTargeted,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("underwater item recovery targeted E2E case", () => {
  it("requires the fresh item target and a matching oak-log pickup result", () => {
    const evidence = {
      operationKind: "collect_item",
      operationEntityId: 42,
      status: "successful",
      itemCollectionOutcome: "collected",
      effectType: "item_collected",
      effectEntityId: 42,
      beforeOakLogs: 0,
      afterOakLogs: 1,
    };

    expect(underwaterRecoveryPickupMatchesTarget(42, evidence)).toBe(true);
    expect(underwaterRecoveryPickupMatchesTarget(43, evidence)).toBe(false);
    expect(
      underwaterRecoveryPickupMatchesTarget(42, {
        ...evidence,
        effectEntityId: undefined,
      }),
    ).toBe(false);
    expect(
      underwaterRecoveryPickupMatchesTarget(42, {
        ...evidence,
        afterOakLogs: 0,
      }),
    ).toBe(false);
  });

  it("runs only when explicitly selected and fits the standard wrapper", () => {
    expect(TARGETABLE_CASES).toContain("underwater_item_recovery");
    expect(isUnderwaterItemRecoveryTargeted(undefined)).toBe(false);
    expect(isUnderwaterItemRecoveryTargeted("underwater_item_recovery")).toBe(
      true,
    );
    expect(
      isCaseSelectedForTarget(
        "underwater_item_recovery",
        "underwater_item_recovery",
      ),
    ).toBe(true);
    for (const caseId of [
      "autonomous_life",
      "gather_multi_target_continuity",
      "owner_stop_latch",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("underwater_item_recovery", caseId)).toBe(
        false,
      );
    }
    expect(
      runBudgetCoversCase(
        { llmCalls: 160, totalTokens: 800_000 },
        UNDERWATER_ITEM_RECOVERY_CASE_BUDGET,
      ),
    ).toBe(true);
  });
});
