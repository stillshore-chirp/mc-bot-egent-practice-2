import { z } from "zod";

const vectorSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  })
  .strict();

const blockTargetSchema = z
  .object({ kind: z.literal("block"), position: vectorSchema })
  .strict();
const entityTargetSchema = z
  .object({ kind: z.literal("entity"), entityId: z.number().int().positive() })
  .strict();

const controlsSchema = z
  .object({
    forward: z.boolean().optional(),
    back: z.boolean().optional(),
    left: z.boolean().optional(),
    right: z.boolean().optional(),
    jump: z.boolean().optional(),
    sprint: z.boolean().optional(),
    sneak: z.boolean().optional(),
  })
  .strict()
  .refine((controls) => Object.keys(controls).length > 0);

const countSchema = z.number().int().min(1).max(64);
const itemNameSchema = z.string().trim().min(1).max(128);
const boundedTextSchema = z.string().max(4096);
const signLineSchema = z
  .string()
  .max(45)
  .refine((line) => !line.includes("\n") && !line.includes("\r"));

export const playerOperationNames = [
  "move_to",
  "move_relative",
  "look",
  "look_sweep",
  "control",
  "equip",
  "use",
  "attack",
  "dig",
  "place",
  "craft",
  "open_window",
  "window_click",
  "window_transfer",
  "window_close",
  "consume",
  "toss",
  "transfer",
  "fish",
  "sleep",
  "wake",
  "mount",
  "dismount",
  "move_vehicle",
  "elytra_fly",
  "trade",
  "enchant",
  "anvil",
  "write_book",
  "update_sign",
] as const;

export type PlayerOperationName = (typeof playerOperationNames)[number];

export const playerOperationDescriptions = {
  move_to:
    "Move near a world position using normal pathfinding and server physics.",
  move_relative:
    "Move by a bounded offset from the current position using pathfinding. Positive X is east and positive Z is south; use when direction is known but the destination is not visible.",
  look: "Turn the player's view toward a world position.",
  look_sweep:
    "Physically look in eight directions at pitchDegrees from -60 (down) to 60 (up); omitted pitchDegrees defaults to -25. Each view reports its observed pitch and only the blocks and non-player entities visible from that view. The result is a bounded visible subset; a missing target is not proof of absence.",
  control:
    "Hold the selected movement, jump, sprint, or sneak controls for bounded ticks.",
  equip: "Equip an inventory item into a player equipment slot.",
  use: "Use a held item for 1-200 ticks (default 4), or interact with a currently visible block or entity.",
  attack: "Attack a currently visible entity within normal player reach.",
  dig: "Mine a currently visible block within normal player reach.",
  place:
    "Place an inventory item at a reported empty-cell candidate; use its position and supporting face.",
  craft:
    "Craft a registry recipe using the current inventory and available crafting surface.",
  open_window: "Open a currently visible block or entity interface.",
  window_click: "Click a slot in the currently open Minecraft interface.",
  window_transfer:
    "Transfer an exact item count between player inventory and the open interface.",
  window_close: "Close the currently open Minecraft interface.",
  consume: "Eat a matching food item from inventory.",
  toss: "Drop an exact item count from inventory into the world.",
  transfer: "Move an item stack between two player inventory slots.",
  fish: "Use a fishing rod and reel in an observed catch.",
  sleep: "Attempt to sleep in a reachable bed.",
  wake: "Wake the player from sleep.",
  mount: "Mount a currently visible entity within normal interaction reach.",
  dismount: "Dismount from the current vehicle or mount.",
  move_vehicle: "Steer the current vehicle with bounded directional input.",
  elytra_fly: "Attempt to start elytra flight using the equipped elytra.",
  trade: "Trade a selected offer with a currently visible villager.",
  enchant: "Enchant an inventory item using a reachable enchanting table.",
  anvil: "Combine or rename inventory items using a reachable anvil.",
  write_book: "Write the supplied pages into a writable book in inventory.",
  update_sign: "Write text to the front or back of a reachable sign.",
} satisfies Record<PlayerOperationName, string>;

const playerOperationBaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("move_to"),
      position: vectorSchema,
      range: z.number().min(0.25).max(8).default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("move_relative"),
      offset: z
        .object({
          x: z.number().min(-32).max(32),
          y: z.number().min(-32).max(32),
          z: z.number().min(-32).max(32),
        })
        .strict(),
      range: z.number().min(0.25).max(8).default(1),
    })
    .strict(),
  z.object({ kind: z.literal("look"), target: vectorSchema }).strict(),
  z
    .object({
      kind: z.literal("look_sweep"),
      pitchDegrees: z.number().min(-60).max(60).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("control"),
      controls: controlsSchema,
      ticks: z.number().int().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("equip"),
      item: itemNameSchema,
      destination: z.enum([
        "hand",
        "head",
        "torso",
        "legs",
        "feet",
        "off-hand",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("use"),
      target: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("item"),
            offHand: z.boolean().default(false),
            holdTicks: z.number().int().min(1).max(200).default(4),
          })
          .strict(),
        blockTargetSchema,
        entityTargetSchema,
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("attack"),
      entityId: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("dig"), position: vectorSchema }).strict(),
  z
    .object({
      kind: z.literal("place"),
      item: itemNameSchema,
      position: vectorSchema,
      face: z.enum(["up", "down", "north", "south", "east", "west"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("craft"),
      item: itemNameSchema,
      count: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("open_window"),
      target: z.discriminatedUnion("kind", [
        blockTargetSchema,
        entityTargetSchema,
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("window_click"),
      slot: z.number().int().min(0).max(255),
      button: z.number().int().min(0).max(2),
      mode: z.number().int().min(0).max(6).default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("window_transfer"),
      item: itemNameSchema,
      count: countSchema,
      direction: z.enum(["inventory_to_window", "window_to_inventory"]),
    })
    .strict(),
  z.object({ kind: z.literal("window_close") }).strict(),
  z
    .object({ kind: z.literal("consume"), item: itemNameSchema.optional() })
    .strict(),
  z
    .object({
      kind: z.literal("toss"),
      item: itemNameSchema,
      count: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("transfer"),
      sourceSlot: z.number().int().min(0).max(255),
      destinationSlot: z.number().int().min(0).max(255),
    })
    .strict(),
  z.object({ kind: z.literal("fish") }).strict(),
  z.object({ kind: z.literal("sleep"), position: vectorSchema }).strict(),
  z.object({ kind: z.literal("wake") }).strict(),
  z
    .object({ kind: z.literal("mount"), entityId: z.number().int().positive() })
    .strict(),
  z.object({ kind: z.literal("dismount") }).strict(),
  z
    .object({
      kind: z.literal("move_vehicle"),
      left: z.number().min(-1).max(1),
      forward: z.number().min(-1).max(1),
      ticks: z.number().int().min(1).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("elytra_fly") }).strict(),
  z
    .object({
      kind: z.literal("trade"),
      entityId: z.number().int().positive(),
      tradeIndex: z.union([
        z.number().int().nonnegative(),
        z.string().trim().regex(/^\d+$/).max(64),
      ]),
      times: z.number().int().min(1).max(64).default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("enchant"),
      position: vectorSchema,
      item: itemNameSchema,
      lapisItem: itemNameSchema.default("lapis_lazuli"),
      choice: z.union([
        z.number().int().nonnegative(),
        z.string().trim().regex(/^\d+$/).max(64),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("anvil"),
      position: vectorSchema,
      operation: z.enum(["combine", "rename"]),
      firstItem: itemNameSchema,
      secondItem: itemNameSchema.optional(),
      name: z.string().trim().min(1).max(35).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("write_book"),
      slot: z.number().int().min(0).max(44),
      pages: z.array(boundedTextSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_sign"),
      position: vectorSchema,
      text: z.array(signLineSchema).min(1).max(4),
      back: z.boolean().default(false),
    })
    .strict(),
]);

export const playerOperationSchema = playerOperationBaseSchema.superRefine(
  (operation, context) => {
    if (
      operation.kind === "move_relative" &&
      Math.hypot(operation.offset.x, operation.offset.y, operation.offset.z) <=
        operation.range
    ) {
      context.addIssue({
        code: "custom",
        path: ["offset"],
        message: "move_relative offset must exceed the arrival range",
      });
    }
    if (operation.kind !== "anvil") return;
    if (operation.operation === "combine" && operation.secondItem === undefined)
      context.addIssue({
        code: "custom",
        path: ["secondItem"],
        message: "combine requires secondItem",
      });
    if (operation.operation === "rename" && operation.name === undefined)
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "rename requires a non-empty name",
      });
  },
);

export type PlayerOperation = z.output<typeof playerOperationSchema>;

export function isPlayerOperationName(
  value: string,
): value is PlayerOperationName {
  return (playerOperationNames as readonly string[]).includes(value);
}
