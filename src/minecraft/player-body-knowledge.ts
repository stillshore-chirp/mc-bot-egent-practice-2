import type { Bot } from "mineflayer";
import type { Recipe } from "prismarine-recipe";

export type RegistryKnowledgeFact =
  | {
      readonly kind: "item";
      readonly id: number;
      readonly name: string;
      readonly displayName: string;
      readonly stackSize: number;
      readonly maxDurability: number | null;
      readonly enchantCategories: readonly string[];
      readonly food: null | {
        readonly foodPoints: number;
        readonly saturation: number;
      };
    }
  | {
      readonly kind: "block";
      readonly id: number;
      readonly name: string;
      readonly displayName: string;
      readonly hardness: number | null;
      readonly boundingBox: string;
      readonly drops: readonly string[];
    }
  | {
      readonly kind: "entity";
      readonly id: number;
      readonly name: string;
      readonly displayName: string;
      readonly category: string | null;
      readonly type: string;
    }
  | {
      readonly kind: "enchantment";
      readonly id: number;
      readonly name: string;
      readonly displayName: string;
      readonly maxLevel: number;
      readonly category: string | null;
    }
  | {
      readonly kind: "recipe";
      readonly result: {
        readonly id: number;
        readonly name: string;
        readonly count: number;
      };
      readonly requiresTable: boolean;
      readonly ingredients: readonly {
        readonly id: number;
        readonly name: string;
        readonly count: number;
      }[];
    };

export interface PlayerKnowledge {
  readonly source: "minecraft_registry";
  readonly gameVersion: string;
  readonly registryVersion: string;
  readonly observedAt: string;
  readonly query: string;
  readonly facts: readonly RegistryKnowledgeFact[];
  readonly inferences: readonly PlayerCraftabilityInference[];
  readonly truncated: boolean;
}

export interface PlayerCraftabilityInference {
  readonly kind: "craftability";
  readonly itemName: string;
  /** Compatibility field: checks one item while assuming a crafting table. */
  readonly currentlyCraftable: boolean;
  readonly assessedCount: 1;
  readonly recipeStatus: "known" | "none" | "unknown";
  readonly tableRequirement: "required" | "not_required" | "mixed" | "unknown";
  /** Whether the Body's crafting-table search found one within 4.5 blocks. */
  readonly craftingTableNearby: boolean | null;
  /** Whether one item can be made using the currently available surface. */
  readonly craftableWithCurrentSurface: boolean | null;
  /** Material sufficiency for one item, assuming a crafting table is available. */
  readonly materialAvailabilityWithTable:
    "sufficient" | "insufficient" | "unknown";
  readonly basis: readonly string[];
}

const stopWords = new Set([
  "a",
  "an",
  "are",
  "can",
  "craft",
  "crafting",
  "find",
  "how",
  "is",
  "make",
  "of",
  "recipe",
  "recipes",
  "the",
  "to",
  "what",
  "where",
]);
const factLimit = 48;

function queryTerms(query: string): string[] {
  return query
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !stopWords.has(term));
}

function matches(
  query: string,
  terms: readonly string[],
  values: readonly (string | undefined | null)[],
): boolean {
  if (terms.length === 0) return query.trim().length === 0;
  const haystack = values.join(" ").toLocaleLowerCase().replaceAll("_", " ");
  return terms.every((term) => haystack.includes(term));
}

function recipeIngredientFacts(
  bot: Bot,
  recipe: Recipe,
): Extract<RegistryKnowledgeFact, { kind: "recipe" }>["ingredients"] {
  const counts = new Map<number, number>();
  const add = (id: number, count: number) => {
    if (id < 0 || !Number.isFinite(count) || count <= 0) return;
    counts.set(id, (counts.get(id) ?? 0) + count);
  };
  const runtimeRecipe = recipe as Omit<Recipe, "ingredients" | "inShape"> & {
    ingredients: Recipe["ingredients"] | null;
    inShape: Recipe["inShape"] | null;
  };

  // prismarine-recipe stores either a shaped grid or shapeless ingredients;
  // its declarations omit that either field can be null at runtime.
  for (const ingredient of runtimeRecipe.ingredients ?? []) {
    add(ingredient.id, Math.abs(ingredient.count));
  }
  for (const row of runtimeRecipe.inShape ?? []) {
    for (const ingredient of row) {
      add(ingredient.id, 1);
    }
  }

  return [...counts].map(([id, count]) => ({
    id,
    name: bot.registry.items[id]?.name ?? `item_${id}`,
    count,
  }));
}

function recipeFacts(
  bot: Bot,
  itemName: string,
  recipes: readonly Recipe[] | undefined,
): RegistryKnowledgeFact[] {
  return (recipes ?? []).slice(0, 12).map((recipe) => ({
    kind: "recipe",
    result: {
      id: recipe.result.id,
      name: bot.registry.items[recipe.result.id]?.name ?? itemName,
      count: recipe.result.count,
    },
    requiresTable: recipe.requiresTable,
    ingredients: recipeIngredientFacts(bot, recipe),
  }));
}

function registryRecipes(
  bot: Bot,
  itemId: number,
): readonly Recipe[] | undefined {
  try {
    return bot.recipesAll(itemId, null, true);
  } catch {
    return undefined;
  }
}

type CraftingTableLookup =
  | {
      readonly status: "nearby";
      readonly block: NonNullable<ReturnType<Bot["findBlock"]>>;
    }
  | { readonly status: "not_found" | "unknown" };

function nearbyCraftingTable(bot: Bot): CraftingTableLookup {
  const tableId = bot.registry.blocksByName.crafting_table?.id;
  if (tableId === undefined) return { status: "unknown" };
  try {
    const block = bot.findBlock({ matching: tableId, maxDistance: 4.5 });
    return block === null
      ? { status: "not_found" }
      : { status: "nearby", block };
  } catch {
    return { status: "unknown" };
  }
}

