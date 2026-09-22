import type { ArmorSlot, WorldSnapshot } from "../domain/snapshot.js";

export interface ArmorChoice {
  readonly slot: ArmorSlot;
  readonly itemName: string;
}

const armorSlots: readonly ArmorSlot[] = ["head", "torso", "legs", "feet"];
const materialRank: Readonly<Record<string, number>> = {
  leather: 1,
  golden: 2,
  chainmail: 3,
  iron: 4,
  diamond: 5,
  netherite: 6,
};
const suffix: Readonly<Record<ArmorSlot, string>> = {
  head: "helmet",
  torso: "chestplate",
  legs: "leggings",
  feet: "boots",
};

function rank(name: string, slot: ArmorSlot): number {
  if (slot === "head" && name === "turtle_helmet") return 2.5;
  const ending = `_${suffix[slot]}`;
  if (!name.endsWith(ending)) return 0;
  return materialRank[name.slice(0, -ending.length)] ?? 0;
}

/** Fill empty observed slots; never replace equipment with unknown enchantments. */
export function recommendArmor(
  snapshot: WorldSnapshot,
): readonly ArmorChoice[] {
  if (snapshot.armor === null) return [];
  return armorSlots.flatMap((slot) => {
    if (snapshot.armor?.[slot] !== null) return [];
    const candidate = snapshot.inventory
      .filter((item) => item.count > 0 && rank(item.name, slot) > 0)
      .sort((left, right) => rank(right.name, slot) - rank(left.name, slot))[0];
    return candidate === undefined ? [] : [{ slot, itemName: candidate.name }];
  });
}
