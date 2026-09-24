import type { PlayerBodyObservation } from "../minecraft/player-body.js";
import type { PlayerObservationEvidence } from "./contracts.js";

const containerNames = new Set([
  "barrel",
  "chest",
  "trapped_chest",
  "ender_chest",
  "shulker_box",
  "white_shulker_box",
  "orange_shulker_box",
  "magenta_shulker_box",
  "light_blue_shulker_box",
  "yellow_shulker_box",
  "lime_shulker_box",
  "pink_shulker_box",
  "gray_shulker_box",
  "light_gray_shulker_box",
  "cyan_shulker_box",
  "purple_shulker_box",
  "blue_shulker_box",
  "brown_shulker_box",
  "green_shulker_box",
  "red_shulker_box",
  "black_shulker_box",
]);

/** Persist a small visibility receipt; never retain owner exception coordinates or usernames. */
export function toObservationEvidence(
  observation: PlayerBodyObservation,
): PlayerObservationEvidence {
  const blocks = observation.perception.blocks;
  return {
    observedAt: observation.observedAt,
    dimension: observation.dimension.slice(0, 80),
    day: observation.time.day,
    timeOfDay: observation.time.timeOfDay,
    isDay: observation.time.isDay,
    health: observation.self.health,
    food: observation.self.food,
    oxygen: observation.self.oxygen,
    inWater: observation.self.inWater,
    inLava: observation.self.inLava,
    onFire: observation.self.onFire,
    inventoryTotal: observation.self.inventory.reduce(
      (total, { count }) => total + count,
      0,
    ),
    inventoryNames: [
      ...new Set(
        observation.self.inventory.map(({ name }) => name.slice(0, 80)),
      ),
    ].slice(0, 48),
    visibleBlockNames: [
      ...new Set(blocks.map(({ name }) => name.slice(0, 80))),
    ].slice(0, 48),
    visibleContainers: blocks
      .filter(({ name }) => containerNames.has(name))
      .slice(0, 24)
      .map(({ name, position, distance }) => ({
        name,
        position: {
          x: position.x,
          y: position.y,
          z: position.z,
          dimension: position.dimension.slice(0, 80),
        },
        distance: Math.max(0, distance),
      })),
    visibleEntityKinds: [
      ...new Set(
        observation.perception.entities.map(({ kind, category }) =>
          `${kind}${category === null ? "" : `:${category}`}`.slice(0, 80),
        ),
      ),
    ].slice(0, 32),
    candidateSearchMayBeTruncated:
      observation.perception.candidateSearchMayBeTruncated,
    ownerPositionExceptionUsed:
      observation.perception.ownerPositionException !== undefined,
  };
}

export function trustedConditions(
  observation: PlayerBodyObservation | null,
): string[] {
  if (observation === null) return [];
  const inventory = [
    ...new Map(
      observation.self.inventory.map(({ name, count }) => [name, count]),
    ).entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 8)
    .map(([name, count]) => `inventory:${name}=${count}`);
  const timeOfDay = observation.time.timeOfDay;
  const timeBand =
    timeOfDay === null
      ? "unknown"
      : timeOfDay < 3_000 || timeOfDay >= 21_000
        ? "night"
        : timeOfDay < 6_000 || timeOfDay >= 18_000
          ? "twilight"
          : "day";
  return [
    `dimension:${observation.dimension}`,
    `day:${observation.time.day ?? "unknown"}`,
    `time:${timeBand}`,
    `health:${observation.self.health ?? "unknown"}`,
    `food:${observation.self.food ?? "unknown"}`,
    `oxygen:${observation.self.oxygen ?? "unknown"}`,
    `in_water:${observation.self.inWater ?? "unknown"}`,
    `in_lava:${observation.self.inLava ?? "unknown"}`,
    `on_fire:${observation.self.onFire ?? "unknown"}`,
    ...inventory,
  ].slice(0, 16);
}
