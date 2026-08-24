import {
  countInventory,
  distance,
  type WorldSnapshot,
} from "../domain/snapshot.js";

export interface SnapshotDiff {
  readonly elapsedMs: number;
  readonly movedDistance: number;
  readonly healthDelta: number;
  readonly foodDelta: number;
  readonly inventoryDelta: Readonly<Record<string, number>>;
}

export function diffSnapshots(
  before: WorldSnapshot,
  after: WorldSnapshot,
): SnapshotDiff {
  const names = new Set([
    ...before.inventory.map((entry) => entry.name),
    ...after.inventory.map((entry) => entry.name),
  ]);
  return {
    elapsedMs: Math.max(
      0,
      Date.parse(after.observedAt) - Date.parse(before.observedAt),
    ),
    movedDistance: distance(before.position, after.position),
    healthDelta: after.health - before.health,
    foodDelta: after.food - before.food,
    inventoryDelta: Object.fromEntries(
      [...names].map((name) => [
        name,
        countInventory(after, name) - countInventory(before, name),
      ]),
    ),
  };
}
