import { describe, expect, it } from "vitest";
import minecraftData from "minecraft-data";
import prismarineBlock from "prismarine-block";
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { NavigationMovements } from "../../src/minecraft/navigation-movements.js";

const registry = minecraftData("1.21.11");
// The pathfinder uses this block factory; fixtures must use its real state table.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const Block = prismarineBlock("1.21.11");

function doorStateId(
  name: "oak_door" | "iron_door",
  half: "lower" | "upper",
  open: boolean,
): number {
  const door = registry.blocksByName[name];
  if (door === undefined) throw new Error("Door fixture is unavailable");
  for (
    let stateId = door.minStateId;
    stateId <= door.maxStateId;
    stateId += 1
  ) {
    const properties = Block.fromStateId(stateId, 0).getProperties();
    if (properties.half === half && properties.open === open) return stateId;
  }
  throw new Error("Door fixture state is unavailable");
}

function passage(doorName: "oak_door" | "iron_door", open: boolean) {
  const blockAt = (position: Vec3) => {
    const { x, y, z } = position;
    const name =
      x === 1 && z === 0 && (y === 64 || y === 65)
        ? doorName
        : y === 63
          ? "stone"
          : "air";
    const block =
      name === doorName
        ? Block.fromStateId(
            doorStateId(doorName, y === 64 ? "lower" : "upper", open),
            0,
          )
        : Block.fromStateId(registry.blocksByName[name]?.minStateId ?? 0, 0);
    block.position = position;
    return block;
  };
  const bot = {
    registry,
    blockAt,
    entities: {},
    inventory: { items: () => [] },
    pathfinder: { bestHarvestTool: () => null },
    entity: { effects: {} },
    game: { minY: -64 },
  } as unknown as Bot;
  return new NavigationMovements(bot);
}

describe("navigation through doors", () => {
  it("plans an interaction through a closed wooden door without digging or placing", () => {
    const movements = passage("oak_door", false);
    const neighbors = movements.getNeighbors({
      x: 0,
      y: 64,
      z: 0,
      remainingBlocks: 0,
      cost: 0,
      toBreak: [],
      toPlace: [],
      parkour: false,
      hash: "0,64,0",
    });
    const door = neighbors.find(
      (move) => move.x === 1 && move.y === 64 && move.z === 0,
    );

    expect(door).toBeDefined();
    expect(door?.toBreak).toEqual([]);
    expect(door?.toPlace).toHaveLength(1);
    expect(door?.toPlace[0]).toMatchObject({ useOne: true });
    expect(movements.scafoldingBlocks).toEqual([]);
  });

  it("walks through an already open wooden door without closing it", () => {
    const movements = passage("oak_door", true);
    const neighbors = movements.getNeighbors({
      x: 0,
      y: 64,
      z: 0,
      remainingBlocks: 0,
      cost: 0,
      toBreak: [],
      toPlace: [],
      parkour: false,
      hash: "0,64,0",
    });
    const door = neighbors.find(
      (move) => move.x === 1 && move.y === 64 && move.z === 0,
    );

    expect(door).toBeDefined();
    expect(door?.toPlace).toEqual([]);
  });

  it("does not treat an iron door as hand operable", () => {
    const movements = passage("iron_door", false);
    const neighbors = movements.getNeighbors({
      x: 0,
      y: 64,
      z: 0,
      remainingBlocks: 0,
      cost: 0,
      toBreak: [],
      toPlace: [],
      parkour: false,
      hash: "0,64,0",
    });

    expect(
      neighbors.some((move) => move.x === 1 && move.y === 64 && move.z === 0),
    ).toBe(false);
  });
});
