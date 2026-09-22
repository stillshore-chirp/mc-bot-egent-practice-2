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
  readonly distance: number;
  readonly order: number;
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
