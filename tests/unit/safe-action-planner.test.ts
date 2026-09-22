import { describe, expect, it } from "vitest";

import {
  planSafeAction,
  type SafeActionCandidate,
} from "../../src/decision/safe-action-planner.js";

function candidate(
  overrides: Partial<SafeActionCandidate> = {},
): SafeActionCandidate {
  return {
    id: "collect-resource",
    label: "安全な資源を集める",
    action: "gather_resource",
    observed: true,
    purposeFit: "direct",
    permission: "allowed",
    safety: "allowed",
    reversible: true,
    impact: "low",
    distance: 4,
    steps: [
      { tool: "move_to", input: { x: 1, y: 64, z: 1, radius: 2 } },
      {
        tool: "gather_resource",
        input: { resource: "oak_log", count: 1, commitmentId: null },
      },
    ],
    ...overrides,
  };
}

describe("safe action planner", () => {
  it("preserves a bounded multi-step plan after delegated safe selection", () => {
    const result = planSafeAction({
      mode: "delegated",
      candidates: [candidate()],
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      outcome: "planned",
      candidate: { id: "collect-resource" },
      steps: [{ tool: "move_to" }, { tool: "gather_resource" }],
    });
  });

  it("allows a provider-observed candidate to be selected explicitly", () => {
    const result = planSafeAction({
      mode: "explicit",
      requestedId: "return-owner",
      candidates: [
        candidate({ id: "collect-resource", distance: 1 }),
        candidate({
          id: "return-owner",
          label: "利用者へ戻る",
          action: "return_to_player",
          steps: [{ tool: "return_to_player", input: { safeDistance: 3 } }],
        }),
      ],
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      outcome: "planned",
      candidate: { id: "return-owner", action: "return_to_player" },
    });
  });

  it("stops when a candidate has an unbounded or recursive plan", () => {
    const result = planSafeAction({
      mode: "delegated",
      candidates: [
        candidate({
          steps: [
            { tool: "plan_safe_action", input: {} },
            { tool: "gather_resource", input: {} },
          ],
        }),
      ],
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      outcome: "clarify",
      code: "CHOICE_NOT_CONFIRMED",
    });
  });

  it("does not turn an unknown safety boundary into a plan", () => {
    const result = planSafeAction({
      mode: "delegated",
      candidates: [candidate({ safety: "unknown" })],
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      outcome: "clarify",
      code: "CHOICE_NOT_CONFIRMED",
    });
  });

  it("executes an owner-bounded natural-resource goal without per-block confirmation", () => {
    const result = planSafeAction({
      mode: "explicit",
      requestedId: "mine-iron",
      authorization: {
        kind: "owner_bounded_resource",
        goal: "ironを集める",
        allowedResources: ["iron_ore"],
        maxCount: 8,
      },
      candidates: [
        candidate({
          id: "mine-iron",
          label: "観測済みの鉄鉱石",
          action: "mine_resource",
          operationClass: "natural_resource",
          resourceName: "iron_ore",
          requestedCount: 3,
          reversible: false,
          impact: "medium",
          steps: [
            { tool: "mine_block", input: { resource: "iron_ore", count: 3 } },
          ],
        }),
      ],
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      outcome: "planned",
      candidate: { id: "mine-iron", requestedCount: 3 },
      steps: [{ tool: "mine_block" }],
    });
  });

  it("stops an owner resource plan above its trusted quantity bound", () => {
    const result = planSafeAction({
      mode: "explicit",
      requestedId: "mine-iron",
      authorization: {
        kind: "owner_bounded_resource",
        goal: "ironを集める",
        allowedResources: ["iron_ore"],
        maxCount: 2,
      },
      candidates: [
        candidate({
          id: "mine-iron",
          action: "mine_resource",
          operationClass: "natural_resource",
          resourceName: "iron_ore",
          requestedCount: 3,
          reversible: false,
          impact: "medium",
          steps: [{ tool: "mine_block", input: { count: 3 } }],
        }),
      ],
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      outcome: "clarify",
      code: "CHOICE_NOT_CONFIRMED",
    });
  });

  it("does not apply an iron authorization to a different resource", () => {
    const result = planSafeAction({
      mode: "explicit",
      requestedId: "mine-gold",
      authorization: {
        kind: "owner_bounded_resource",
        goal: "ironを集める",
        allowedResources: ["iron_ore"],
        maxCount: 8,
      },
      candidates: [
        candidate({
          id: "mine-gold",
          action: "mine_resource",
          operationClass: "natural_resource",
          resourceName: "gold_ore",
          requestedCount: 1,
          reversible: false,
          impact: "medium",
          steps: [{ tool: "mine_block", input: { count: 1 } }],
        }),
      ],
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      outcome: "clarify",
      code: "CHOICE_REQUESTED_UNSAFE",
    });
  });

  it("keeps server-protected natural resources denied", () => {
    const result = planSafeAction({
      mode: "delegated",
      authorization: {
        kind: "owner_bounded_resource",
        goal: "ironを集める",
        allowedResources: ["iron_ore"],
        maxCount: 8,
      },
      candidates: [
        candidate({
          id: "protected-iron",
          action: "mine_resource",
          operationClass: "natural_resource",
          resourceName: "iron_ore",
          requestedCount: 2,
          reversible: false,
          impact: "medium",
          safety: "blocked",
          steps: [{ tool: "mine_block", input: { count: 2 } }],
        }),
      ],
      maxSteps: 4,
    });

    expect(result).toMatchObject({
      outcome: "clarify",
      code: "CHOICE_BLOCKED",
    });
  });
});
