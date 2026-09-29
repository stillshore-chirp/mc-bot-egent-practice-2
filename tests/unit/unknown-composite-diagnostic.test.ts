import { describe, expect, it } from "vitest";

import {
  classifyUnknownTaskVisibility,
  isFacingUnknownFixture,
  isSameStartedTravelOperation,
  parseEntityRotation,
  safeUnknownOperationKind,
  hasNewOwnerProposalGoalForUnknownTask,
  unknownTargetDiscoveredAfterBodyAction,
  unknownTargetCollectionMatchesFreshBlueWool,
  unknownTargetPickupConfirmed,
} from "../e2e/unknown-composite-diagnostic.js";

describe("unknown composite operation-kind evidence", () => {
  it("injects an obstacle only for the same running movement operation", () => {
    for (const kind of ["move_to", "move_relative"]) {
      const active = {
        kind,
        operationId: "movement-1",
        bodyStartedAt: "2026-01-01T00:00:00.000Z",
      };
      expect(isSameStartedTravelOperation(active, "movement-1")).toBe(true);
      expect(isSameStartedTravelOperation(active, "movement-2")).toBe(false);
      expect(
        isSameStartedTravelOperation(
          { kind, operationId: "movement-1" },
          "movement-1",
        ),
      ).toBe(false);
    }
    expect(
      isSameStartedTravelOperation(
        {
          kind: "dig",
          operationId: "movement-1",
          bodyStartedAt: "2026-01-01T00:00:00.000Z",
        },
        "movement-1",
      ),
    ).toBe(false);
    expect(isSameStartedTravelOperation(undefined, "movement-1")).toBe(false);
  });

  it("retains only a known player operation name", () => {
    expect(safeUnknownOperationKind("move_to")).toBe("move_to");
  });

  it("uses a fixed unknown value for absent or unrecognized kinds", () => {
    expect(safeUnknownOperationKind(undefined)).toBe("unknown");
    expect(safeUnknownOperationKind("private-input-value")).toBe("unknown");
  });

  it("keeps an unavailable task observation unknown instead of false", () => {
    expect(classifyUnknownTaskVisibility(undefined)).toEqual({
      status: "unknown",
    });
  });

  it("records visible target and wall material as fixed booleans", () => {
    expect(
      classifyUnknownTaskVisibility(["minecraft:blue_wool", "stone"]),
    ).toEqual({
      status: "available",
      targetBlockVisible: true,
      wallMaterialVisible: true,
    });
    expect(classifyUnknownTaskVisibility([])).toEqual({
      status: "available",
      targetBlockVisible: false,
      wallMaterialVisible: false,
    });
  });
});

describe("unknown fixture facing evidence", () => {
  it("parses yaw and pitch and accepts equivalent wrapped angles", () => {
    const rotation = parseEntityRotation("Entity data: [270.0f, 0.0f]");

    expect(rotation).toEqual({ yaw: 270, pitch: 0 });
    expect(isFacingUnknownFixture(rotation)).toBe(true);
  });

  it("parses finite scientific notation with optional NBT suffixes", () => {
    const rotation = parseEntityRotation("Entity data: [2.7E+2f, 0e0d]");

    expect(rotation).toEqual({ yaw: 270, pitch: 0 });
    expect(isFacingUnknownFixture(rotation)).toBe(true);
    expect(parseEntityRotation("Entity data: [1e999, 0]")).toBeUndefined();
  });

  it("rejects unparsable or misdirected rotation readback", () => {
    expect(parseEntityRotation("Entity data unavailable")).toBeUndefined();
    expect(parseEntityRotation("Entity data [270, 0], readback failed")).toBe(
      undefined,
    );
    expect(isFacingUnknownFixture(undefined)).toBe(false);
    expect(isFacingUnknownFixture({ yaw: 0, pitch: 0 })).toBe(false);
    expect(isFacingUnknownFixture({ yaw: -90, pitch: 10 })).toBe(false);
  });
});

