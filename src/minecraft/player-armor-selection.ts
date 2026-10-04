import type { ArmorSlot } from "../domain/snapshot.js";

export interface NamedArmorItem {
  readonly name: string;
}

export type EquippedArmorItem = string | NamedArmorItem | null;

export type EquippedArmorBySlot = Readonly<
  Partial<Record<ArmorSlot, EquippedArmorItem>>
>;

export interface ArmorUpgrade<T extends NamedArmorItem> {
  readonly item: T;
  readonly destination: ArmorSlot;
}

const armorSlots: readonly ArmorSlot[] = ["head", "torso", "legs", "feet"];
const materialRank: Readonly<Record<string, number>> = {
  leather: 1,
  golden: 2,
  copper: 3,
  chainmail: 4,
  iron: 5,
  diamond: 6,
  netherite: 7,
};
const armorSuffix: Readonly<Record<ArmorSlot, string>> = {
  head: "helmet",
  torso: "chestplate",
  legs: "leggings",
  feet: "boots",
};

/** Selects carried base armor for empty slots or strict known-material upgrades. */
export function selectArmorUpgrades<T extends NamedArmorItem>(
  inventory: readonly T[],
  equipped: EquippedArmorBySlot,
): readonly ArmorUpgrade<T>[] {
  return armorSlots.flatMap((destination) => {
    if (!Object.hasOwn(equipped, destination)) return [];

    const current = equipped[destination];
    const currentRank =
      current === null
        ? 0
        : typeof current === "string"
          ? armorRank(current, destination)
          : current === undefined
            ? undefined
            : armorRank(current.name, destination);
    if (currentRank === undefined) return [];

    let best: { readonly item: T; readonly rank: number } | undefined;
    for (const item of inventory) {
      const rank = armorRank(item.name, destination);
      if (rank === undefined || rank <= currentRank) continue;
      if (best === undefined || rank > best.rank) best = { item, rank };
    }
    return best === undefined ? [] : [{ item: best.item, destination }];
  });
}

function armorRank(name: string, destination: ArmorSlot): number | undefined {
  const suffix = `_${armorSuffix[destination]}`;
  if (!name.endsWith(suffix)) return undefined;
  return materialRank[name.slice(0, -suffix.length)];
}
