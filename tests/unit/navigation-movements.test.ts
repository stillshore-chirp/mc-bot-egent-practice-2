import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Move } from "mineflayer-pathfinder";
import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import {
  correctOpenWoodDoorPath,
  NavigationMovements,
} from "../../src/minecraft/navigation-movements.js";

const require = createRequire(import.meta.url);
const createRegistry = require("prismarine-registry") as (
  version: string,
) => Record<string, unknown>;
const createBlock = require("prismarine-block") as (
  registry: Record<string, unknown>,
) => {
  fromProperties: (
    type: string,
    properties: Record<string, string | boolean>,
    biomeId: number,
  ) => Block;
};
const registry = createRegistry("1.21.11");
const blockFactory = createBlock(registry);
const woodenDoorNames = [
  "oak_door",
  "spruce_door",
  "birch_door",
  "jungle_door",
  "acacia_door",
  "dark_oak_door",
  "mangrove_door",
  "cherry_door",
  "bamboo_door",
  "crimson_door",
  "warped_door",
  "pale_oak_door",
];

function blockKey(position: Vec3): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function makeDoorBlock(
  name: string,
  half: "lower" | "upper",
  position: Vec3,
  options: {
    readonly open?: boolean | undefined;
    readonly facing?: string | undefined;
    readonly hinge?: string | undefined;
    readonly powered?: boolean | undefined;
  } = {},
): Block {
  const block = blockFactory.fromProperties(
    name,
    {
      half,
      open: options.open ?? true,
      facing: options.facing ?? "north",
      hinge: options.hinge ?? "left",
      powered: options.powered ?? false,
    },
    0,
  );
  block.position = position;
  return block;
}

function postprocessedDoorTop(block: Block): Vec3 {
  const point = new Vec3(0.5, 0, 0.5);
  let count = 1;
  for (const shape of block.shapes) {
    const height = shape[4];
    if (height === point.y) {
      point.x += (shape[0] + shape[3]) / 2;
      point.z += (shape[2] + shape[5]) / 2;
      count += 1;
    } else if (height > point.y) {
      count = 2;
      point.x = 0.5 + (shape[0] + shape[3]) / 2;
      point.y = height;
      point.z = 0.5 + (shape[2] + shape[5]) / 2;
    }
  }
  point.x /= count;
  point.z /= count;
  return block.position.plus(point);
}

function makePathNode(point: Vec3): Move {
  return {
    x: point.x,
    y: point.y,
    z: point.z,
    remainingBlocks: 0,
    cost: 0,
    toBreak: [],
    toPlace: [],
    parkour: false,
    hash: "synthetic",
  };
}

function playerFitsDoorShapes(
  point: Vec3,
  lower: Block,
  upper: Block,
  width: number,
  height: number,
): boolean {
  const halfWidth = width / 2;
  for (const block of [lower, upper]) {
    for (const shape of block.shapes) {
      const overlapsX =
        point.x + halfWidth > block.position.x + shape[0] &&
        point.x - halfWidth < block.position.x + shape[3];
      const overlapsY =
        point.y + height > block.position.y + shape[1] &&
        point.y < block.position.y + shape[4];
      const overlapsZ =
        point.z + halfWidth > block.position.z + shape[2] &&
        point.z - halfWidth < block.position.z + shape[5];
      if (overlapsX && overlapsY && overlapsZ) return false;
    }
  }
  return true;
}

function makeDoorFixture(
  name: string,
  options: {
    readonly open?: boolean;
    readonly facing?: string;
    readonly upperFacing?: string;
    readonly hinge?: string;
    readonly upperHinge?: string;
    readonly powered?: boolean;
    readonly upperPowered?: boolean;
    readonly includeUpper?: boolean;
  } = {},
) {
  const origin = new Vec3(4, 64, 7);
  const lower = makeDoorBlock(name, "lower", origin, {
    open: options.open,
    facing: options.facing,
    hinge: options.hinge,
    powered: options.powered,
  });
  const upper =
    options.includeUpper === false
      ? null
      : makeDoorBlock(name, "upper", origin.offset(0, 1, 0), {
          open: options.open,
          facing: options.upperFacing ?? options.facing,
          hinge: options.upperHinge ?? options.hinge,
          powered: options.upperPowered ?? options.powered,
        });
  const blocks = new Map([[blockKey(lower.position), lower]]);
  if (upper !== null) blocks.set(blockKey(upper.position), upper);
  const bot = {
    entity: { width: 0.6, height: 1.8 },
    blockAt: (position: Vec3) => blocks.get(blockKey(position)) ?? null,
  } as unknown as Bot;
  return { bot, lower, upper };
}

