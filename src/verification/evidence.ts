import { createHash } from "node:crypto";
import type { WorldSnapshot } from "../domain/snapshot.js";

export interface SnapshotEvidence {
  readonly observedAt: string;
  readonly digest: string;
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly health: number;
  readonly food: number;
  readonly inventory: readonly {
    readonly name: string;
    readonly count: number;
  }[];
}

export function createSnapshotEvidence(
  snapshot: WorldSnapshot,
): SnapshotEvidence {
  const payload = {
    observedAt: snapshot.observedAt,
    dimension: snapshot.dimension,
    position: snapshot.position,
    health: snapshot.health,
    food: snapshot.food,
    inventory: snapshot.inventory,
  };
  return {
    observedAt: snapshot.observedAt,
    digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    position: snapshot.position,
    health: snapshot.health,
    food: snapshot.food,
    inventory: snapshot.inventory,
  };
}
