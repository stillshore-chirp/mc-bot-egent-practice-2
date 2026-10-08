import { describe, expect, it } from "vitest";
import type { PlayerBodyObservation } from "../../src/minecraft/player-body-observation.js";
import type { PlayerOperation } from "../../src/minecraft/player-body-schema.js";
import type {
  PlayerActionPlanStep,
  PlayerGoal,
  PlayerRuntimeSnapshot,
} from "../../src/player/contracts.js";
import {
  evaluateCoherentPlanAcceptance,
  type CoherentPlanCapture,
} from "./coherent-plan-acceptance.js";

type Step = PlayerActionPlanStep;
type Outcome = PlayerRuntimeSnapshot["recentOutcomes"][number];
const at = (seconds: number) =>
  new Date(Date.UTC(2030, 0, 1) + seconds * 1_000).toISOString();
const chestPos = { x: 0, y: 64, z: 0 };
const stonePos = { x: 1, y: 64, z: 0 };
const open: PlayerOperation = {
  kind: "open_window",
  target: { kind: "block", position: chestPos },
};
const move: PlayerOperation = {
  kind: "move_relative",
  offset: { x: 3, y: 0, z: 0 },
  range: 1,
};
const transfer: PlayerOperation = {
  kind: "window_transfer",
  item: "iron_sword",
  count: 1,
  direction: "window_to_inventory",
};
const equip: PlayerOperation = {
  kind: "equip",
  item: "iron_sword",
  destination: "hand",
};
const dig: PlayerOperation = { kind: "dig", position: stonePos };
const craft: PlayerOperation = { kind: "craft", item: "oak_planks", count: 1 };

function outcome(
  id: string,
  operation: PlayerOperation,
  status: Outcome["status"],
  time: number,
): Outcome {
  return {
    runId: "fixture",
    operationId: id,
    kind: operation.kind,
    status,
    summary: "fixture",
    observedAt: at(time),
  };
}

function capture(
  time: number,
  operations: readonly PlayerOperation[],
  settled: readonly (Outcome | undefined)[] = [],
  goal: {
    id?: string;
    currentId?: string;
    oldStatus?: PlayerGoal["status"];
  } = {},
  pendingIds: readonly (string | undefined)[] = [],
): CoherentPlanCapture {
  const goalId = goal.id;
  const goals =
    goal.currentId === undefined
      ? goalId === undefined
        ? []
        : [
            {
              id: goalId,
              title: "need",
              status: "active" as const,
              priority: 1,
              changeReason: "fixture",
              source: "owner" as const,
              updatedAt: at(0),
            },
          ]
      : [
          {
            id: goal.currentId,
            title: "current need",
            status: "active" as const,
            priority: 1,
            changeReason: "fixture",
            source: "owner" as const,
            updatedAt: at(0),
          },
          ...(goalId === undefined
            ? []
            : [
                {
                  id: goalId,
                  title: "old need",
                  status: goal.oldStatus ?? ("abandoned" as const),
                  priority: 1,
                  changeReason: "replaced",
                  source: "owner" as const,
                  updatedAt: at(0),
                },
              ]),
        ];
  const steps: Step[] = operations.map((operation, sequence) => {
    const result = settled[sequence];
    const operationId = result?.operationId ?? pendingIds[sequence];
    return {
      sequence,
      operation,
      expectedOutcome: "fixture",
      status: result?.status ?? "pending",
      ...(operationId === undefined ? {} : { operationId }),
      ...(result?.observedAt === undefined
        ? {}
        : { observedAt: result.observedAt }),
    };
  });
  return {
    sampledAt: at(time),
    runtime: {
      purpose: "prepare for night",
      goals,
      recentOutcomes: settled.filter(
        (item): item is Outcome => item !== undefined,
      ),
      actionPlan: {
        id: "plan",
        purpose: "prepare for night",
        ...(goalId === undefined ? {} : { goalId }),
        steps,
      },
    },
  };
}

function observation(
  time: number,
  options: {
    inventory?: readonly { name: string; count?: number }[];
    head?: string;
    hand?: string;
    chest?: boolean;
    stone?: boolean;
    window?: readonly string[] | null;
  } = {},
): PlayerBodyObservation {
  const slots = Array(27).fill(null) as ({
    name: string;
    count: number;
  } | null)[];
  (options.window ?? []).forEach((name, index) => {
    slots[index] = { name, count: 1 };
  });
  return {
    observedAt: at(time),
    self: {
      inventory: (options.inventory ?? []).map(({ name, count = 1 }, slot) => ({
        name,
        count,
        slot,
      })),
      equipment: {
        head: options.head === undefined ? null : { name: options.head },
        hand: options.hand === undefined ? null : { name: options.hand },
      },
    },
    perception: {
      blocks: [
        ...(options.chest ? [{ name: "chest", position: chestPos }] : []),
        ...(options.stone ? [{ name: "stone", position: stonePos }] : []),
      ],
      entities: [],
    },
    window:
      options.window === undefined
        ? null
        : ({ inventoryStart: 27, slots } as unknown as NonNullable<
            PlayerBodyObservation["window"]
          >),
  } as unknown as PlayerBodyObservation;
}

