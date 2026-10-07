import { describe, expect, it } from "vitest";

import {
  COMPANION_PROACTIVE_CASE_BUDGET,
  COMPANION_PROACTIVE_CASE_DEADLINE_MS,
  COMPANION_PROACTIVE_FOCUSED_CASE_BUDGET,
  COMPANION_PROACTIVE_FOCUSED_CASE_DEADLINE_MS,
  COMPANION_PROACTIVE_FOCUSED_RUN_BUDGET,
  COMPANION_PROACTIVE_RUN_BUDGET,
  COMPANION_PROACTIVE_THREAT_CASE_BUDGET,
  COMPANION_PROACTIVE_THREAT_CASE_DEADLINE_MS,
  COMPANION_PROACTIVE_THREAT_RUN_BUDGET,
  proactiveBedCompletionConfirmed,
  proactiveFoodUseConfirmed,
  proactiveThreatResponseConfirmed,
} from "./companion-proactive-acceptance.js";
import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

const successfulConsume = {
  kind: "consume",
  status: "successful",
  startedAt: "2026-10-08T12:00:00.000Z",
  completedAt: "2026-10-08T12:00:02.000Z",
  sameLife: true,
  recoveryRequired: false,
} as const;
const successfulCollection = {
  kind: "collect_item",
  status: "successful",
  startedAt: "2026-10-08T12:00:00.000Z",
  completedAt: "2026-10-08T12:00:02.000Z",
  sameLife: true,
  recoveryRequired: false,
  operationEntityId: 42,
  observedEffectType: "item_collected",
  observedEffectEntityId: 42,
} as const;
const successfulMove = {
  kind: "move_to",
  status: "successful",
  startedAt: "2026-10-08T12:00:00.000Z",
  completedAt: "2026-10-08T12:00:02.000Z",
  sameLife: true,
  recoveryRequired: false,
  healthBefore: 20,
} as const;

