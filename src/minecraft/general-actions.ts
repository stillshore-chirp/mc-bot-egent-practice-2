import type { Position } from "../domain/snapshot.js";

export const generalActionNames = [
  "mine_block",
  "collect_item",
  "craft_item",
  "place_block",
  "smelt_item",
] as const;

export type GeneralActionName = (typeof generalActionNames)[number];

export type ActionPermission = "allowed" | "unknown" | "denied";

export type ActionSafety = "allowed" | "blocked" | "unknown";

export type ActionImpact = "low" | "medium" | "high";

export type ActionOperationClass =
  | "natural_resource"
  | "world_change"
  | "movement"
  | "communication"
  | "unknown";

export interface GeneralActionCandidate {
  readonly id: string;
  readonly label: string;
  readonly action: GeneralActionName;
  readonly args: Readonly<Record<string, unknown>>;
  readonly steps: readonly {
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[];
  readonly observed: true;
  readonly purposeFit: "direct" | "compatible" | "unknown";
  readonly permission: ActionPermission;
  readonly safety: ActionSafety;
  readonly reversible: boolean;
  readonly impact: ActionImpact;
  readonly operationClass?: ActionOperationClass;
  readonly scopeId?: string;
  readonly requestedCount?: number;
  readonly resourceName?: string;
  /** Canonical inventory item delivered by this observed operation. */
  readonly goalItem?: string;
  /** Verified item(s) that may advance preparation for goalItem. */
  readonly intermediateItems?: readonly string[];
  readonly distance: number;
  readonly order: number;
}

const purposeFitRank: Readonly<
  Record<GeneralActionCandidate["purposeFit"], number>
> = {
  direct: 0,
  compatible: 1,
  unknown: 2,
};

/**
 * Keep observation bounded while reserving a slot for each observed action
 * class. A nearby solid block must not hide every other safe operation just
 * because it was enumerated first by the world observer.
 */
export function selectBalancedActionCandidates(
  candidates: readonly GeneralActionCandidate[],
  maxCandidates: number,
): readonly GeneralActionCandidate[] {
  const limit = Math.max(0, Math.floor(maxCandidates));
  if (limit === 0) return [];

  const groups = new Map<GeneralActionName, GeneralActionCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.action) ?? [];
    group.push(candidate);
    groups.set(candidate.action, group);
  }

  const orderedGroups = [...groups.values()].sort((left, right) => {
    const leftRank = purposeFitRank[left[0]?.purposeFit ?? "unknown"];
    const rightRank = purposeFitRank[right[0]?.purposeFit ?? "unknown"];
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (left[0]?.order ?? 0) - (right[0]?.order ?? 0);
  });
  const offsets = orderedGroups.map(() => 0);
  const selected: GeneralActionCandidate[] = [];
  while (selected.length < limit) {
    let selectedFromRound = false;
    for (let index = 0; index < orderedGroups.length; index += 1) {
      const group = orderedGroups[index];
      const offset = offsets[index] ?? 0;
      const candidate = group?.[offset];
      if (candidate === undefined) continue;
      selected.push({ ...candidate, order: selected.length });
      offsets[index] = offset + 1;
      selectedFromRound = true;
      if (selected.length >= limit) break;
    }
    if (!selectedFromRound) break;
  }
  return selected;
}

/** Return the recipe execution count needed to meet an item-count request. */
export function craftRunsForOutput(
  requestedCount: number,
  outputCount: number | undefined,
): number | undefined {
  if (
    !Number.isSafeInteger(requestedCount) ||
    requestedCount <= 0 ||
    outputCount === undefined ||
    !Number.isSafeInteger(outputCount) ||
    outputCount <= 0
  ) {
    return undefined;
  }
  return Math.ceil(requestedCount / outputCount);
}

export interface FurnaceSlotState {
  readonly known: boolean;
  readonly itemName?: string;
  readonly count?: number;
}

export type FurnaceBatchReadiness =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "unknown" | "occupied";
      readonly slot: "input" | "fuel" | "output";
      readonly itemName?: string;
    };

