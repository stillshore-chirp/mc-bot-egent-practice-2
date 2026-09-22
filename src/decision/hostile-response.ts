import type { WorldSnapshot } from "../domain/snapshot.js";

const meleeTargets = new Set(["zombie", "husk", "zombie_villager"]);
const meleeWeapons =
  /^(?:wooden|stone|iron|golden|diamond|netherite)_(?:sword|axe)$/u;

export type HostileGoal = "eliminate" | "evade";

export type HostileDecision =
  | { readonly mode: "none" }
  | { readonly mode: "attack"; readonly entityId: number }
  | { readonly mode: "retreat"; readonly reason: string };

/** Selects only from the Bot's current Minecraft observation, never model text. */
export function decideHostileResponse(
  snapshot: WorldSnapshot,
): HostileDecision {
  const hostiles = snapshot.nearbyEntities
    .filter((entity) => entity.hostile && entity.distance <= 32)
    .sort((left, right) => left.distance - right.distance);
  const target = hostiles[0];
  if (target === undefined) return { mode: "none" };
  if (
    hostiles.length === 1 &&
    meleeTargets.has(target.name) &&
    target.distance <= 3 &&
    snapshot.health >= 18 &&
    snapshot.food >= 8 &&
    !snapshot.onFire &&
    !snapshot.inLava &&
    !snapshot.inWater &&
    !snapshot.suffocating &&
    snapshot.inventory.some(
      (item) => item.count > 0 && meleeWeapons.test(item.name),
    )
  ) {
    return { mode: "attack", entityId: target.id };
  }

  return {
    mode: "retreat",
    reason:
      hostiles.length > 1
        ? "複数の敵を確認したため"
        : !meleeTargets.has(target.name)
          ? "相手の危険度が高いため"
          : !snapshot.inventory.some(
                (item) => item.count > 0 && meleeWeapons.test(item.name),
              )
            ? "安全に使える武器を確認できないため"
            : "安全に近接できる状態ではないため",
  };
}

export function closestHostileDistance(snapshot: WorldSnapshot): number | null {
  const distances = snapshot.nearbyEntities
    .filter((entity) => entity.hostile)
    .map((entity) => entity.distance);
  return distances.length === 0 ? null : Math.min(...distances);
}
