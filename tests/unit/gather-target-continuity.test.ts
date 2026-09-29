import { describe, expect, it } from "vitest";

import {
  countCompletedGatherActions,
  gatherTargetAcceptedGoalCount,
  gatherTargetVisibleAfterBodyAction,
  hasResolvedGatherTargetOwnerGoal,
  newGatherTargetProposalIds,
} from "../e2e/gather-target-continuity.js";

describe("gather target continuity predicates", () => {
  it("selects only new proposals linked to the requested target", () => {
    const proposals = [
      { id: "old", title: "白樺を集める" },
      { id: "birch", title: "白樺の原木" },
      { id: "linked", title: "採集" },
    ];
    const goals = [
      { ownerProposalId: "linked", source: "owner", title: "oak_log を集める" },
    ];
    expect(
      newGatherTargetProposalIds({
        item: "birch_log",
        proposals,
        goals,
        previousProposalIds: new Set(["old"]),
      }),
    ).toEqual(["birch"]);
    expect(
      newGatherTargetProposalIds({
        item: "oak_log",
        proposals,
        goals,
        previousProposalIds: new Set(),
      }),
    ).toEqual(["linked"]);
  });

  it("requires a resolved proposal linked to an active owner goal", () => {
    const input = {
      proposals: [{ id: "birch", status: "adopted" }],
      judgments: [],
      goals: [
        {
          ownerProposalId: "birch",
          source: "owner",
          status: "active",
        },
      ],
      proposalIds: new Set(["birch"]),
    };
    expect(hasResolvedGatherTargetOwnerGoal(input)).toBe(true);
    expect(
      hasResolvedGatherTargetOwnerGoal({
        ...input,
        goals: [{ ...input.goals[0], ownerProposalId: "other" }],
      }),
    ).toBe(false);
  });

  it("uses only one explicit quantity from the accepted target goal", () => {
    const oakGoal = {
      ownerProposalId: "oak",
      source: "owner",
      status: "active",
      title: "minecraft:oak_log を４個集める",
    } as const;
    const input = {
      item: "oak_log" as const,
      proposals: [{ id: "oak", status: "adopted" }],
      judgments: [],
      goals: [oakGoal],
      proposalIds: new Set(["oak"]),
    };
    expect(gatherTargetAcceptedGoalCount(input)).toBe(4);
    expect(
      gatherTargetAcceptedGoalCount({
        ...input,
        goals: [{ ...oakGoal, title: "minecraft:oak_log を集める" }],
      }),
    ).toBe(undefined);
    expect(
      gatherTargetAcceptedGoalCount({
        ...input,
        goals: [oakGoal, { ...oakGoal, title: "oak_logを2個集める" }],
      }),
    ).toBe(undefined);
  });

  it("requires a successful new Body view/move before fresh target visibility", () => {
    const successfulViewOutcome = {
      operationId: "view",
      kind: "move_to",
      status: "successful",
      observedAt: "2026-01-01T00:00:02Z",
    };
    const input = {
      item: "birch_log" as const,
      previousOperationIds: new Set(["before"]),
      acceptedAt: Date.parse("2026-01-01T00:00:01Z"),
      outcomes: [successfulViewOutcome],
      observation: {
        observedAt: "2026-01-01T00:00:03Z",
        visibleBlockNames: ["oak_log", "minecraft:birch_log"],
      },
    };
    expect(gatherTargetVisibleAfterBodyAction(input)).toBe(true);
    expect(
      gatherTargetVisibleAfterBodyAction({
        ...input,
        outcomes: [{ ...successfulViewOutcome, operationId: "before" }],
      }),
    ).toBe(false);
    expect(
      gatherTargetVisibleAfterBodyAction({
        ...input,
        outcomes: [{ ...successfulViewOutcome, status: "failed" }],
      }),
    ).toBe(false);
    expect(
      gatherTargetVisibleAfterBodyAction({
        ...input,
        observation: {
          observedAt: "2026-01-01T00:00:02Z",
          visibleBlockNames: ["birch_log"],
        },
      }),
    ).toBe(false);
  });

  it("counts distinct successful dig and later pickup pairs", () => {
    expect(
      countCompletedGatherActions([
        {
          operationId: "failed-dig",
          kind: "dig",
          status: "failed",
          observedAt: "2026-01-01T00:00:00Z",
        },
        {
          operationId: "pickup-first",
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:01Z",
        },
        {
          operationId: "dig-first",
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:02Z",
        },
        {
          operationId: "pickup-second",
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:03Z",
        },
        {
          operationId: "pickup-second",
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:03Z",
        },
        {
          operationId: "dig-second",
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:04Z",
        },
        {
          operationId: "pickup-third",
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:05Z",
        },
      ]),
    ).toBe(2);
  });
});