/** A batch may start only after all furnace slots are authoritatively empty. */
export function furnaceBatchReadiness(slots: {
  readonly input: FurnaceSlotState;
  readonly fuel: FurnaceSlotState;
  readonly output: FurnaceSlotState;
}): FurnaceBatchReadiness {
  for (const [slot, state] of Object.entries(slots) as readonly [
    "input" | "fuel" | "output",
    FurnaceSlotState,
  ][]) {
    if (!state.known) {
      return { allowed: false, reason: "unknown", slot };
    }
    if (state.itemName !== undefined && (state.count ?? 1) > 0) {
      return {
        allowed: false,
        reason: "occupied",
        slot,
        itemName: state.itemName,
      };
    }
  }
  return { allowed: true };
}

export interface ActionGoalMetadata {
  readonly goalItem?: string;
  readonly intermediateItems?: readonly string[];
}

/**
 * Conservative block-drop facts used at the observation boundary. A missing
 * entry is intentionally unknown; callers must not infer an inventory result
 * from a block name alone.
 */
export const knownBlockDrops: Readonly<Record<string, string>> = {
  stone: "cobblestone",
  deepslate: "cobbled_deepslate",
  clay: "clay_ball",
  gravel: "gravel",
  sand: "sand",
  red_sand: "red_sand",
  dirt: "dirt",
  coarse_dirt: "coarse_dirt",
  rooted_dirt: "rooted_dirt",
  coal_ore: "coal",
  deepslate_coal_ore: "coal",
  iron_ore: "raw_iron",
  deepslate_iron_ore: "raw_iron",
  gold_ore: "raw_gold",
  deepslate_gold_ore: "raw_gold",
  copper_ore: "raw_copper",
  deepslate_copper_ore: "raw_copper",
  diamond_ore: "diamond",
  deepslate_diamond_ore: "diamond",
  emerald_ore: "emerald",
  deepslate_emerald_ore: "emerald",
  redstone_ore: "redstone",
  deepslate_redstone_ore: "redstone",
  lapis_ore: "lapis_lazuli",
  deepslate_lapis_ore: "lapis_lazuli",
  ancient_debris: "ancient_debris",
  oak_log: "oak_log",
  spruce_log: "spruce_log",
  birch_log: "birch_log",
  jungle_log: "jungle_log",
  acacia_log: "acacia_log",
  dark_oak_log: "dark_oak_log",
  mangrove_log: "mangrove_log",
  cherry_log: "cherry_log",
  pale_oak_log: "pale_oak_log",
  crimson_stem: "crimson_stem",
  warped_stem: "warped_stem",
};

export const knownSmeltInputs: Readonly<Record<string, string>> = {
  iron_ingot: "raw_iron",
  gold_ingot: "raw_gold",
  copper_ingot: "raw_copper",
  netherite_scrap: "ancient_debris",
};

export function goalMetadataForOutput(
  output: string,
  requestedItems: ReadonlySet<string>,
): ActionGoalMetadata {
  if (requestedItems.has(output)) return { goalItem: output };
  const goalItem = Object.entries(knownSmeltInputs).find(
    ([goal, input]) => input === output && requestedItems.has(goal),
  )?.[0];
  return goalItem === undefined
    ? {}
    : { goalItem, intermediateItems: [output] };
}

export function goalMetadataForBlock(
  blockName: string,
  requestedItems: ReadonlySet<string>,
): ActionGoalMetadata {
  const output = knownBlockDrops[blockName];
  if (output === undefined) return {};
  if (requestedItems.has(blockName) && !requestedItems.has(output)) {
    return { goalItem: output };
  }
  return goalMetadataForOutput(output, requestedItems);
}

export interface GeneralActionObservationInput {
  readonly radius: number;
  readonly requestedItems: readonly string[];
  readonly maxCandidates: number;
}

export interface MineBlockInput {
  readonly name: string;
  readonly position: Position;
}

export interface CollectItemInput {
  readonly name: string;
  readonly position: Position;
  readonly count: number;
}

export interface CraftItemInput {
  readonly name: string;
  readonly count: number;
}

export interface PlaceBlockInput {
  readonly name: string;
  readonly position: Position;
}

export interface SmeltItemInput {
  readonly input: string;
  readonly output: string;
  readonly count: number;
  readonly furnace?: Position | null | undefined;
}