describe("hidden target discovery and pickup evidence", () => {
  const taskSentAt = Date.parse("2026-09-29T00:00:02.000Z");
  const preTaskObservation = {
    observedAt: "2026-09-29T00:00:01.000Z",
    visibleBlockNames: ["stone"],
  };

  it("requires a successful Body view or move before fresh target visibility", () => {
    expect(
      unknownTargetDiscoveredAfterBodyAction({
        taskSentAt,
        preTaskObservation,
        outcomes: [
          {
            kind: "look",
            status: "successful",
            observedAt: "2026-09-29T00:00:03.000Z",
          },
        ],
        observation: {
          observedAt: "2026-09-29T00:00:04.000Z",
          visibleBlockNames: ["minecraft:blue_wool"],
        },
      }),
    ).toBe("look");
  });

  it("keeps missing, initially visible, or actionless discovery unconfirmed", () => {
    const common = {
      taskSentAt,
      outcomes: [
        {
          kind: "move_to",
          status: "successful",
          observedAt: "2026-09-29T00:00:03.000Z",
        },
      ],
      observation: {
        observedAt: "2026-09-29T00:00:04.000Z",
        visibleBlockNames: ["blue_wool"],
      },
    } as const;
    expect(
      unknownTargetDiscoveredAfterBodyAction({
        ...common,
        preTaskObservation: undefined,
      }),
    ).toBeUndefined();
    expect(
      unknownTargetDiscoveredAfterBodyAction({
        ...common,
        preTaskObservation: {
          observedAt: "2026-09-29T00:00:01.000Z",
          visibleBlockNames: ["blue_wool"],
        },
      }),
    ).toBeUndefined();
    expect(
      unknownTargetDiscoveredAfterBodyAction({
        ...common,
        preTaskObservation,
        outcomes: [],
      }),
    ).toBeUndefined();
    expect(
      unknownTargetDiscoveredAfterBodyAction({
        ...common,
        preTaskObservation,
        outcomes: [
          {
            kind: "look",
            status: "successful",
            observedAt: "2026-09-29T00:00:05.000Z",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("requires target removal, matching target pickup event, and positive known inventory delta", () => {
    expect(
      unknownTargetPickupConfirmed({
        targetRemoved: true,
        inventoryDelta: 1,
        matchingTargetPickupEventObserved: true,
      }),
    ).toBe(true);
    for (const evidence of [
      {
        targetRemoved: true,
        inventoryDelta: undefined,
        matchingTargetPickupEventObserved: true,
      },
      {
        targetRemoved: true,
        inventoryDelta: 0,
        matchingTargetPickupEventObserved: true,
      },
      {
        targetRemoved: true,
        inventoryDelta: 1,
        matchingTargetPickupEventObserved: false,
      },
      {
        targetRemoved: false,
        inventoryDelta: 1,
        matchingTargetPickupEventObserved: true,
      },
    ]) {
      expect(unknownTargetPickupConfirmed(evidence)).toBe(false);
    }
  });

  it("matches only a fresh blue wool item_collected effect for the requested entity", () => {
    const evidence = {
      operationKind: "collect_item",
      status: "successful",
      targetVisibleEntityId: 42,
      targetVisibleAt: "2026-09-29T00:00:02.500Z",
      requestedEntityId: 42,
      pickupEntityId: 42,
      effectType: "item_collected",
      effectEntityId: 42,
      collectedItemName: "blue_wool",
      taskSentAt,
      operationStartedAt: "2026-09-29T00:00:03.000Z",
      pickupObservedAt: "2026-09-29T00:00:03.500Z",
      operationCompletedAt: "2026-09-29T00:00:04.000Z",
    } as const;
    expect(unknownTargetCollectionMatchesFreshBlueWool(evidence)).toBe(true);
    expect(
      unknownTargetCollectionMatchesFreshBlueWool({
        ...evidence,
        collectedItemName: "stone",
      }),
    ).toBe(false);
    expect(
      unknownTargetCollectionMatchesFreshBlueWool({
        ...evidence,
        effectEntityId: 43,
      }),
    ).toBe(false);
    expect(
      unknownTargetCollectionMatchesFreshBlueWool({
        ...evidence,
        targetVisibleEntityId: 41,
      }),
    ).toBe(false);
    expect(
      unknownTargetCollectionMatchesFreshBlueWool({
        ...evidence,
        pickupEntityId: 43,
      }),
    ).toBe(false);
    expect(
      unknownTargetCollectionMatchesFreshBlueWool({
        ...evidence,
        targetVisibleAt: "2026-09-29T00:00:01.000Z",
      }),
    ).toBe(false);
    expect(
      unknownTargetCollectionMatchesFreshBlueWool({
        ...evidence,
        pickupObservedAt: "2026-09-29T00:00:05.000Z",
      }),
    ).toBe(false);
  });

  it("accepts a new linked completed goal only when its update follows the task", () => {
    const input = {
      previousProposalIds: ["old"],
      proposals: [{ id: "new", status: "adopted" }],
      goals: [
        {
          source: "owner",
          status: "completed",
          ownerProposalId: "new",
          updatedAt: "2026-09-29T00:00:03.000Z",
        },
      ],
      taskSentAt,
    } as const;
    expect(hasNewOwnerProposalGoalForUnknownTask(input)).toBe(true);
    expect(
      hasNewOwnerProposalGoalForUnknownTask({
        ...input,
        goals: [{ ...input.goals[0], updatedAt: "2026-09-29T00:00:01.000Z" }],
      }),
    ).toBe(false);
  });
});