function craftableWithSurface(
  bot: Bot,
  itemId: number,
  craftingSurface: Parameters<Bot["recipesFor"]>[3],
): boolean | null {
  try {
    return bot.recipesFor(itemId, null, 1, craftingSurface).length > 0;
  } catch {
    return null;
  }
}

function tableRequirement(
  recipes: readonly Recipe[] | undefined,
): PlayerCraftabilityInference["tableRequirement"] {
  if (recipes === undefined || recipes.length === 0) return "unknown";
  const hasTableRecipe = recipes.some(({ requiresTable }) => requiresTable);
  const hasInventoryRecipe = recipes.some(
    ({ requiresTable }) => !requiresTable,
  );
  if (hasTableRecipe && hasInventoryRecipe) return "mixed";
  return hasTableRecipe ? "required" : "not_required";
}

function craftabilityInference(
  bot: Bot,
  itemId: number,
  itemName: string,
  recipes: readonly Recipe[] | undefined,
  table: CraftingTableLookup,
): PlayerCraftabilityInference {
  const craftableWithTable = craftableWithSurface(bot, itemId, true);
  const craftableWithoutTable = craftableWithSurface(bot, itemId, false);
  const craftableWithCurrentSurface =
    table.status === "nearby"
      ? craftableWithSurface(bot, itemId, table.block)
      : table.status === "not_found"
        ? craftableWithoutTable
        : craftableWithoutTable === true
          ? true
          : null;
  const recipeStatus =
    recipes === undefined ? "unknown" : recipes.length === 0 ? "none" : "known";

  return {
    kind: "craftability",
    itemName,
    currentlyCraftable: craftableWithTable === true,
    assessedCount: 1,
    recipeStatus,
    tableRequirement: tableRequirement(recipes),
    craftingTableNearby:
      table.status === "unknown" ? null : table.status === "nearby",
    craftableWithCurrentSurface,
    materialAvailabilityWithTable:
      recipeStatus !== "known" || craftableWithTable === null
        ? "unknown"
        : craftableWithTable
          ? "sufficient"
          : "insufficient",
    basis: [
      "registry recipes",
      "current inventory counts for one item",
      "currentlyCraftable assumes a crafting table",
      "craftingTableNearby uses the Body 4.5-block search",
    ],
  };
}

export function queryPlayerKnowledge(bot: Bot, query: string): PlayerKnowledge {
  const terms = queryTerms(query);
  const facts: RegistryKnowledgeFact[] = [];
  const inferences: PlayerCraftabilityInference[] = [];
  let table: CraftingTableLookup | undefined;

  for (const item of bot.registry.itemsArray) {
    if (!matches(query, terms, [item.name, item.displayName])) continue;
    const recipes = registryRecipes(bot, item.id);
    const food = bot.registry.foodsByName[item.name];
    facts.push({
      kind: "item",
      id: item.id,
      name: item.name,
      displayName: item.displayName,
      stackSize: item.stackSize,
      maxDurability: item.maxDurability ?? null,
      enchantCategories: item.enchantCategories ?? [],
      food:
        food === undefined
          ? null
          : { foodPoints: food.foodPoints, saturation: food.saturation },
    });
    facts.push(...recipeFacts(bot, item.name, recipes));
    table ??= nearbyCraftingTable(bot);
    inferences.push(
      craftabilityInference(bot, item.id, item.name, recipes, table),
    );
    if (facts.length >= factLimit) break;
  }

  if (facts.length < factLimit) {
    for (const block of bot.registry.blocksArray) {
      if (!matches(query, terms, [block.name, block.displayName])) continue;
      facts.push({
        kind: "block",
        id: block.id,
        name: block.name,
        displayName: block.displayName,
        hardness: Number.isFinite(block.hardness) ? block.hardness : null,
        boundingBox: block.boundingBox,
        drops: block.drops.map((drop) => {
          const itemId =
            typeof drop === "number"
              ? drop
              : typeof drop.drop === "number"
                ? drop.drop
                : drop.drop.id;
          return bot.registry.items[itemId]?.name ?? `item_${itemId}`;
        }),
      });
      if (facts.length >= factLimit) break;
    }
  }

  if (facts.length < factLimit) {
    for (const entity of bot.registry.entitiesArray) {
      if (
        !matches(query, terms, [
          entity.name,
          entity.displayName,
          entity.category,
        ])
      )
        continue;
      facts.push({
        kind: "entity",
        id: entity.id,
        name: entity.name,
        displayName: entity.displayName,
        category: entity.category ?? null,
        type: entity.type,
      });
      if (facts.length >= factLimit) break;
    }
  }

  if (facts.length < factLimit) {
    for (const enchantment of bot.registry.enchantmentsArray) {
      if (
        !matches(query, terms, [
          enchantment.name,
          enchantment.displayName,
          enchantment.category,
        ])
      )
        continue;
      facts.push({
        kind: "enchantment",
        id: enchantment.id,
        name: enchantment.name,
        displayName: enchantment.displayName,
        maxLevel: enchantment.maxLevel,
        category: enchantment.category,
      });
      if (facts.length >= factLimit) break;
    }
  }

  return {
    source: "minecraft_registry",
    gameVersion: bot.version,
    registryVersion: bot.registry.version.minecraftVersion ?? bot.version,
    observedAt: new Date().toISOString(),
    query,
    facts: facts.slice(0, factLimit),
    inferences: inferences.slice(0, factLimit),
    truncated: facts.length > factLimit,
  };
}
