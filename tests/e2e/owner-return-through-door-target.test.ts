import { describe, expect, it } from "vitest";

import {
  isOwnerProposalProgressable,
  OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET,
  ownerReturnArrivalConfirmed,
  ownerReturnToolNamesSince,
  runBudgetCoversCase,
} from "./ai-player-live.js";
import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("owner return through door targeted E2E case", () => {
  it("extends only the call allowance while retaining the known-token cap", () => {
    expect(OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET).toEqual({
      llmCalls: 12,
      totalTokens: 80_000,
    });
    expect(
      runBudgetCoversCase(
        { llmCalls: 12, totalTokens: 80_000 },
        OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET,
      ),
    ).toBe(true);
    expect(
      runBudgetCoversCase(
        { llmCalls: 11, totalTokens: 80_000 },
        OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET,
      ),
    ).toBe(false);
  });

  it("selects only the owner return case without prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("owner_return_through_door");
    expect(
      isCaseSelectedForTarget(
        "owner_return_through_door",
        "owner_return_through_door",
      ),
    ).toBe(true);
    expect(
      isCaseSelectedForTarget("owner_return_through_door", "autonomous_life"),
    ).toBe(false);
  });

  it("accepts only adopted or compromised proposals linked to an owner goal", () => {
    expect(isOwnerProposalProgressable("adopted", true)).toBe(true);
    expect(isOwnerProposalProgressable("compromised", true)).toBe(true);

    for (const disposition of ["pending", "declined", "unknown"] as const) {
      expect(isOwnerProposalProgressable(disposition, true)).toBe(false);
    }
    expect(isOwnerProposalProgressable("adopted", false)).toBe(false);
    expect(isOwnerProposalProgressable("compromised", false)).toBe(false);
  });

  it("requires matching owner-side arrival, distance, and an open door", () => {
    const confirmed = {
      bodySide: "owner_side",
      rconSide: "owner_side",
      bodyDistance: "within_1_75",
      rconDistance: "within_1_75",
      bodyRconAligned: true,
      doorState: "open",
    } as const;
    expect(ownerReturnArrivalConfirmed(confirmed)).toBe(true);

    expect(
      ownerReturnArrivalConfirmed({ ...confirmed, bodySide: "doorway" }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({ ...confirmed, rconSide: "return_side" }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({
        ...confirmed,
        bodyDistance: "over_1_75",
      }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({
        ...confirmed,
        rconDistance: "unknown",
      }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({ ...confirmed, bodyRconAligned: false }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({ ...confirmed, doorState: "closed" }),
    ).toBe(false);
  });

  it("records only fresh safe tool names grouped by agent role", () => {
    const previous = [
      {
        runSequence: 1,
        round: 1,
        role: "purpose" as const,
        toolCalls: [
          {
            name: "search_skills" as const,
            resultClass: "ok" as const,
            outputChars: 12,
          },
        ],
      },
    ];
    const current = [
      ...previous,
      {
        runSequence: 1,
        round: 2,
        role: "purpose" as const,
        toolCalls: [
          {
            name: "commit_goal_state" as const,
            resultClass: "ok" as const,
            outputChars: 12,
          },
          {
            name: "commit_goal_state" as const,
            resultClass: "ok" as const,
            outputChars: 12,
          },
        ],
      },
      {
        runSequence: 1,
        round: 1,
        role: "conversation" as const,
        toolCalls: [
          {
            name: "propose_goal_change" as const,
            resultClass: "ok" as const,
            outputChars: 12,
          },
        ],
      },
    ];

    expect(ownerReturnToolNamesSince(current, previous)).toEqual({
      conversation: ["propose_goal_change"],
      purpose: ["commit_goal_state"],
    });
  });
});
