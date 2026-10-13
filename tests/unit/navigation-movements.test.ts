import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { describe, expect, it } from "vitest";
import { NavigationMovements } from "../../src/minecraft/navigation-movements.js";

const require = createRequire(import.meta.url);
const createRegistry = require("prismarine-registry") as (
  version: string,
) => Record<string, unknown>;

describe("companion pathfinder movements", () => {
  it("walks through hand-operable doors without digging or risky traversal", () => {
    const registry = createRegistry("1.21.11");
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
});
