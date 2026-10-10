import type {
  BodyItemStack,
  BodyWindowSnapshot,
  PlayerBodyObservation,
} from "../minecraft/player-body-observation.js";

export type EquipmentDestination = "head" | "torso" | "legs" | "feet" | "hand";

export interface EquipmentUpgradeCandidate {
  readonly item: BodyItemStack;
  readonly destination: EquipmentDestination;
}

export interface ChestEquipmentWithdrawalCandidate extends EquipmentUpgradeCandidate {
  readonly count: 1;
}

type Rank = readonly [number, number, number, number];

interface GearSpec {
  readonly destination: EquipmentDestination;
  readonly primaryRank: number;
  readonly secondaryRank: number;
}

const armorSpecs: Readonly<Record<string, GearSpec>> = {
  leather_helmet: { destination: "head", primaryRank: 1, secondaryRank: 1 },
  golden_helmet: { destination: "head", primaryRank: 2, secondaryRank: 2 },
  chainmail_helmet: { destination: "head", primaryRank: 2, secondaryRank: 3 },
  iron_helmet: { destination: "head", primaryRank: 2, secondaryRank: 4 },
  diamond_helmet: { destination: "head", primaryRank: 3, secondaryRank: 5 },
  netherite_helmet: { destination: "head", primaryRank: 3, secondaryRank: 6 },
  leather_chestplate: {
    destination: "torso",
    primaryRank: 3,
    secondaryRank: 1,
  },
  golden_chestplate: {
    destination: "torso",
    primaryRank: 5,
    secondaryRank: 2,
  },
  chainmail_chestplate: {
    destination: "torso",
    primaryRank: 5,
    secondaryRank: 3,
  },
  iron_chestplate: {
    destination: "torso",
    primaryRank: 6,
    secondaryRank: 4,
  },
  diamond_chestplate: {
    destination: "torso",
    primaryRank: 8,
    secondaryRank: 5,
  },
  netherite_chestplate: {
    destination: "torso",
    primaryRank: 8,
    secondaryRank: 6,
  },
  leather_leggings: {
    destination: "legs",
    primaryRank: 2,
    secondaryRank: 1,
  },
  golden_leggings: {
    destination: "legs",
    primaryRank: 3,
    secondaryRank: 2,
  },
  chainmail_leggings: {
    destination: "legs",
    primaryRank: 4,
    secondaryRank: 3,
  },
  iron_leggings: {
    destination: "legs",
    primaryRank: 5,
    secondaryRank: 4,
  },
  diamond_leggings: {
    destination: "legs",
    primaryRank: 6,
    secondaryRank: 5,
  },
  netherite_leggings: {
    destination: "legs",
    primaryRank: 6,
    secondaryRank: 6,
  },
  leather_boots: { destination: "feet", primaryRank: 1, secondaryRank: 1 },
  golden_boots: { destination: "feet", primaryRank: 1, secondaryRank: 2 },
  chainmail_boots: { destination: "feet", primaryRank: 1, secondaryRank: 3 },
  iron_boots: { destination: "feet", primaryRank: 2, secondaryRank: 4 },
  diamond_boots: { destination: "feet", primaryRank: 3, secondaryRank: 5 },
  netherite_boots: { destination: "feet", primaryRank: 3, secondaryRank: 6 },
};

const weaponSpecs: Readonly<Record<string, GearSpec>> = {
  wooden_sword: { destination: "hand", primaryRank: 1, secondaryRank: 1 },
  golden_sword: { destination: "hand", primaryRank: 1, secondaryRank: 1 },
  stone_sword: { destination: "hand", primaryRank: 2, secondaryRank: 1 },
  iron_sword: { destination: "hand", primaryRank: 3, secondaryRank: 1 },
  diamond_sword: { destination: "hand", primaryRank: 4, secondaryRank: 1 },
  netherite_sword: { destination: "hand", primaryRank: 5, secondaryRank: 1 },
  wooden_axe: { destination: "hand", primaryRank: 1, secondaryRank: 0 },
  golden_axe: { destination: "hand", primaryRank: 1, secondaryRank: 0 },
  stone_axe: { destination: "hand", primaryRank: 2, secondaryRank: 0 },
  iron_axe: { destination: "hand", primaryRank: 3, secondaryRank: 0 },
  diamond_axe: { destination: "hand", primaryRank: 4, secondaryRank: 0 },
  netherite_axe: { destination: "hand", primaryRank: 5, secondaryRank: 0 },
};

const destinations: readonly EquipmentDestination[] = [
  "head",
  "torso",
  "legs",
  "feet",
  "hand",
];
const armorDestinations = ["head", "torso", "legs", "feet"] as const;
const playerInventorySlotStart = 9;
const playerInventorySlotEnd = 45;

export function isChestEquipmentWindow(
  window: BodyWindowSnapshot | null,
): window is BodyWindowSnapshot {
  if (window === null) return false;
  const type = window.type.replace(/^minecraft:/u, "");
  const isChestType =
    (type === "generic_9x3" && window.inventoryStart === 27) ||
    (type === "generic_9x6" && window.inventoryStart === 54) ||
    (type === "chest" &&
      (window.inventoryStart === 27 || window.inventoryStart === 54));
  return (
    isChestType &&
    window.inventoryEnd === window.inventoryStart + 36 &&
    window.slots.length === window.inventoryStart + 36
  );
}

function gearSpec(
  item: BodyItemStack,
  destination: EquipmentDestination,
): GearSpec | undefined {
  const spec = armorSpecs[item.name] ?? weaponSpecs[item.name];
  return spec?.destination === destination ? spec : undefined;
}

