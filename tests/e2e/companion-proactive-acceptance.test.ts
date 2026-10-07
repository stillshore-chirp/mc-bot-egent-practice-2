import { describe, expect, it } from "vitest";

import {
  proactiveBedCompletionConfirmed,
  proactiveFoodUseConfirmed,
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
} as const;

describe("companion proactive acceptance", () => {
  it("keeps food and bed as independent opt-in targets", () => {
    for (const target of [
      "companion_proactive_food",
      "companion_proactive_bed",
    ] as const) {
      expect(TARGETABLE_CASES).toContain(target);
      expect(isCaseSelectedForTarget(undefined, target)).toBe(false);
      expect(isCaseSelectedForTarget(target, target)).toBe(true);
      expect(isCaseSelectedForTarget(target, "autonomous_life")).toBe(false);
    }
    expect(TARGETABLE_CASES).not.toContain("companion_proactive_threat");
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
      foodBefore: 12,
      foodAfter: 18,
      bodyFoodAfter: 18,
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
