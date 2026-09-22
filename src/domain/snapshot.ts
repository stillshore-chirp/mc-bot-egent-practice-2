export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type ObservationSubject = "bot";
export type ObservationSource = "minecraft";

export interface ObservationAttribution {
  readonly subject: ObservationSubject;
  readonly source: ObservationSource;
  readonly observedAt: string;
}

export type OxygenObservationState =
  "normal" | "low" | "not_applicable" | "unknown";

export const oxygenObservationState = (
  oxygen: number | null,
  inWater: boolean,
  lowOxygenThreshold = 5,
): OxygenObservationState => {
  if (
    oxygen === null ||
    !Number.isFinite(oxygen) ||
    oxygen < 0 ||
    oxygen > 20
  ) {
    return "unknown";
  }
  if (!inWater) return "not_applicable";
  return oxygen <= lowOxygenThreshold ? "low" : "normal";
};

export interface InventoryEntry {
  readonly name: string;
  readonly count: number;
}

export interface ArmorEquipment {
  readonly head: string | null;
  readonly torso: string | null;
  readonly legs: string | null;
  readonly feet: string | null;
}

export type ArmorSlot = keyof ArmorEquipment;

export interface PlayerObservation {
  readonly username: string;
  readonly position: Position;
  readonly distance: number;
}

export interface EntityObservation {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly position: Position;
  readonly distance: number;
  readonly hostile: boolean;
}

export interface BlockObservation {
  readonly name: string;
  readonly position: Position;
  readonly distance: number;
}

export interface SurroundingsObservation extends ObservationAttribution {
  readonly oxygen: number | null;
  readonly oxygenState: OxygenObservationState;
  readonly inWater: boolean;
  readonly blocks: readonly BlockObservation[];
  readonly entities: readonly EntityObservation[];
  readonly hazards: readonly string[];
}

export interface WorldSnapshot extends ObservationAttribution {
  readonly connected: boolean;
  readonly spawned: boolean;
  readonly dimension: string;
  readonly position: Position;
  readonly velocityY: number;
  readonly health: number;
  readonly food: number;
  readonly oxygen: number | null;
  readonly oxygenState: OxygenObservationState;
  readonly onFire: boolean;
  readonly inWater: boolean;
  readonly inLava: boolean;
  readonly suffocating: boolean;
  readonly inventory: readonly InventoryEntry[];
  /** Null means equipment slots could not be observed. */
  readonly armor: ArmorEquipment | null;
  readonly players: readonly PlayerObservation[];
  readonly nearbyEntities: readonly EntityObservation[];
}

export const countInventory = (
  snapshot: WorldSnapshot,
  itemName: string,
): number =>
  snapshot.inventory
    .filter((entry) => entry.name === itemName)
    .reduce((sum, entry) => sum + entry.count, 0);

export const distance = (left: Position, right: Position): number =>
  Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
