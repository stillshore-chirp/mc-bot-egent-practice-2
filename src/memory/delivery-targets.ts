import { z } from "zod";
const position = z
  .object({
    x: z.number().min(-30_000_000).max(30_000_000),
    y: z.number().min(-2048).max(2048),
    z: z.number().min(-30_000_000).max(30_000_000),
  })
  .strict();
const common = {
  worldId: z.uuid(),
  dimension: z.string().min(1).max(100),
  position,
};
export const deliveryTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("home"), ...common }).strict(),
  z
    .object({
      kind: z.literal("chest"),
      ...common,
      identity: z.string().min(1).max(500),
    })
    .strict(),
]);
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;
export type DeliveryTargetKind = DeliveryTarget["kind"];
export type ChestTarget = Extract<DeliveryTarget, { kind: "chest" }>;
