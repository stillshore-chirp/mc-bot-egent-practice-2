import type { Position, WorldSnapshot } from "../domain/snapshot.js";
import type { BuildBlockObservation } from "../minecraft/port.js";

export const baseBuildMaterial = "oak_planks";
export const baseBuildLog = "oak_log";
export const baseBuildMaxBlocks = 23;
export const baseBuildMaxLogs = 6;

export interface BaseBuildPlan {
  readonly dimension: string;
  readonly center: Position;
  readonly material: typeof baseBuildMaterial;
  readonly blocks: readonly Position[];
}

export function buildSiteCandidates(
  snapshot: WorldSnapshot,
): readonly Position[] {
  const origin = {
    x: Math.floor(snapshot.position.x),
    y: Math.floor(snapshot.position.y),
    z: Math.floor(snapshot.position.z),
  };
  return [
    [0, 0],
    [4, 0],
    [-4, 0],
    [0, 4],
    [0, -4],
  ].map(([dx, dz]) => ({
    x: origin.x + (dx ?? 0),
    y: origin.y,
    z: origin.z + (dz ?? 0),
  }));
}

export function buildPlan(
  center: Position,
  dimension: string,
  origin: Position,
): BaseBuildPlan {
  const doorX =
    Math.abs(center.x - origin.x) >= Math.abs(center.z - origin.z)
      ? center.x + (origin.x <= center.x ? -1 : 1)
      : center.x;
  const doorZ =
    doorX === center.x ? center.z + (origin.z <= center.z ? -1 : 1) : center.z;
  const walls: Position[] = [];
  const roof: Position[] = [];
  for (let y = center.y; y <= center.y + 1; y += 1) {
    for (let x = center.x - 1; x <= center.x + 1; x += 1) {
      for (let z = center.z - 1; z <= center.z + 1; z += 1) {
        if (Math.abs(x - center.x) !== 1 && Math.abs(z - center.z) !== 1)
          continue;
        if (x === doorX && z === doorZ) continue;
        walls.push({ x, y, z });
      }
    }
  }
  for (let x = center.x - 1; x <= center.x + 1; x += 1) {
    for (let z = center.z - 1; z <= center.z + 1; z += 1) {
      if (x === center.x && z === center.z) continue;
      roof.push({ x, y: center.y + 2, z });
    }
  }
  roof.push({ x: center.x, y: center.y + 2, z: center.z });
  return {
    dimension,
    center,
    material: baseBuildMaterial,
    blocks: [...walls, ...roof],
  };
}

export const buildBlockKey = (position: Position): string =>
  `${position.x}:${position.y}:${position.z}`;

export function siteClearOfPlayers(
  snapshot: WorldSnapshot,
  center: Position,
): boolean {
  return snapshot.players.every(
    (player) =>
      Math.hypot(player.position.x - center.x, player.position.z - center.z) >
      2.5,
  );
}

export function buildStateSafe(snapshot: WorldSnapshot): boolean {
  return (
    snapshot.connected &&
    snapshot.spawned &&
    snapshot.health >= 12 &&
    snapshot.food >= 10 &&
    !snapshot.inWater &&
    !snapshot.inLava &&
    !snapshot.onFire &&
    !snapshot.suffocating &&
    snapshot.nearbyEntities.every(
      (entity) => !entity.hostile || entity.distance > 8,
    )
  );
}

export function groundSuitable(observation: BuildBlockObservation): boolean {
  return (
    observation.serverConfirmed &&
    [
      "grass_block",
      "dirt",
      "coarse_dirt",
      "stone",
      "sand",
      "sandstone",
    ].includes(observation.name ?? "")
  );
}

export function placementState(
  observation: BuildBlockObservation,
  material: string,
  previouslyVerified: boolean,
): "empty" | "verified" | "blocked" {
  if (
    observation.name === "air" &&
    observation.serverConfirmed &&
    observation.placementAllowed
  )
    return "empty";
  if (
    observation.name === material &&
    observation.serverConfirmed &&
    previouslyVerified
  )
    return "verified";
  return "blocked";
}