function rank(
  item: BodyItemStack,
  destination: EquipmentDestination,
): Rank | undefined {
  const spec = gearSpec(item, destination);
  if (
    spec === undefined ||
    item.count !== 1 ||
    item.metadata !== 0 ||
    item.customName !== null ||
    item.enchantments.length !== 0 ||
    item.maxDurability === null ||
    item.durability === null ||
    item.maxDurability <= 0 ||
    item.durability <= 0 ||
    item.durability > item.maxDurability
  )
    return undefined;

  const durabilityFraction = item.durability / item.maxDurability;
  return [
    spec.primaryRank,
    spec.secondaryRank,
    durabilityFraction,
    item.maxDurability,
  ];
}

function compareRanks(left: Rank, right: Rank): number {
  const parts = [
    [left[0], right[0]],
    [left[1], right[1]],
    [left[2], right[2]],
    [left[3], right[3]],
  ] as const;
  for (const [leftPart, rightPart] of parts) {
    const difference = leftPart - rightPart;
    if (difference !== 0) return difference;
  }
  return 0;
}

function bestItem(
  items: readonly (BodyItemStack | null)[],
  destination: EquipmentDestination,
  excludedSlots: ReadonlySet<number>,
): { readonly item: BodyItemStack; readonly rank: Rank } | undefined {
  let best: { readonly item: BodyItemStack; readonly rank: Rank } | undefined;
  const seenNames = new Set<string>();
  for (const item of [...items].sort((left, right) => {
    if (left === null) return 1;
    if (right === null) return -1;
    return left.slot - right.slot;
  })) {
    if (item === null) continue;
    if (seenNames.has(item.name)) continue;
    seenNames.add(item.name);
    // Body operations resolve a name to its first source-order stack. Keep
    // that same first-stack rule even when the first item is already equipped
    // or cannot be ranked, otherwise a later duplicate would be selected here
    // but the operation would still act on the earlier stack.
    if (excludedSlots.has(item.slot)) continue;
    const itemRank = rank(item, destination);
    if (
      itemRank !== undefined &&
      (best === undefined ||
        compareRanks(itemRank, best.rank) > 0 ||
        (compareRanks(itemRank, best.rank) === 0 && item.slot < best.item.slot))
    ) {
      best = { item, rank: itemRank };
    }
  }
  return best;
}

function equippedArmorSlots(
  equipment: Readonly<Record<string, BodyItemStack | null>>,
): ReadonlySet<number> {
  const slots = new Set<number>();
  for (const destination of armorDestinations) {
    const item = equipment[destination];
    if (item !== null && item !== undefined) slots.add(item.slot);
  }
  return slots;
}

function currentRank(
  observation: PlayerBodyObservation,
  destination: EquipmentDestination,
): Rank | null | undefined {
  const current = observation.self.equipment[destination];
  if (current === undefined) return undefined;
  if (current === null) return null;
  const currentRank = rank(current, destination);
  if (
    currentRank === undefined &&
    destination === "hand" &&
    isRankableArmor(current)
  )
    return null;
  return currentRank;
}

function handIsPreservedTool(observation: PlayerBodyObservation): boolean {
  const hand = observation.self.equipment.hand;
  return (
    hand !== null &&
    hand !== undefined &&
    gearSpec(hand, "hand") === undefined &&
    !isRankableArmor(hand)
  );
}

function isRankableArmor(item: BodyItemStack): boolean {
  const spec = armorSpecs[item.name];
  return spec !== undefined && rank(item, spec.destination) !== undefined;
}

export function findInventoryEquipmentUpgrade(
  observation: PlayerBodyObservation,
): EquipmentUpgradeCandidate | null {
  const excludedSlots = equippedArmorSlots(observation.self.equipment);
  const playerInventory = observation.self.inventory.filter(
    (item) =>
      item.slot >= playerInventorySlotStart &&
      item.slot < playerInventorySlotEnd,
  );
  for (const destination of destinations) {
    if (destination === "hand" && handIsPreservedTool(observation)) continue;
    const before = currentRank(observation, destination);
    if (before === undefined) continue;
    const best = bestItem(playerInventory, destination, excludedSlots);
    if (
      best !== undefined &&
      (before === null || compareRanks(best.rank, before) > 0)
    ) {
      return { item: best.item, destination };
    }
  }
  return null;
}

export function findChestEquipmentWithdrawal(
  observation: PlayerBodyObservation,
): ChestEquipmentWithdrawalCandidate | null {
  const window = observation.window;
  if (!isChestEquipmentWindow(window)) return null;

  const excludedSlots = equippedArmorSlots(observation.self.equipment);
  const chestSlots = window.slots.slice(0, window.inventoryStart);
  const playerInventory = observation.self.inventory.filter(
    (item) =>
      item.slot >= playerInventorySlotStart &&
      item.slot < playerInventorySlotEnd,
  );
  const ownedNames = new Set(playerInventory.map((item) => item.name));
  for (const destination of destinations) {
    if (destination === "hand" && handIsPreservedTool(observation)) continue;
    const before = currentRank(observation, destination);
    if (before === undefined) continue;
    const owned = bestItem(playerInventory, destination, excludedSlots);
    const chest = bestItem(chestSlots, destination, new Set());
    // After withdrawal, equip still addresses the first inventory stack by
    // name. Do not withdraw a duplicate that the later equip operation cannot
    // target deterministically.
    if (chest === undefined || ownedNames.has(chest.item.name)) continue;
    const bestOwnedRank =
      before === null
        ? (owned?.rank ?? null)
        : owned === undefined || compareRanks(owned.rank, before) <= 0
          ? before
          : owned.rank;
    if (bestOwnedRank !== null && compareRanks(chest.rank, bestOwnedRank) <= 0)
      continue;
    if (before !== null && compareRanks(chest.rank, before) <= 0) continue;
    return { item: chest.item, destination, count: 1 };
  }
  return null;
}