describe("coherent multi-stage plan acceptance oracle", () => {
  it("accepts a linked open, inspect, hand-weapon transfer, and equip chain", () => {
    const opened = outcome("o", open, "successful", 1);
    const transferred = outcome("t", transfer, "successful", 3);
    const equipped = outcome("e", equip, "successful", 5);
    const operations = [open, transfer, equip];
    const captures = [
      capture(0.5, [open], [], {}, ["o"]),
      // At the transfer result timestamp, Body has not appeared in this pending snapshot.
      capture(3, operations, [opened], {}, [undefined, "t", undefined]),
      capture(7, operations, [opened, transferred, equipped]),
    ];
    const observations = [
      observation(0, { chest: true }),
      observation(2, { window: ["iron_sword"] }),
      observation(3.5, { inventory: [{ name: "iron_sword" }] }),
      observation(6, {
        inventory: [{ name: "iron_sword" }],
        hand: "iron_sword",
      }),
    ];
    expect(
      evaluateCoherentPlanAcceptance({
        captures,
        observations,
        neededItems: ["iron_sword"],
      }),
    ).toMatchObject({
      accepted: true,
      reason: "accepted_container_chain",
      linkedBodyOutcomeCount: 3,
    });
  });

  it("rejects three movement outcomes and a declaration without Body outcomes", () => {
    const moves = [1, 2, 3].map((time) =>
      outcome(`m${time}`, move, "successful", time),
    );
    expect(
      evaluateCoherentPlanAcceptance({
        captures: [
          capture(0.5, [move, move, move]),
          capture(4, [move, move, move], moves),
        ],
        observations: [],
        neededItems: ["iron_sword"],
      }).reason,
    ).toBe("movement_only");
    expect(
      evaluateCoherentPlanAcceptance({
        captures: [capture(0.5, [open, transfer])],
        observations: [],
        neededItems: ["iron_sword"],
      }).reason,
    ).toBe("no_linked_body_outcomes");
  });

  it("rejects a plan linked to an abandoned owner goal", () => {
    const failed = outcome("o", open, "failed", 1);
    const captures = [
      capture(0.5, [open], [], { id: "old", currentId: "new" }),
      capture(2, [open], [failed], { id: "old", currentId: "new" }),
    ];
    expect(
      evaluateCoherentPlanAcceptance({
        captures,
        observations: [],
        neededItems: ["iron_sword"],
      }).reason,
    ).toBe("goal_mismatch");
  });

  it("rejects an unchanged repeated failure", () => {
    const first = outcome("o1", open, "failed", 1);
    const second = outcome("o2", open, "failed", 3);
    const captures = [
      capture(0.5, [open, open]),
      capture(2, [open, open], [first]),
      capture(4, [open, open], [first, second]),
    ];
    expect(
      evaluateCoherentPlanAcceptance({
        captures,
        observations: [],
        neededItems: ["iron_sword"],
      }).reason,
    ).toBe("repeated_unchanged_failure");
  });

  it("accepts a resource replan after observing an empty container", () => {
    const opened = outcome("o", open, "successful", 1);
    const gathered = outcome("d", dig, "successful", 3);
    const captures = [
      capture(0.5, [open]),
      capture(2.5, [open, dig], [opened], {}, [undefined, "d"]),
      capture(5, [open, dig], [opened, gathered]),
    ];
    const observations = [
      observation(0, { chest: true }),
      observation(2, { window: [] }),
      observation(2.75, { stone: true }),
      observation(4, { inventory: [{ name: "cobblestone" }] }),
    ];
    expect(
      evaluateCoherentPlanAcceptance({
        captures,
        observations,
        neededItems: ["cobblestone"],
      }).reason,
    ).toBe("accepted_replan");
  });

  it("rejects an unrelated inventory change after an empty container", () => {
    const opened = outcome("o", open, "successful", 1);
    const gathered = outcome("d", dig, "successful", 3);
    const captures = [
      capture(0.5, [open]),
      capture(2.5, [open, dig], [opened], {}, [undefined, "d"]),
      capture(5, [open, dig], [opened, gathered]),
    ];
    const observations = [
      observation(0, { chest: true }),
      observation(2, { window: [] }),
      observation(2.75, { stone: true }),
      observation(4, { inventory: [{ name: "dirt" }] }),
    ];
    expect(
      evaluateCoherentPlanAcceptance({
        captures,
        observations,
        neededItems: ["cobblestone"],
      }).reason,
    ).toBe("replan_missing");
  });

  it("accepts justified adaptation even when both later actions fail", () => {
    const opened = outcome("o", open, "successful", 1);
    const failedDig = outcome("d", dig, "failed", 3);
    const failedCraft = outcome("c", craft, "failed", 5);
    const operations = [open, dig, craft];
    const captures = [
      capture(0.5, [open]),
      capture(2.5, operations, [opened], {}, [undefined, "d", "c"]),
      capture(4, operations, [opened, failedDig], {}, [
        undefined,
        undefined,
        "c",
      ]),
      capture(7, operations, [opened, failedDig, failedCraft]),
    ];
    const observations = [
      observation(0, { chest: true }),
      observation(2, { window: [] }),
      observation(2.75),
      observation(3.5),
      observation(5.5),
    ];
    expect(
      evaluateCoherentPlanAcceptance({
        captures,
        observations,
        neededItems: ["oak_planks"],
      }).reason,
    ).toBe("accepted_failed_replan");
  });
});
