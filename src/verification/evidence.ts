import { createHash } from "node:crypto";
import type { WorldSnapshot } from "../domain/snapshot.js";

export interface SnapshotEvidence {
  readonly observedAt: string;
  readonly subject: "bot";
  readonly source: "minecraft";
  readonly digest: string;
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly health: number;
  readonly food: number;
  readonly oxygen: number | null;
  readonly oxygenState: "normal" | "low" | "not_applicable" | "unknown";
  readonly inWater: boolean;
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
    subject: snapshot.subject,
    source: snapshot.source,
    dimension: snapshot.dimension,
    position: snapshot.position,
    health: snapshot.health,
    food: snapshot.food,
    oxygen: snapshot.oxygen,
    oxygenState: snapshot.oxygenState,
    inWater: snapshot.inWater,
    inventory: snapshot.inventory,
  };
  return {
    observedAt: snapshot.observedAt,
    subject: snapshot.subject,
    source: snapshot.source,
    digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    position: snapshot.position,
    health: snapshot.health,
    food: snapshot.food,
    oxygen: snapshot.oxygen,
    oxygenState: snapshot.oxygenState,
    inWater: snapshot.inWater,
    inventory: snapshot.inventory,
  };
}
