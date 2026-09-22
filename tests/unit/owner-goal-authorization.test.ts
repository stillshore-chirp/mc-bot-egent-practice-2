import { describe, expect, it } from "vitest";

import {
  deriveOwnerGoalAuthorization,
  ownerGoalPendingTtlMs,
} from "../../src/decision/owner-goal-authorization.js";

const ownerInput = {
  requesterUsername: "owner",
  authorizedOwnerUsername: "owner",
  requestKind: "owner_message" as const,
  maxCount: 64,
};

describe("owner goal authorization", () => {
  it("scopes an iron quantity goal to raw iron source blocks", () => {
    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "鉄20個を集めて",
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      authorization: {
        allowedResources: ["iron_ore", "deepslate_iron_ore"],
        targetItem: "raw_iron",
        targetCount: 20,
        maxCount: 64,
      },
    });
  });

  it("supports another non-log resource with a separate target item", () => {
    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "石炭12個を集めたい",
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      authorization: {
        allowedResources: ["coal_ore", "deepslate_coal_ore"],
        targetItem: "coal",
        targetCount: 12,
      },
    });
  });

  it("accepts supported Japanese log names when collection intent is explicit", () => {
    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "オークの原木を2本集めて",
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      authorization: {
        allowedResources: ["oak_log"],
        targetItem: "oak_log",
        targetCount: 2,
      },
    });
  });

  it("does not authorize a negated collection request", () => {
    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "オークの原木を1本集めないで",
    });

    expect(result).toMatchObject({ outcome: "clarify" });
    if (result.outcome === "clarify") {
      expect(result.question).toContain("開始しません");
    }
  });

  it.each(["oak_logを20個持っている", "鉄を10秒採掘して"])(
    "does not authorize a named resource without an explicit item goal: %s",
    (message) => {
      const result = deriveOwnerGoalAuthorization({
        ...ownerInput,
        message,
      });

      expect(result).toMatchObject({ outcome: "clarify" });
    },
  );

  it("accepts an arbitrary canonical resource id with a bounded quantity", () => {
    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "diamond_ore 4個を集めて",
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      authorization: {
        allowedResources: ["diamond_ore"],
        targetItem: "diamond",
        targetCount: 4,
      },
    });
  });

  it("resolves deepslate and non-iron ore outputs from the known registry mapping", () => {
    expect(
      deriveOwnerGoalAuthorization({
        ...ownerInput,
        message: "deepslate_iron_ore 2個を集めて",
      }),
    ).toMatchObject({
      outcome: "authorized",
      authorization: {
        allowedResources: ["deepslate_iron_ore"],
        targetItem: "raw_iron",
      },
    });
    expect(
      deriveOwnerGoalAuthorization({
        ...ownerInput,
        message: "redstone_ore 4個を集めて",
      }),
    ).toMatchObject({
      outcome: "authorized",
      authorization: { targetItem: "redstone" },
    });
  });

  it("asks for the final item when an ore output is not verified", () => {
    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "mystery_ore 4個を集めて",
    });

    expect(result).toMatchObject({ outcome: "clarify" });
    if (result.outcome === "clarify") {
      expect(result.question).toContain("mystery_ore");
      expect(result.question).toContain("最終アイテム");
    }
  });

  it("keeps an ingot goal distinct from its ore or raw-material progress", () => {
    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "鉄インゴット20個を作って",
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      authorization: {
        targetItem: "iron_ingot",
        targetCount: 20,
      },
    });
  });

  it("binds the next standalone quantity reply to a pending owner goal", () => {
    const first = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "鉄を掘って",
      nowMs: 1_000,
    });

    expect(first).toMatchObject({
      outcome: "clarify",
      pendingGoal: {
        targetItem: "raw_iron",
        remainingTurns: 1,
      },
    });
    if (first.outcome !== "clarify" || first.pendingGoal === undefined)
      throw new Error("expected pending owner goal");

    const followup = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "20個で",
      pendingGoal: first.pendingGoal,
      nowMs: 1_001,
    });
    expect(followup).toMatchObject({
      outcome: "authorized",
      authorization: {
        allowedResources: ["iron_ore", "deepslate_iron_ore"],
        targetItem: "raw_iron",
        targetCount: 20,
      },
    });
  });

  it.each([
    ["statement", "20個持ってるよ"],
    ["different task", "拠点に戻って"],
  ])("does not authorize a pending goal from a %s reply", (_label, message) => {
    const first = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "鉄を掘って",
      nowMs: 1_000,
    });
    if (first.outcome !== "clarify" || first.pendingGoal === undefined)
      throw new Error("expected pending owner goal");

    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message,
      pendingGoal: first.pendingGoal,
      nowMs: 1_001,
    });
    expect(result).not.toMatchObject({ outcome: "authorized" });
  });

  it("does not use an expired or foreign pending goal", () => {
    const first = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "鉄を掘って",
      nowMs: 1_000,
    });
    if (first.outcome !== "clarify" || first.pendingGoal === undefined)
      throw new Error("expected pending owner goal");

    expect(
      deriveOwnerGoalAuthorization({
        ...ownerInput,
        message: "20個",
        pendingGoal: first.pendingGoal,
        nowMs: 1_000 + ownerGoalPendingTtlMs + 1,
      }),
    ).not.toMatchObject({ outcome: "authorized" });
    expect(
      deriveOwnerGoalAuthorization({
        ...ownerInput,
        message: "20個",
        pendingGoal: { ...first.pendingGoal, ownerUsername: "other" },
        nowMs: 1_001,
      }),
    ).not.toMatchObject({ outcome: "authorized" });
  });

  it.each([
    ["unknown resource", "鉱石20個を集めて"],
    ["missing count", "鉄を集めて"],
    ["over limit", "鉄65個を集めて"],
  ])("asks once for a concrete boundary when %s", (_label, message) => {
    const result = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message,
    });

    expect(result).toMatchObject({ outcome: "clarify" });
    if (result.outcome === "clarify") {
      expect(result.question.length).toBeGreaterThan(10);
    }
  });

  it("does not authorize third-party text or runtime reassessment", () => {
    expect(
      deriveOwnerGoalAuthorization({
        ...ownerInput,
        requesterUsername: "other",
        message: "鉄20個を集めて",
      }),
    ).toEqual({ outcome: "none" });
    expect(
      deriveOwnerGoalAuthorization({
        ...ownerInput,
        requestKind: "runtime_reassessment",
        message: "鉄20個を集めて",
      }),
    ).toEqual({ outcome: "none" });
  });

  it.each(["座標10 64 20へ移動して", "10秒ついてきて"])(
    "does not turn an unrelated numeric owner request into a resource clarification: %s",
    (message) => {
      expect(
        deriveOwnerGoalAuthorization({
          ...ownerInput,
          message,
        }),
      ).toEqual({ outcome: "none" });
    },
  );

  it("does not retain a previous owner goal when the message changes", () => {
    const iron = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "鉄20個を集めて",
    });
    const coal = deriveOwnerGoalAuthorization({
      ...ownerInput,
      message: "石炭3個を集めて",
    });

    expect(iron).toMatchObject({
      outcome: "authorized",
      authorization: { targetItem: "raw_iron", targetCount: 20 },
    });
    expect(coal).toMatchObject({
      outcome: "authorized",
      authorization: { targetItem: "coal", targetCount: 3 },
    });
  });
});
