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
  readonly inferences: readonly {
    readonly kind: "craftability";
    readonly itemName: string;
    readonly currentlyCraftable: boolean;
    readonly basis: readonly string[];
  }[];
  readonly truncated: boolean;
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

function recipeFacts(
  bot: Bot,
  itemId: number,
  itemName: string,
): RegistryKnowledgeFact[] {
  let recipes: Recipe[];
  try {
    recipes = bot.recipesAll(itemId, null, true);
  } catch {
    return [];
  }
  return recipes.slice(0, 12).map((recipe) => ({
    kind: "recipe",
    result: {
      id: recipe.result.id,
      name: bot.registry.items[recipe.result.id]?.name ?? itemName,
      count: recipe.result.count,
    },
    requiresTable: recipe.requiresTable,
    ingredients: recipe.ingredients.map((ingredient) => ({
      id: ingredient.id,
      name: bot.registry.items[ingredient.id]?.name ?? `item_${ingredient.id}`,
      count: ingredient.count,
    })),
  }));
}

export function queryPlayerKnowledge(bot: Bot, query: string): PlayerKnowledge {
  const terms = queryTerms(query);
  const facts: RegistryKnowledgeFact[] = [];
  const inferences: PlayerKnowledge["inferences"][number][] = [];

  for (const item of bot.registry.itemsArray) {
    if (!matches(query, terms, [item.name, item.displayName])) continue;
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
    facts.push(...recipeFacts(bot, item.id, item.name));

    let craftable = false;
    try {
      craftable = bot.recipesFor(item.id, null, 1, true).length > 0;
    } catch {
      // Registry recipe data can be incomplete for modded servers.
    }
    inferences.push({
      kind: "craftability",
      itemName: item.name,
      currentlyCraftable: craftable,
      basis: [
        "registry recipes",
        "current inventory counts",
        "crafting table assumed available",
      ],
    });
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
