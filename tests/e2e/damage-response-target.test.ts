import { describe, expect, it } from "vitest";

import {
  DAMAGE_RESPONSE_CASE_BUDGET,
  classifyDamageResponsePostDamageJudgment,
  classifyRconActiveEffectsReply,
  damageResponseCleanupDisposition,
  damageResponseFoodBaselineConfirmed,
  damageResponseHasJudgmentLinkedOutcome,
  runBudgetCoversCase,
} from "./ai-player-live.js";
import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("damage response targeted E2E case", () => {
  it("keeps one bounded measurement within the run wrapper", () => {
    expect(DAMAGE_RESPONSE_CASE_BUDGET).toEqual({
      llmCalls: 16,
      totalTokens: 150_000,
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
  it("requires matching full-food oracles before changing the fixture", () => {
    expect(damageResponseFoodBaselineConfirmed(20, 20, 20)).toBe(true);
    expect(damageResponseFoodBaselineConfirmed(19, 20, 20)).toBe(false);
    expect(damageResponseFoodBaselineConfirmed(20, undefined, 20)).toBe(false);
  });

  it("links outcomes recorded during damage readback to a later judgment", () => {
    const damageAppliedAt = Date.parse("2026-09-28T12:00:00.000Z");
    const beforeOutcomes = [
      {
        operationId: "prior",
        kind: "look_sweep",
        status: "successful",
        observedAt: "2026-09-28T11:59:59.000Z",
      },
    ];
    const currentJudgments = [
      {
        revision: 2,
        decidedAt: "2026-09-28T12:00:01.000Z",
        operationKind: "look_sweep",
      },
    ];
    const currentOutcomes = [
      ...beforeOutcomes,
      {
        operationId: "readback-window",
        kind: "look_sweep",
        status: "successful",
        observedAt: "2026-09-28T12:00:02.000Z",
      },
    ];

    expect(
      damageResponseHasJudgmentLinkedOutcome(
        beforeOutcomes,
        currentJudgments,
        currentOutcomes,
        new Set(),
        damageAppliedAt,
      ),
    ).toBe(true);
    expect(
      damageResponseHasJudgmentLinkedOutcome(
        beforeOutcomes,
        currentJudgments,
        [
          ...beforeOutcomes,
          {
            operationId: "too-early",
            kind: "look_sweep",
            status: "successful",
            observedAt: "2026-09-28T12:00:00.500Z",
          },
        ],
        new Set(),
        damageAppliedAt,
      ),
    ).toBe(false);
  });

  it("classifies only fresh post-damage judgments as candidate or other", () => {
    const damageAppliedAt = Date.parse("2026-09-28T12:00:00.000Z");
    const classify = (
      operationKind?: string,
      decidedAt?: string,
      prior = new Set<string>(),
    ) =>
      classifyDamageResponsePostDamageJudgment(
        [
          {
            revision: 1,
            ...(operationKind === undefined ? {} : { operationKind }),
            ...(decidedAt === undefined ? {} : { decidedAt }),
          },
        ],
        prior,
        damageAppliedAt,
      );
    expect(classify("consume", "2026-09-28T12:01:00.000Z")).toBe("candidate");
    expect(classify("dig", "2026-09-28T12:01:00.000Z")).toBe("other");
    expect(classify("consume", "2026-09-28T11:59:00.000Z")).toBe(
      "not_observed",
    );
    expect(classify("consume")).toBe("unknown");
    expect(
      classify(
        "consume",
        "2026-09-28T12:01:00.000Z",
        new Set(["1:2026-09-28T12:01:00.000Z"]),
      ),
    ).toBe("not_observed");
  });

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
