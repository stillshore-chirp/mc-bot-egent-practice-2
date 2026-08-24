export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface InventoryEntry {
  readonly name: string;
  readonly count: number;
}

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

export interface SurroundingsObservation {
  readonly observedAt: string;
  readonly blocks: readonly BlockObservation[];
  readonly entities: readonly EntityObservation[];
  readonly hazards: readonly string[];
}

export interface WorldSnapshot {
  readonly observedAt: string;
  readonly connected: boolean;
  readonly spawned: boolean;
  readonly dimension: string;
  readonly position: Position;
  readonly velocityY: number;
  readonly health: number;
  readonly food: number;
  readonly oxygen: number;
  readonly onFire: boolean;
  readonly inWater: boolean;
  readonly inLava: boolean;
  readonly suffocating: boolean;
  readonly inventory: readonly InventoryEntry[];
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