describe("companion proactive acceptance", () => {
  it("keeps proactive targets as independent opt-in cases", () => {
    for (const target of [
      "companion_proactive_food",
      "companion_proactive_bed",
      "companion_proactive_threat",
    ] as const) {
      expect(TARGETABLE_CASES).toContain(target);
      expect(isCaseSelectedForTarget(undefined, target)).toBe(false);
      expect(isCaseSelectedForTarget(target, target)).toBe(true);
      expect(isCaseSelectedForTarget(target, "autonomous_life")).toBe(false);
    }
  });

  it("caps the food probe separately while retaining the bed budget", () => {
    expect(COMPANION_PROACTIVE_FOCUSED_CASE_BUDGET).toEqual({
      llmCalls: 32,
      totalTokens: 280_000,
    });
    expect(COMPANION_PROACTIVE_FOCUSED_CASE_DEADLINE_MS).toBe(8 * 60_000);
    expect(COMPANION_PROACTIVE_FOCUSED_RUN_BUDGET).toEqual({
      durationMs: 10 * 60_000,
      llmCalls: 32,
      totalTokens: 280_000,
    });
    expect(COMPANION_PROACTIVE_CASE_BUDGET).toEqual({
      llmCalls: 80,
      totalTokens: 800_000,
    });
    expect(COMPANION_PROACTIVE_CASE_DEADLINE_MS).toBe(20 * 60_000);
    expect(COMPANION_PROACTIVE_RUN_BUDGET.durationMs).toBe(25 * 60_000);
    expect(COMPANION_PROACTIVE_THREAT_CASE_BUDGET).toEqual({
      llmCalls: 32,
      totalTokens: 280_000,
    });
    expect(COMPANION_PROACTIVE_THREAT_CASE_DEADLINE_MS).toBe(8 * 60_000);
    expect(COMPANION_PROACTIVE_THREAT_RUN_BUDGET.durationMs).toBe(10 * 60_000);
  });

  it("requires Purpose-linked same-life position adjustment before damage with readbacks", () => {
    const valid = {
      ownerPromptCount: 0,
      freshPurposeDecision: true,
      purposeDecisionLinkedToAction: true,
      naturalRegenerationDisabled: true,
      freshHostileObservationBefore: true,
      bodyHostileCountBefore: 1,
      serverHostileCountBefore: 1,
      serverDistanceBefore: 14,
      bodyDistanceBefore: 13.8,
      bodyServerDistanceAlignedBefore: true,
      action: successfulMove,
      actionStartedBeforeDamage: true,
      bodyObservationAfterAction: true,
      bodyHostileCountAfter: 1,
      serverHostileCountAfter: 1,
      serverPositionChanged: true,
      bodyServerPositionAlignedAfter: true,
      bodyDistanceAfter: 15.2,
      serverDistanceAfter: 15,
      bodyServerDistanceAlignedAfter: true,
      healthBefore: 20,
      rconHealthAfter: 20,
      bodyHealthBefore: 20,
      bodyHealthAfter: 20,
      bodyServerHealthAlignedBefore: true,
      bodyServerHealthAlignedAfter: true,
    };
    expect(proactiveThreatResponseConfirmed(valid)).toBe(true);
    expect(
      proactiveThreatResponseConfirmed({
        ...valid,
        action: { ...successfulMove, kind: "control" },
        bodyDistanceAfter: 13.9,
        serverDistanceAfter: 14.1,
      }),
    ).toBe(true);
    expect(
      proactiveThreatResponseConfirmed({
        ...valid,
        actionStartedBeforeDamage: false,
      }),
    ).toBe(false);
    expect(
      proactiveThreatResponseConfirmed({
        ...valid,
        purposeDecisionLinkedToAction: false,
      }),
    ).toBe(false);
    expect(
      proactiveThreatResponseConfirmed({
        ...valid,
        serverPositionChanged: false,
      }),
    ).toBe(false);
    expect(
      proactiveThreatResponseConfirmed({ ...valid, ownerPromptCount: 1 }),
    ).toBe(false);
    expect(
      proactiveThreatResponseConfirmed({
        ...valid,
        bodyServerHealthAlignedAfter: false,
      }),
    ).toBe(false);
    expect(
      proactiveThreatResponseConfirmed({
        ...valid,
        action: { ...successfulMove, healthBefore: 18 },
      }),
    ).toBe(false);
  });

  it("accepts purposeful approach or exact-item collection with inventory delta and hunger recovery", () => {
    const valid = {
      freshPurposeDecision: true,
      preObservationConfirmed: true,
      movementTowardDropObserved: true,
      approachAction: successfulMove,
      targetEntityId: 42,
      bodyInventoryIncreaseObserved: true,
      serverInventoryIncreaseObserved: true,
      consumeAction: successfulConsume,
      dropCountAfter: 0,
      foodBefore: 6,
      foodAfter: 11,
      bodyFoodAfter: 11,
      healthUnchanged: true,
    };
    expect(proactiveFoodUseConfirmed(valid)).toBe(true);
    expect(
      proactiveFoodUseConfirmed({ ...valid, freshPurposeDecision: false }),
    ).toBe(false);
    expect(
      proactiveFoodUseConfirmed({ ...valid, preObservationConfirmed: false }),
    ).toBe(false);
    expect(
      proactiveFoodUseConfirmed({
        ...valid,
        movementTowardDropObserved: false,
      }),
    ).toBe(false);
    expect(
      proactiveFoodUseConfirmed({ ...valid, approachAction: undefined }),
    ).toBe(false);
    expect(
      proactiveFoodUseConfirmed({
        ...valid,
        approachAction: { ...successfulMove, sameLife: false },
      }),
    ).toBe(false);
    expect(
      proactiveFoodUseConfirmed({
        ...valid,
        approachAction: successfulCollection,
      }),
    ).toBe(true);
    expect(
      proactiveFoodUseConfirmed({
        ...valid,
        approachAction: {
          ...successfulCollection,
          observedEffectEntityId: 41,
        },
      }),
    ).toBe(false);
    expect(
      proactiveFoodUseConfirmed({
        ...valid,
        bodyInventoryIncreaseObserved: false,
      }),
    ).toBe(false);
    expect(
      proactiveFoodUseConfirmed({
        ...valid,
        serverInventoryIncreaseObserved: false,
      }),
    ).toBe(false);
    expect(
      proactiveFoodUseConfirmed({
        ...valid,
        consumeAction: { ...successfulConsume, sameLife: false },
      }),
    ).toBe(false);
    expect(proactiveFoodUseConfirmed({ ...valid, dropCountAfter: 1 })).toBe(
      false,
    );
    expect(proactiveFoodUseConfirmed({ ...valid, foodAfter: 12 })).toBe(false);
    expect(proactiveFoodUseConfirmed({ ...valid, bodyFoodAfter: 17 })).toBe(
      false,
    );
    expect(
      proactiveFoodUseConfirmed({ ...valid, healthUnchanged: false }),
    ).toBe(false);
  });

  it("requires one bed request, same-goal work, crafted intermediate, placed bed, and completion", () => {
    const valid = {
      oneOwnerPrompt: true,
      ownerGoalAccepted: true,
      freshPurposeDecision: true,
      sameOwnerGoalAcrossWork: true,
      successfulCraft: true,
      serverCraftingTable: true,
      serverBed: true,
      targetOwnerGoalCompleted: true,
    };
    expect(proactiveBedCompletionConfirmed(valid)).toBe(true);
    for (const key of Object.keys(valid) as (keyof typeof valid)[]) {
      expect(proactiveBedCompletionConfirmed({ ...valid, [key]: false })).toBe(
        false,
      );
    }
  });
});