describe("companion pathfinder movements", () => {
  it("walks through hand-operable doors without digging or risky traversal", () => {
    const bot = { registry } as unknown as Bot;
    const movements = new NavigationMovements(bot);
    const blocksArray = registry.blocksArray as {
      readonly id: number;
      readonly name: string;
    }[];
    const handOperableDoors = blocksArray.filter(
      (block) => block.name.endsWith("_door") && block.name !== "iron_door",
    );

    expect(movements).toMatchObject({
      canDig: false,
      canOpenDoors: true,
      allow1by1towers: false,
      allowParkour: false,
      allowSprinting: false,
      maxDropDown: 2,
    });
    expect(movements.openable).toEqual(
      new Set(handOperableDoors.map((block) => block.id)),
    );
  });

  it("turns native open wooden-door top points into clear feet positions", () => {
    const facings = ["north", "east", "south", "west"];
    const hinges = ["left", "right"];
    let corrected = 0;

    for (const name of woodenDoorNames) {
      for (const facing of facings) {
        for (const hinge of hinges) {
          const fixture = makeDoorFixture(name, { facing, hinge });
          if (fixture.upper === null)
            throw new Error("missing upper door half");
          const sourcePoint = postprocessedDoorTop(fixture.lower);
          const node = makePathNode(sourcePoint);
          const result = {
            status: "success" as const,
            cost: 1,
            time: 1,
            visitedNodes: 1,
            generatedNodes: 1,
            path: [node],
          };

          correctOpenWoodDoorPath(fixture.bot, result);

          const halfWidth = fixture.bot.entity.width / 2;
          expect(node.y).toBe(fixture.lower.position.y);
          expect(node.x).toBeGreaterThanOrEqual(
            fixture.lower.position.x + halfWidth,
          );
          expect(node.x).toBeLessThanOrEqual(
            fixture.lower.position.x + 1 - halfWidth,
          );
          expect(node.z).toBeGreaterThanOrEqual(
            fixture.lower.position.z + halfWidth,
          );
          expect(node.z).toBeLessThanOrEqual(
            fixture.lower.position.z + 1 - halfWidth,
          );
          expect(
            Math.abs(node.x - (fixture.lower.position.x + 0.5)) +
              Math.abs(node.z - (fixture.lower.position.z + 0.5)),
          ).toBeGreaterThan(0);
          expect(
            playerFitsDoorShapes(
              new Vec3(node.x, node.y, node.z),
              fixture.lower,
              fixture.upper,
              fixture.bot.entity.width,
              fixture.bot.entity.height,
            ),
          ).toBe(true);
          corrected += 1;
        }
      }
    }

    expect(corrected).toBe(96);
  });

  it("leaves closed, iron, incomplete, mismatched, and action paths unchanged", () => {
    const closed = makeDoorFixture("oak_door", { open: false });
    const closedNode = makePathNode(postprocessedDoorTop(closed.lower));
    correctOpenWoodDoorPath(closed.bot, {
      status: "success",
      cost: 1,
      time: 1,
      visitedNodes: 1,
      generatedNodes: 1,
      path: [closedNode],
    });
    expect(closedNode.y).toBe(closed.lower.position.y + 1);

    const iron = makeDoorFixture("iron_door");
    const ironNode = makePathNode(postprocessedDoorTop(iron.lower));
    correctOpenWoodDoorPath(iron.bot, {
      status: "success",
      cost: 1,
      time: 1,
      visitedNodes: 1,
      generatedNodes: 1,
      path: [ironNode],
    });
    expect(ironNode.y).toBe(iron.lower.position.y + 1);

    const incomplete = makeDoorFixture("oak_door", { includeUpper: false });
    const incompleteNode = makePathNode(postprocessedDoorTop(incomplete.lower));
    correctOpenWoodDoorPath(incomplete.bot, {
      status: "success",
      cost: 1,
      time: 1,
      visitedNodes: 1,
      generatedNodes: 1,
      path: [incompleteNode],
    });
    expect(incompleteNode.y).toBe(incomplete.lower.position.y + 1);

    const mismatched = makeDoorFixture("oak_door", {
      upperFacing: "south",
    });
    const mismatchedNode = makePathNode(postprocessedDoorTop(mismatched.lower));
    correctOpenWoodDoorPath(mismatched.bot, {
      status: "success",
      cost: 1,
      time: 1,
      visitedNodes: 1,
      generatedNodes: 1,
      path: [mismatchedNode],
    });
    expect(mismatchedNode.y).toBe(mismatched.lower.position.y + 1);

    const action = makeDoorFixture("oak_door");
    const actionNode = makePathNode(postprocessedDoorTop(action.lower));
    actionNode.toPlace.push(makePathNode(new Vec3(0, 0, 0)));
    correctOpenWoodDoorPath(action.bot, {
      status: "success",
      cost: 1,
      time: 1,
      visitedNodes: 1,
      generatedNodes: 1,
      path: [actionNode],
    });
    expect(actionNode.y).toBe(action.lower.position.y + 1);
  });

  it("leaves a door waypoint unchanged when its recorded shape cannot fit the Bot", () => {
    const fixture = makeDoorFixture("oak_door");
    if (fixture.upper === null) throw new Error("missing upper door half");
    fixture.lower.shapes = [[0, 0, 0, 0.4, 1, 1]];
    fixture.upper.shapes = [[0, 0, 0, 0.4, 1, 1]];
    const node = makePathNode(postprocessedDoorTop(fixture.lower));

    correctOpenWoodDoorPath(fixture.bot, {
      status: "success",
      cost: 1,
      time: 1,
      visitedNodes: 1,
      generatedNodes: 1,
      path: [node],
    });

    expect(node.y).toBe(fixture.lower.position.y + 1);
  });
});
