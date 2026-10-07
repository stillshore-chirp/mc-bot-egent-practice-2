import type { Bot } from "mineflayer";
import type { Recipe } from "prismarine-recipe";
import { describe, expect, it, vi } from "vitest";
import { queryPlayerKnowledge } from "../../src/minecraft/player-body-knowledge.js";

const chest = {
  id: 1,
  name: "chest",
  displayName: "Chest",
  stackSize: 64,
  maxDurability: 0,
  enchantCategories: [],
};

const craftingTableRecipe: Recipe = {
  result: { id: chest.id, metadata: null, count: 1 },
  inShape: [],
  outShape: [],
  requiresTable: true,
  ingredients: [{ id: 2, metadata: null, count: 8 }],
  delta: [],
};

const craftingTable = { name: "crafting_table" };

function createBot(
  options: {
    readonly recipes?: readonly Recipe[];
    readonly table?: typeof craftingTable | null;
    readonly recipesFor?: (surface: unknown) => readonly Recipe[];
    readonly failRecipeLookup?: boolean;
    readonly failCraftabilityLookup?: boolean;
    readonly failTableLookup?: boolean;
  } = {},
): Bot {
  const registry = {
    itemsArray: [chest],
    itemsByName: { chest },
    items: { [chest.id]: chest },
    foodsByName: {},
    blocksByName: { crafting_table: { id: 3 } },
    blocksArray: [],
    entitiesArray: [],
    enchantmentsArray: [],
    version: { minecraftVersion: "1.21.11" },
  };
  const bot = {
    version: "1.21.11",
    registry,
    recipesAll: vi.fn(() => {
      if (options.failRecipeLookup)
        throw new Error("recipe registry unavailable");
      return [...(options.recipes ?? [craftingTableRecipe])];
    }),
    recipesFor: vi.fn(
      (_itemId: number, _metadata: null, _count: number, surface: unknown) => {
        if (options.failCraftabilityLookup)
          throw new Error("inventory recipe lookup unavailable");
        return options.recipesFor?.(surface) ?? [];
      },
    ),
    findBlock: vi.fn(() => {
      if (options.failTableLookup) throw new Error("block search unavailable");
      return options.table ?? null;
    }),
  };
  return bot as unknown as Bot;
}

function inference(bot: Bot) {
  return queryPlayerKnowledge(bot, "chest").inferences[0];
}

describe("player body knowledge craftability", () => {
  it("separates table-assumed materials from the unavailable current surface", () => {
    const bot = createBot({
      recipesFor: (surface) => (surface === true ? [craftingTableRecipe] : []),
    });

    expect(inference(bot)).toMatchObject({
      currentlyCraftable: true,
      assessedCount: 1,
      recipeStatus: "known",
      tableRequirement: "required",
      craftingTableNearby: false,
      craftableWithCurrentSurface: false,
      materialAvailabilityWithTable: "sufficient",
    });
  });

  it("reports a nearby table without claiming material sufficiency", () => {
    const bot = createBot({
      table: craftingTable,
      recipesFor: () => [],
    });

    expect(inference(bot)).toMatchObject({
      currentlyCraftable: false,
      recipeStatus: "known",
      tableRequirement: "required",
      craftingTableNearby: true,
      craftableWithCurrentSurface: false,
      materialAvailabilityWithTable: "insufficient",
    });
  });

  it("keeps missing registry and inventory observations explicitly unknown", () => {
    const bot = createBot({
      failRecipeLookup: true,
      failCraftabilityLookup: true,
      failTableLookup: true,
    });

    expect(inference(bot)).toMatchObject({
      currentlyCraftable: false,
      recipeStatus: "unknown",
      tableRequirement: "unknown",
      craftingTableNearby: null,
      craftableWithCurrentSurface: null,
      materialAvailabilityWithTable: "unknown",
    });
  });

  it("distinguishes no known recipe from unknown material availability", () => {
    const bot = createBot({ recipes: [] });

    expect(inference(bot)).toMatchObject({
      currentlyCraftable: false,
      recipeStatus: "none",
      tableRequirement: "unknown",
      materialAvailabilityWithTable: "unknown",
    });
  });
});
