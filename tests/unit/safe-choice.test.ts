import { describe, expect, it } from "vitest";

import {
  chooseSafeCandidate,
  type SafeChoiceCandidate,
} from "../../src/decision/safe-choice.js";

function candidate(
  overrides: Partial<SafeChoiceCandidate> = {},
): SafeChoiceCandidate {
  return {
    id: "follow-owner",
    label: "利用者への追従",
    action: "follow_player",
    observed: true,
    purposeFit: "direct",
    permission: "allowed",
    safety: "allowed",
    reversible: true,
    impact: "low",
    distance: 4,
    order: 0,
    ...overrides,
  };
}

describe("safe choice policy", () => {
  it("selects the closest safe candidate for a delegated non-log action", () => {
    const result = chooseSafeCandidate({
      mode: "delegated",
      candidates: [
        candidate({
          id: "return-owner",
          label: "利用者の近くへ戻る",
          action: "return_to_player",
          distance: 8,
          order: 1,
        }),
        candidate({ distance: 2 }),
      ],
    });

    expect(result).toMatchObject({
      outcome: "selected",
      candidate: { id: "follow-owner", action: "follow_player" },
    });
    if (result.outcome === "selected") {
      expect(result.reason).toContain("観測済み");
      expect(result.reason).toContain("安全条件");
    }
  });

  it("does not ask again when the user delegated a safe tie", () => {
    const result = chooseSafeCandidate({
      mode: "delegated",
      candidates: [
        candidate({ id: "second", distance: 3, order: 1 }),
        candidate({ id: "first", distance: 3, order: 0 }),
      ],
    });

    expect(result).toMatchObject({
      outcome: "selected",
      candidate: { id: "first" },
    });
  });

  it.each([
    {
      label: "unknown safety",
      overrides: { safety: "unknown" as const },
      code: "CHOICE_NOT_CONFIRMED",
    },
    {
      label: "protected candidate",
      overrides: { safety: "blocked" as const },
      code: "CHOICE_BLOCKED",
    },
    {
      label: "unobserved candidate",
      overrides: { observed: false },
      code: "CHOICE_NOT_OBSERVED",
    },
  ])("asks a concrete question for $label", ({ overrides, code }) => {
    const result = chooseSafeCandidate({
      mode: "delegated",
      candidates: [candidate(overrides)],
    });

    expect(result).toMatchObject({ outcome: "clarify", code });
    if (result.outcome === "clarify") {
      expect(result.question).not.toContain("MAIN_TASK_BUSY");
      expect(result.question.length).toBeGreaterThan(10);
    }
  });

  it("refuses a high-impact candidate even when the user delegated selection", () => {
    const result = chooseSafeCandidate({
      mode: "delegated",
      candidates: [candidate({ action: "destroy_structure", impact: "high" })],
    });

    expect(result).toMatchObject({
      outcome: "clarify",
      code: "CHOICE_NOT_CONFIRMED",
    });
  });

  it("allows bounded natural-resource mining only with trusted owner authorization", () => {
    const mining = candidate({
      id: "mine-iron",
      label: "観測済みの鉄鉱石",
      action: "mine_resource",
      operationClass: "natural_resource",
      resourceName: "iron_ore",
      goalItem: "raw_iron",
      reversible: false,
      impact: "medium",
    });

    expect(
      chooseSafeCandidate({ mode: "delegated", candidates: [mining] }),
    ).toMatchObject({ outcome: "clarify", code: "CHOICE_NOT_CONFIRMED" });
    expect(
      chooseSafeCandidate({
        mode: "explicit",
        requestedId: "mine-iron",
        candidates: [mining],
        authorization: {
          kind: "owner_bounded_resource",
          goal: "ironを集める",
          allowedResources: ["iron_ore"],
          targetItem: "raw_iron",
          targetCount: 1,
          maxCount: 8,
        },
      }),
    ).toMatchObject({
      outcome: "selected",
      candidate: { id: "mine-iron", impact: "medium" },
    });
  });

  it("requires an explicit area scope for world-changing candidates", () => {
    const place = candidate({
      id: "place-wall",
      label: "指定範囲への設置",
      action: "place_block",
      operationClass: "world_change",
      scopeId: "base-wall",
      reversible: false,
      impact: "medium",
    });

    expect(
      chooseSafeCandidate({
        mode: "explicit",
        requestedId: "place-wall",
        candidates: [place],
        authorization: {
          kind: "owner_scoped_change",
          scopeId: "other-area",
          maxImpact: "medium",
        },
      }),
    ).toMatchObject({ outcome: "clarify", code: "CHOICE_REQUESTED_UNSAFE" });
    expect(
      chooseSafeCandidate({
        mode: "explicit",
        requestedId: "place-wall",
        candidates: [place],
        authorization: {
          kind: "owner_scoped_change",
          scopeId: "base-wall",
          maxImpact: "medium",
        },
      }),
    ).toMatchObject({ outcome: "selected", candidate: { id: "place-wall" } });
  });

  it("requires explicit delegation before choosing among safe candidates", () => {
    const result = chooseSafeCandidate({
      mode: "unspecified",
      candidates: [candidate()],
    });

    expect(result).toMatchObject({
      outcome: "clarify",
      code: "CHOICE_NOT_DELEGATED",
    });
  });

  it("does not execute an explicitly requested unsafe candidate", () => {
    const result = chooseSafeCandidate({
      mode: "explicit",
      requestedId: "protected",
      candidates: [
        candidate({
          id: "protected",
          label: "保護された建築物",
          safety: "blocked",
        }),
      ],
    });

    expect(result).toMatchObject({
      outcome: "clarify",
      code: "CHOICE_REQUESTED_UNSAFE",
    });
  });
});
