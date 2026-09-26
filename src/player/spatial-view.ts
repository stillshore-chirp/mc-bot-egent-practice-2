import { z } from "zod";

import type { PlayerBodyObservation } from "../minecraft/player-body.js";

const axisBoundsSchema = z.tuple([z.number(), z.number()]);

export const spatialViewSchema = z
  .object({
    observedAt: z.iso.datetime(),
    dimension: z.string().min(1).max(80),
    selfCell: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        z: z.number().int(),
      })
      .strict(),
    facingCardinal: z.enum(["east", "west", "south", "north", "unknown"]),
    coverage: z.literal("visible_subset"),
    candidateSearchMayBeTruncated: z.boolean(),
    omittedBlockCandidates: z.number().int().nonnegative(),
    visibleBlockBounds: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            count: z.number().int().positive(),
            x: axisBoundsSchema,
            y: axisBoundsSchema,
            z: axisBoundsSchema,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export type PlayerSpatialView = z.infer<typeof spatialViewSchema>;

export function cardinalFacingFromYaw(
  yaw: number,
): PlayerSpatialView["facingCardinal"] {
  if (!Number.isFinite(yaw)) return "unknown";
  const x = -Math.sin(yaw);
  const z = -Math.cos(yaw);
  return Math.abs(x) >= Math.abs(z)
    ? x >= 0
      ? "east"
      : "west"
    : z >= 0
      ? "south"
      : "north";
}

/** A bounded record of positions actually visible from one viewpoint. */
export function toSpatialView(
  observation: PlayerBodyObservation,
): PlayerSpatialView | undefined {
  const position = observation.self.position;
  if (![position.x, position.y, position.z].every(Number.isFinite))
    return undefined;

  const byName = new Map<
    string,
    PlayerSpatialView["visibleBlockBounds"][number]
  >();
  for (const block of observation.perception.blocks) {
    const { x, y, z } = block.position;
    if (
      block.position.dimension !== observation.dimension ||
      ![x, y, z].every(Number.isFinite)
    )
      continue;
    const name = block.name.slice(0, 80);
    if (name.length === 0) continue;
    const existing = byName.get(name);
    byName.set(
      name,
      existing === undefined
        ? { name, count: 1, x: [x, x], y: [y, y], z: [z, z] }
        : {
            name,
            count: existing.count + 1,
            x: [Math.min(existing.x[0], x), Math.max(existing.x[1], x)],
            y: [Math.min(existing.y[0], y), Math.max(existing.y[1], y)],
            z: [Math.min(existing.z[0], z), Math.max(existing.z[1], z)],
          },
    );
  }
  const all = [...byName.values()].sort(
    (left, right) =>
      right.count - left.count || left.name.localeCompare(right.name),
  );
  const selected = new Map(
    [...all.slice(0, 4), ...all.slice(-4)].map((entry) => [entry.name, entry]),
  );
  return spatialViewSchema.parse({
    observedAt: observation.observedAt,
    dimension: observation.dimension.slice(0, 80),
    selfCell: {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    },
    facingCardinal: cardinalFacingFromYaw(observation.self.yaw),
    coverage: "visible_subset",
    candidateSearchMayBeTruncated:
      observation.perception.candidateSearchMayBeTruncated,
    omittedBlockCandidates: observation.perception.omittedBlockCandidates,
    visibleBlockBounds: [...selected.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  });
}
