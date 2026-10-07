import type { Bot } from "mineflayer";
import type { Recipe } from "prismarine-recipe";
import minecraftData from "minecraft-data";
import prismarineRecipe from "prismarine-recipe";
import { describe, expect, it, vi } from "vitest";
import {
  queryPlayerKnowledge,
  type RegistryKnowledgeFact,
} from "../../src/minecraft/player-body-knowledge.js";

type RecipeFact = Extract<RegistryKnowledgeFact, { kind: "recipe" }>;

function isRecipeFact(fact: RegistryKnowledgeFact): fact is RecipeFact {
  return fact.kind === "recipe";
}

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

function createRegistryBot(): Bot {
  const registry = minecraftData("1.21.11");
  const loadRecipes = prismarineRecipe as unknown as (
    data: typeof registry,
  ) => {
    Recipe: {
      find(itemId: number, metadata: number | null): Recipe[];
    };
  };
  const { Recipe: RegistryRecipe } = loadRecipes(registry);

  return {
    version: registry.version.minecraftVersion ?? "1.21.11",
    registry,
    recipesAll: (itemId: number) => RegistryRecipe.find(itemId, null),
    recipesFor: () => [],
    findBlock: () => null,
  } as unknown as Bot;
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

  it("normalizes actual shaped and shapeless registry recipe inputs", () => {
    const bot = createRegistryBot();
    const recipeFacts = (query: string, resultName: string) =>
      queryPlayerKnowledge(bot, query)
        .facts.filter(isRecipeFact)
        .filter((fact) => fact.result.name === resultName);

    const bedRecipe = recipeFacts("white_bed", "white_bed").find((fact) =>
      fact.ingredients.some((ingredient) => ingredient.name === "white_wool"),
    );
    expect(
      bedRecipe?.ingredients.find(
        (ingredient) => ingredient.name === "white_wool",
      )?.count,
    ).toBe(3);
    expect(
      bedRecipe?.ingredients.some(
        (ingredient) =>
          ingredient.name.endsWith("_planks") && ingredient.count === 3,
      ),
    ).toBe(true);

    const tableRecipe = recipeFacts("crafting_table", "crafting_table").find(
      (fact) => fact.ingredients.some((ingredient) => ingredient.count === 4),
    );
    expect(
      tableRecipe?.ingredients.find((ingredient) =>
        ingredient.name.endsWith("_planks"),
      )?.count,
    ).toBe(4);

    const planksRecipe = recipeFacts("oak_planks", "oak_planks")[0];
    const oakLog = minecraftData("1.21.11").itemsByName.oak_log;
    if (oakLog === undefined) throw new Error("oak_log missing from registry");
    expect(planksRecipe?.result.count).toBe(4);
    expect(planksRecipe?.ingredients).toContainEqual({
      id: oakLog.id,
      name: "oak_log",
      count: 1,
    });

    const cakeRecipe = recipeFacts("cake", "cake")[0];
    expect(cakeRecipe?.ingredients).toContainEqual(
      expect.objectContaining({ name: "wheat", count: 3 }),
    );
    expect(cakeRecipe?.ingredients).not.toContainEqual(
      expect.objectContaining({ name: "cake" }),
    );
  });
});
