import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Window } from "prismarine-windows";
import { z } from "zod";
import { Vec3 } from "vec3";
import { isHostileEntity } from "../decision/hostile-classification.js";
import { sameMinecraftIdentity } from "../domain/minecraft-identity.js";
import { isHandOperableDoor } from "./navigation-movements.js";

export interface BodyBlockCoordinates {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BodyPosition extends BodyBlockCoordinates {
  readonly dimension: string;
}

export interface BodyItemStack {
  readonly slot: number;
  readonly itemId: number;
  readonly name: string;
  readonly count: number;
  readonly metadata: number;
  readonly durability: number | null;
  readonly maxDurability: number | null;
  readonly customName: string | null;
  readonly bookPages?: readonly string[];
  readonly enchantments: readonly {
    readonly name: string;
    readonly level: number;
  }[];
}

export interface BodyVisibleBlock {
  readonly name: string;
  readonly stateId: number;
  readonly position: BodyPosition;
  readonly distance: number;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly signText?: readonly string[];
}

export type BodyPlacementFace =
  "up" | "down" | "north" | "south" | "east" | "west";

export interface BodyPlacementCandidate {
  /** The currently loaded air cell to pass as the place operation position. */
  readonly position: BodyBlockCoordinates;
  /** A visible, reachable support block and the face normal to pass to place. */
  readonly supportingBlock: {
    readonly name: string;
    readonly position: BodyBlockCoordinates;
  };
  /** Eye-to-cell-center distance; candidates stay inside default block reach. */
  readonly distance: number;
  readonly face: BodyPlacementFace;
}

export interface BodyVisibleEntity {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly category: string | null;
  readonly position: BodyPosition;
  readonly distance: number;
  readonly health: number | null;
  readonly isPlayer: boolean;
  readonly username?: string;
  /** Omitted slots are unknown; null means explicitly empty. */
  readonly equipment?: BodyVisibleEntityEquipment;
  readonly droppedItem?: BodyVisibleDroppedItem;
}

export interface BodyVisibleEntityEquipment {
  readonly mainHand?: string | null;
  readonly offHand?: string | null;
  readonly head?: string | null;
  readonly torso?: string | null;
  readonly legs?: string | null;
  readonly feet?: string | null;
}

export interface BodyVisibleDroppedItem {
  readonly name: string;
  readonly count: number;
}

export interface PlayerBodyNearbyHostiles {
  /** Detailed entities below have an unoccluded ray, regardless of FOV. */
  readonly source: "client_received_unoccluded_nearby_hostiles";
  readonly observedAt: string;
  readonly maxDistance: number;
  readonly entityOutputLimit: number;
  readonly omittedEntityCandidates: number;
  readonly candidateSearchMayBeTruncated: boolean;
  readonly entities: readonly BodyVisibleEntity[];
  /** All client-received hostile candidates in range, before occlusion checks. */
  readonly aggregate?: PlayerBodyNearbyHostileAggregate | undefined;
}

export type BodyNearbyHostileDirection =
  | "north"
  | "northeast"
  | "east"
  | "southeast"
  | "south"
  | "southwest"
  | "west"
  | "northwest"
  /** Same horizontal X/Z column; Y remains represented in offset bounds. */
  | "coincident";

export interface BodyNearbyHostileOffsetBounds {
  readonly min: BodyBlockCoordinates;
  readonly max: BodyBlockCoordinates;
}

export interface BodyNearbyHostileKindCount {
  /** Registry/entity name, not a display name. */
  readonly name: string;
  readonly count: number;
}

export interface BodyNearbyHostileDirectionCount {
  readonly direction: BodyNearbyHostileDirection;
  readonly count: number;
  /** Three-dimensional distance to entity positions. */
  readonly nearestDistance: number | null;
  readonly farthestDistance: number | null;
  /** Entity position minus the bot position, in world X/Y/Z coordinates. */
  readonly relativeOffsetBounds: BodyNearbyHostileOffsetBounds | null;
}

export interface PlayerBodyNearbyHostileAggregate {
  readonly source: "client_received_hostile_entity_candidates";
  readonly countScope: "client_entity_table_within_max_distance";
  /** Euclidean range; hostile aggregation is independent of FOV and occlusion. */
  readonly maxDistance: number;
  /** Exact for the client entity table and range; not a world census. */
  readonly clientReceivedHostileCount: number;
  readonly worldAbsenceEstablished: false;
  /** Minecraft world compass: +X east, +Z south; independent of bot yaw. */
  readonly directionFrame: "minecraft_cardinal_from_self_position";
  readonly relativeOffsetFrame: "entity_position_minus_self_position";
  readonly relativeOffsetBounds: BodyNearbyHostileOffsetBounds | null;
  /** Largest groups by registry/entity name; counts include every candidate. */
  readonly byKind: readonly BodyNearbyHostileKindCount[];
  readonly omittedKindGroupCount: number;
  readonly omittedKindEntityCount: number;
  /** Fixed compass bins; aggregate offsets include occluded candidates. */
  readonly byDirection: readonly BodyNearbyHostileDirectionCount[];
  /** Raycasts are bounded to the nearest candidate subset used for details. */
  readonly occlusionCheck: {
    readonly method: "raycast_entity_body_point";
    readonly candidateLimit: number;
    readonly candidatesChecked: number;
    readonly unoccludedCandidates: number;
    readonly occludedCandidates: number;
    readonly uncheckedCandidates: number;
    readonly detailOutputLimit: number;
    readonly omittedUnoccludedDetails: number;
  };
}

export interface BodyWindowSnapshot {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly inventoryStart: number;
  readonly inventoryEnd: number;
  readonly selectedItem: BodyItemStack | null;
  readonly slots: readonly (BodyItemStack | null)[];
}

export interface PlayerBodyObservation {
  readonly observedAt: string;
  readonly source: "minecraft";
  readonly gameVersion: string;
  readonly dimension: string;
  readonly time: {
    readonly day: number | null;
    readonly timeOfDay: number | null;
    readonly isDay: boolean | null;
    readonly raining: boolean | null;
  };
  readonly self: {
    readonly username: string;
    readonly position: BodyPosition;
    readonly eyeHeight: number;
    readonly yaw: number;
    readonly pitch: number;
    readonly velocity: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
    readonly health: number | null;
    readonly food: number | null;
    readonly foodSaturation: number | null;
    readonly oxygen: number | null;
    readonly inWater: boolean | null;
    readonly inLava: boolean | null;
    readonly onFire: boolean | null;
    readonly suffocating: boolean | null;
    readonly sleeping: boolean;
    readonly mountedEntityId: number | null;
    readonly gameMode: string | null;
    readonly experience: {
      readonly level: number;
      readonly points: number;
      readonly progress: number;
    };
    readonly inventory: readonly BodyItemStack[];
    readonly equipment: Readonly<Record<string, BodyItemStack | null>>;
  };
  readonly perception: {
    readonly horizontalFieldOfViewDegrees: number;
    readonly verticalFieldOfViewDegrees: number;
    readonly maxDistance: number;
    readonly coverage: "visible_subset";
    readonly blockCountLimit: number;
    readonly entityCountLimit: number;
    readonly blockCandidateLimit: number;
    readonly entityCandidateLimit: number;
    readonly omittedBlockCandidates: number;
    readonly omittedEntityCandidates: number;
    readonly candidateSearchMayBeTruncated: boolean;
    readonly blocks: readonly BodyVisibleBlock[];
    readonly placementCandidateLimit: number;
    readonly omittedPlacementCandidates: number;
    readonly placementCandidatesMayBeTruncated: boolean;
    readonly placementCandidates: readonly BodyPlacementCandidate[];
    readonly entities: readonly BodyVisibleEntity[];
    /** Current client-received nearby hostiles, a visible subset rather than a world census. */
    readonly nearbyHostiles?: PlayerBodyNearbyHostiles | undefined;
    readonly ownerPositionException?: {
      readonly username: string;
      readonly position: BodyPosition;
      readonly source: "owner_position_exception";
      readonly currentlyVisible: boolean;
    };
  };
  readonly window: BodyWindowSnapshot | null;
}

export const playerBodyLookSweepDirectionCount = 8;
export const playerBodyLookSweepBlockLimit = 8;
export const playerBodyLookSweepEntityLimit = 2;

const lookSweepPositionSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  })
  .strict();

const lookSweepBlockSchema = z
  .object({
    name: z.string().min(1).max(80),
    position: lookSweepPositionSchema,
    distance: z.number().min(0),
  })
  .strict();

const lookSweepEntitySchema = z
  .object({
    name: z.string().min(1).max(80),
    kind: z.string().min(1).max(80),
    category: z.string().max(80).nullable(),
    position: lookSweepPositionSchema,
    distance: z.number().min(0),
    equipment: z
      .object({
        mainHand: z.string().min(1).max(80).nullable().optional(),
        offHand: z.string().min(1).max(80).nullable().optional(),
        head: z.string().min(1).max(80).nullable().optional(),
        torso: z.string().min(1).max(80).nullable().optional(),
        legs: z.string().min(1).max(80).nullable().optional(),
        feet: z.string().min(1).max(80).nullable().optional(),
      })
      .strict()
      .optional(),
    droppedItem: z
      .object({
        name: z.string().min(1).max(80),
        count: z.number().int().min(1).max(127),
      })
      .strict()
      .optional(),
  })
  .strict();

const lookSweepViewSchema = z
  .object({
    directionIndex: z
      .number()
      .int()
      .min(0)
      .max(playerBodyLookSweepDirectionCount - 1)
      .nullable(),
    yawDegrees: z.number().min(-180).max(180),
    pitchDegrees: z.number().min(-90).max(90),
    dimension: z.string().min(1).max(80),
    visibleBlocks: z
      .array(lookSweepBlockSchema)
      .max(playerBodyLookSweepBlockLimit),
    visibleEntities: z
      .array(lookSweepEntitySchema)
      .max(playerBodyLookSweepEntityLimit),
    omittedBlockCandidates: z.number().int().nonnegative(),
    omittedEntityCandidates: z.number().int().nonnegative(),
    candidateSearchMayBeTruncated: z.boolean(),
  })
  .strict();

export const playerBodyLookSweepSchema = z
  .object({
    current: lookSweepViewSchema,
    directions: z
      .array(
        lookSweepViewSchema.omit({ directionIndex: true }).extend({
          directionIndex: z
            .number()
            .int()
            .min(0)
            .max(playerBodyLookSweepDirectionCount - 1),
        }),
      )
      .max(playerBodyLookSweepDirectionCount),
    plannedDirectionCount: z.literal(playerBodyLookSweepDirectionCount),
    complete: z.boolean(),
    candidateSearchMayBeTruncated: z.boolean(),
    worldAbsenceEstablished: z.literal(false),
  })
  .strict()
  .refine(
    (sweep) =>
      !sweep.complete ||
      (sweep.directions.length === playerBodyLookSweepDirectionCount &&
        sweep.directions.every(
          (direction, index) => direction.directionIndex === index,
        )),
    "A complete look sweep must observe each planned direction once in order",
  );

type PlayerBodyLookSweepView = z.infer<typeof lookSweepViewSchema>;
export type PlayerBodyLookSweep = z.infer<typeof playerBodyLookSweepSchema>;

export function summarizeLookSweepView(
  observation: PlayerBodyObservation,
  directionIndex: number | null,
): PlayerBodyLookSweepView {
  const blocks = observation.perception.blocks;
  const entities = observation.perception.entities.filter(
    ({ isPlayer }) => !isPlayer,
  );
  const omittedBlockCandidates =
    observation.perception.omittedBlockCandidates +
    Math.max(0, blocks.length - playerBodyLookSweepBlockLimit);
  const omittedEntityCandidates =
    observation.perception.omittedEntityCandidates +
    Math.max(0, entities.length - playerBodyLookSweepEntityLimit);
  return {
    directionIndex,
    yawDegrees: normalizeDegrees(observation.self.yaw),
    pitchDegrees:
      Math.round(((observation.self.pitch * 180) / Math.PI) * 10) / 10,
    dimension: observation.dimension.slice(0, 80),
    visibleBlocks: blocks
      .slice(0, playerBodyLookSweepBlockLimit)
      .map(({ name, position, distance }) => ({
        name: name.slice(0, 80),
        position: { x: position.x, y: position.y, z: position.z },
        distance,
      })),
    visibleEntities: entities
      .slice(0, playerBodyLookSweepEntityLimit)
      .map(
        ({
          name,
          kind,
          category,
          position,
          distance,
          equipment,
          droppedItem,
        }) => ({
          name: name.slice(0, 80),
          kind: kind.slice(0, 80),
          category: category?.slice(0, 80) ?? null,
          position: { x: position.x, y: position.y, z: position.z },
          distance,
          ...(equipment === undefined ? {} : { equipment }),
          ...(droppedItem === undefined ? {} : { droppedItem }),
        }),
      ),
    omittedBlockCandidates,
    omittedEntityCandidates,
    candidateSearchMayBeTruncated:
      observation.perception.candidateSearchMayBeTruncated ||
      omittedBlockCandidates > 0 ||
      omittedEntityCandidates > 0,
  };
}

function normalizeDegrees(radians: number): number {
  const degrees = (radians * 180) / Math.PI;
  return Math.round((((((degrees + 180) % 360) + 360) % 360) - 180) * 10) / 10;
}

export interface PlayerBodyObservationOptions {
  /** Owner coordinates are returned only for an explicit owner-approach request. */
  readonly ownerPositionException?: boolean;
}

const horizontalFovDegrees = 110;
const verticalFovDegrees = 80;
const maxVisibleDistance = 16;
const blockCandidateLimit = 192;
const blockCandidateSearchPassLimit = 3;
const nearbyDoorCandidateLimit = 8;
const nearbyDoorInteractionRange = 4.5;
const entityCandidateLimit = 128;
const blockOutputLimit = 96;
const entityOutputLimit = 64;
const nearbyHostileCandidateLimit = 128;
const nearbyHostileOutputLimit = 16;
const nearbyHostileKindSummaryLimit = 32;
const placementCandidateLimit = 24;
const placementInteractionRange = 4.5;
const airBlockNames = new Set(["air", "cave_air", "void_air"]);

const nearbyHostileDirections = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
  "coincident",
] as const satisfies readonly BodyNearbyHostileDirection[];

interface MutableNearbyHostileOffsetBounds {
  count: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface MutableNearbyHostileDirectionCount {
  count: number;
  nearestDistance: number | null;
  farthestDistance: number | null;
  readonly offsets: MutableNearbyHostileOffsetBounds;
}

const placementFaces: readonly {
  readonly face: BodyPlacementFace;
  readonly normal: Vec3;
}[] = [
  { face: "up", normal: new Vec3(0, 1, 0) },
  { face: "north", normal: new Vec3(0, 0, -1) },
  { face: "south", normal: new Vec3(0, 0, 1) },
  { face: "east", normal: new Vec3(1, 0, 0) },
  { face: "west", normal: new Vec3(-1, 0, 0) },
  { face: "down", normal: new Vec3(0, -1, 0) },
];

interface EntityWithEyeHeight extends Entity {
  readonly eyeHeight?: number;
}

interface EntityWithOptionalVehicle extends Omit<Entity, "vehicle"> {
  readonly vehicle?: Entity | null;
}

const positionOf = (position: Vec3, dimension: string): BodyPosition => ({
  x: position.x,
  y: position.y,
  z: position.z,
  dimension,
});

export function entityEyeHeight(entity: Entity): number {
  const eyeHeight = (entity as EntityWithEyeHeight).eyeHeight;
  return typeof eyeHeight === "number" && Number.isFinite(eyeHeight)
    ? eyeHeight
    : Math.max(1.2, entity.height * 0.9);
}

function eyePosition(bot: Bot): Vec3 {
  return bot.entity.position.offset(0, entityEyeHeight(bot.entity), 0);
}

function insideViewCone(bot: Bot, point: Vec3): boolean {
  const eye = eyePosition(bot);
  const offset = point.minus(eye);
  const distance = offset.norm();
  if (distance === 0 || distance > maxVisibleDistance) return distance === 0;
  const horizontalDistance = Math.hypot(offset.x, offset.z);
  if (horizontalDistance < 1e-6) {
    const targetPitch = Math.sign(offset.y) * (Math.PI / 2);
    return (
      Math.abs(((targetPitch - bot.entity.pitch) * 180) / Math.PI) <=
      verticalFovDegrees / 2
    );
  }
  const targetYaw = Math.atan2(-offset.x, -offset.z);
  const yawDelta = Math.atan2(
    Math.sin(targetYaw - bot.entity.yaw),
    Math.cos(targetYaw - bot.entity.yaw),
  );
  const targetPitch = Math.atan2(offset.y, horizontalDistance);
  return (
    Math.abs((yawDelta * 180) / Math.PI) <= horizontalFovDegrees / 2 &&
    Math.abs(((targetPitch - bot.entity.pitch) * 180) / Math.PI) <=
      verticalFovDegrees / 2
  );
}

function unoccludedToEntity(bot: Bot, entity: Entity): boolean {
  const eye = eyePosition(bot);
  const target = entity.position.offset(
    0,
    Math.max(0.1, entity.height * 0.55),
    0,
  );
  const offset = target.minus(eye);
  const distance = offset.norm();
  if (distance === 0) return true;
  const blocker = bot.world.raycast(
    eye,
    offset.scaled(1 / distance),
    Math.max(0, distance - 0.15),
    (block) => block.boundingBox === "block",
  );
  return blocker === null;
}

function itemStack(
  item: Item | null | undefined,
  slot: number,
): BodyItemStack | null {
  if (item == null) return null;
  const pages = bookPages(item);
  return {
    slot,
    itemId: item.type,
    name: item.name,
    count: item.count,
    metadata: item.metadata,
    durability:
      typeof item.durabilityUsed === "number" &&
      typeof item.maxDurability === "number"
        ? item.maxDurability - item.durabilityUsed
        : null,
    maxDurability:
      typeof item.maxDurability === "number" ? item.maxDurability : null,
    customName: item.customName,
    ...(pages === null ? {} : { bookPages: pages }),
    enchantments: item.enchants.map((enchantment) => ({
      name: enchantment.name,
      level: enchantment.lvl,
    })),
  };
}

function bookPages(item: Item): readonly string[] | null {
  const root = item.nbt as {
    readonly value?: { readonly pages?: unknown; readonly Pages?: unknown };
  } | null;
  const tag = root?.value?.pages ?? root?.value?.Pages;
  if (typeof tag !== "object" || tag === null) return null;
  const tagValue = (tag as { readonly value?: unknown }).value;
  if (typeof tagValue !== "object" || tagValue === null) return null;
  const payload = (tagValue as { readonly value?: unknown }).value;
  if (
    Array.isArray(payload) &&
    payload.every((page) => typeof page === "string")
  )
    return payload;
  if (typeof payload === "string") return [payload];
  return null;
}

function windowSnapshot(window: Window | null): BodyWindowSnapshot | null {
  if (window === null) return null;
  return {
    id: window.id,
    type: String(window.type),
    title: window.title,
    inventoryStart: window.inventoryStart,
    inventoryEnd: window.inventoryEnd,
    selectedItem: itemStack(window.selectedItem, -1),
    slots: window.slots.map((item, index) => itemStack(item, index)),
  };
}

function entityName(entity: Entity): string {
  return entity.name ?? entity.displayName ?? entity.type;
}

function visibleEntityEquipment(
  entity: Entity,
): BodyVisibleEntityEquipment | undefined {
  const rawEquipment = (entity as unknown as { readonly equipment?: unknown })
    .equipment;
  if (!Array.isArray(rawEquipment)) return undefined;
  const slots = rawEquipment as readonly (Item | null | undefined)[];

  // prismarine-entity uses the 1.9+ order for current supported protocols.
  const slotNames = [
    "mainHand",
    "offHand",
    "feet",
    "legs",
    "torso",
    "head",
  ] as const;
  const equipment: Partial<Record<(typeof slotNames)[number], string | null>> =
    {};
  slotNames.forEach((name, index) => {
    const item = slots[index];
    if (item === undefined) return;
    if (item === null) {
      equipment[name] = null;
      return;
    }
    if (typeof item.name === "string" && item.name.length > 0)
      equipment[name] = item.name.slice(0, 80);
  });

  return Object.keys(equipment).length === 0 ? undefined : equipment;
}

function visibleDroppedItem(
  bot: Bot,
  entity: Entity,
): BodyVisibleDroppedItem | undefined {
  let item: Item | null;
  try {
    item = entity.getDroppedItem();
  } catch {
    return undefined;
  }
  if (
    item === null ||
    typeof item.name !== "string" ||
    item.name.length === 0 ||
    item.name.length > 80 ||
    bot.registry.itemsByName[item.name] === undefined ||
    !Number.isInteger(item.count) ||
    item.count < 1 ||
    item.count > 127
  )
    return undefined;
  return { name: item.name, count: item.count };
}

function entityHealth(entity: Entity): number | null {
  return typeof entity.health === "number" && Number.isFinite(entity.health)
    ? entity.health
    : null;
}

function bodyVisibleEntity(
  bot: Bot,
  entity: Entity,
  distance: number,
  dimension: string,
): BodyVisibleEntity {
  const name = entityName(entity);
  const equipment = visibleEntityEquipment(entity);
  const droppedItem = visibleDroppedItem(bot, entity);
  return {
    id: entity.id,
    name,
    kind: entity.type,
    category: bot.registry.entitiesByName[name]?.category ?? null,
    position: positionOf(entity.position, dimension),
    distance,
    health: entityHealth(entity),
    isPlayer: entity.username !== undefined,
    ...(entity.username === undefined ? {} : { username: entity.username }),
    ...(equipment === undefined ? {} : { equipment }),
    ...(droppedItem === undefined ? {} : { droppedItem }),
  };
}

function createNearbyHostileOffsetBounds(): MutableNearbyHostileOffsetBounds {
  return {
    count: 0,
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
}

function includeNearbyHostileOffset(
  bounds: MutableNearbyHostileOffsetBounds,
  x: number,
  y: number,
  z: number,
): void {
  bounds.count += 1;
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

function nearbyHostileOffsetBounds(
  bounds: MutableNearbyHostileOffsetBounds,
): BodyNearbyHostileOffsetBounds | null {
  if (bounds.count === 0) return null;
  return {
    min: { x: bounds.minX, y: bounds.minY, z: bounds.minZ },
    max: { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ },
  };
}

function nearbyHostileDirection(
  offsetX: number,
  offsetZ: number,
): BodyNearbyHostileDirection {
  if (offsetX === 0 && offsetZ === 0) return "coincident";
  const sector =
    (Math.round(Math.atan2(offsetX, -offsetZ) / (Math.PI / 4)) + 8) % 8;
  return nearbyHostileDirections[sector] ?? "coincident";
}

function safeHostileKindName(entity: Entity): string {
  const name = entityName(entity);
  return /^[a-z0-9_:-]{1,80}$/u.test(name) ? name : "unknown_hostile";
}

function compareEntityNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function summarizeNearbyHostiles(input: {
  readonly candidates: readonly {
    readonly entity: Entity;
    readonly distance: number;
  }[];
  readonly selfPosition: Vec3;
  readonly maxDistance: number;
  readonly candidateLimit: number;
  readonly candidatesChecked: number;
  readonly unoccludedCandidates: number;
  readonly detailOutputLimit: number;
}): PlayerBodyNearbyHostileAggregate {
  const { candidates, selfPosition } = input;
  const kindCounts = new Map<string, number>();
  const overallOffsets = createNearbyHostileOffsetBounds();
  const directionCounts = new Map<
    BodyNearbyHostileDirection,
    MutableNearbyHostileDirectionCount
  >(
    nearbyHostileDirections.map((direction) => [
      direction,
      {
        count: 0,
        nearestDistance: null,
        farthestDistance: null,
        offsets: createNearbyHostileOffsetBounds(),
      },
    ]),
  );

  for (const { entity, distance } of candidates) {
    const offsetX = entity.position.x - selfPosition.x;
    const offsetY = entity.position.y - selfPosition.y;
    const offsetZ = entity.position.z - selfPosition.z;
    includeNearbyHostileOffset(overallOffsets, offsetX, offsetY, offsetZ);
    const direction = directionCounts.get(
      nearbyHostileDirection(offsetX, offsetZ),
    );
    if (direction !== undefined) {
      direction.count += 1;
      direction.nearestDistance =
        direction.nearestDistance === null
          ? distance
          : Math.min(direction.nearestDistance, distance);
      direction.farthestDistance =
        direction.farthestDistance === null
          ? distance
          : Math.max(direction.farthestDistance, distance);
      includeNearbyHostileOffset(direction.offsets, offsetX, offsetY, offsetZ);
    }
    const name = safeHostileKindName(entity);
    kindCounts.set(name, (kindCounts.get(name) ?? 0) + 1);
  }

  const orderedKinds = [...kindCounts.entries()].sort(
    ([leftName, leftCount], [rightName, rightCount]) =>
      rightCount - leftCount || compareEntityNames(leftName, rightName),
  );
  const includedKinds = orderedKinds.slice(0, nearbyHostileKindSummaryLimit);
  const omittedKinds = orderedKinds.slice(nearbyHostileKindSummaryLimit);
  const checkedCandidates = Math.min(
    candidates.length,
    input.candidatesChecked,
  );
  const unoccludedCandidates = Math.min(
    checkedCandidates,
    input.unoccludedCandidates,
  );

  return {
    source: "client_received_hostile_entity_candidates",
    countScope: "client_entity_table_within_max_distance",
    maxDistance: input.maxDistance,
    clientReceivedHostileCount: candidates.length,
    worldAbsenceEstablished: false,
    directionFrame: "minecraft_cardinal_from_self_position",
    relativeOffsetFrame: "entity_position_minus_self_position",
    relativeOffsetBounds: nearbyHostileOffsetBounds(overallOffsets),
    byKind: includedKinds.map(([name, count]) => ({ name, count })),
    omittedKindGroupCount: omittedKinds.length,
    omittedKindEntityCount: omittedKinds.reduce(
      (total, [, count]) => total + count,
      0,
    ),
    byDirection: nearbyHostileDirections.map((directionName) => {
      const direction = directionCounts.get(directionName);
      return {
        direction: directionName,
        count: direction?.count ?? 0,
        nearestDistance: direction?.nearestDistance ?? null,
        farthestDistance: direction?.farthestDistance ?? null,
        relativeOffsetBounds:
          direction === undefined
            ? null
            : nearbyHostileOffsetBounds(direction.offsets),
      };
    }),
    occlusionCheck: {
      method: "raycast_entity_body_point",
      candidateLimit: input.candidateLimit,
      candidatesChecked: checkedCandidates,
      unoccludedCandidates,
      occludedCandidates: checkedCandidates - unoccludedCandidates,
      uncheckedCandidates: candidates.length - checkedCandidates,
      detailOutputLimit: input.detailOutputLimit,
      omittedUnoccludedDetails: Math.max(
        0,
        unoccludedCandidates - input.detailOutputLimit,
      ),
    },
  };
}

function blockPositionKey(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function raycastHitPosition(hit: unknown): Vec3 | null {
  if (typeof hit !== "object" || hit === null) return null;
  const result = hit as {
    readonly position?: unknown;
    readonly x?: unknown;
    readonly y?: unknown;
    readonly z?: unknown;
  };
  const position = result.position;
  if (typeof position === "object" && position !== null) {
    const point = position as {
      readonly x?: unknown;
      readonly y?: unknown;
      readonly z?: unknown;
    };
    if (
      typeof point.x === "number" &&
      Number.isFinite(point.x) &&
      typeof point.y === "number" &&
      Number.isFinite(point.y) &&
      typeof point.z === "number" &&
      Number.isFinite(point.z)
    )
      return new Vec3(point.x, point.y, point.z);
  }
  if (
    typeof result.x === "number" &&
    Number.isFinite(result.x) &&
    typeof result.y === "number" &&
    Number.isFinite(result.y) &&
    typeof result.z === "number" &&
    Number.isFinite(result.z)
  )
    return new Vec3(result.x, result.y, result.z);
  return null;
}

function crosshairBlockPosition(bot: Bot, origin: Vec3): Vec3 | null {
  const { yaw, pitch } = bot.entity;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  const direction = new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
  const directionLength = direction.norm();
  if (!Number.isFinite(directionLength) || directionLength === 0) return null;

  const hit = bot.world.raycast(
    eyePosition(bot),
    direction.scaled(1 / directionLength),
    maxVisibleDistance,
  );
  const hitPosition = raycastHitPosition(hit);
  if (hitPosition === null) return null;
  const block = bot.blockAt(hitPosition);
  if (
    block === null ||
    ["air", "cave_air", "void_air"].includes(block.name) ||
    block.boundingBox !== "block"
  )
    return null;
  const target = block.position.offset(0.5, 0.5, 0.5);
  if (
    origin.distanceTo(target) > maxVisibleDistance ||
    !insideViewCone(bot, target)
  )
    return null;
  return block.position;
}

function visibleBlockCandidates(
  bot: Bot,
  origin: Vec3,
  dimension: string,
): {
  blocks: BodyVisibleBlock[];
  mayBeTruncated: boolean;
  priorityPositionKeys: readonly string[];
} {
  const excludedNames = new Set<string>();
  const seenPositions = new Set<string>();
  const candidates: Vec3[] = [];
  const priorityPositionKeys: string[] = [];
  const priorityPosition = crosshairBlockPosition(bot, origin);
  const priorityPositionKey =
    priorityPosition === null ? undefined : blockPositionKey(priorityPosition);
  if (priorityPosition !== null) {
    seenPositions.add(blockPositionKey(priorityPosition));
    candidates.push(priorityPosition);
    priorityPositionKeys.push(blockPositionKey(priorityPosition));
  }
  let mayBeTruncated = false;

  const nearbyDoorPositions = bot.findBlocks({
    matching: (block) => isHandOperableDoor(block.name),
    maxDistance: nearbyDoorInteractionRange,
    count: nearbyDoorCandidateLimit,
  });
  if (nearbyDoorPositions.length >= nearbyDoorCandidateLimit)
    mayBeTruncated = true;
  for (const position of nearbyDoorPositions) {
    const block = bot.blockAt(position);
    if (block === null || !isHandOperableDoor(block.name)) continue;
    const key = blockPositionKey(block.position);
    if (seenPositions.has(key)) continue;
    seenPositions.add(key);
    candidates.push(position);
    priorityPositionKeys.push(key);
  }

  for (let pass = 0; pass < blockCandidateSearchPassLimit; pass += 1) {
    const searchResults = bot.findBlocks({
      matching: (block) =>
        !["air", "cave_air", "void_air"].includes(block.name) &&
        !excludedNames.has(block.name),
      maxDistance: maxVisibleDistance,
      count: blockCandidateLimit,
    });
    if (searchResults.length >= blockCandidateLimit) mayBeTruncated = true;

    const nameCounts = new Map<string, number>();
    for (const candidate of searchResults) {
      const block = bot.blockAt(candidate);
      if (block === null) continue;
      const key = blockPositionKey(block.position);
      if (seenPositions.has(key)) continue;
      seenPositions.add(key);
      candidates.push(candidate);
      nameCounts.set(block.name, (nameCounts.get(block.name) ?? 0) + 1);
    }

    if (searchResults.length < blockCandidateLimit) break;

    if (nameCounts.size === 0) break;
    // Every name in this saturated batch already has sampled candidates.
    // Search the remaining kinds before using another bounded pass.
    for (const name of nameCounts.keys()) excludedNames.add(name);
  }

  const blocks: BodyVisibleBlock[] = [];
  for (const candidate of candidates) {
    const block = bot.blockAt(candidate);
    if (block === null) continue;
    const target = block.position.offset(0.5, 0.5, 0.5);
    const distance = origin.distanceTo(target);
    const isPriority = blockPositionKey(block.position) === priorityPositionKey;
    if (
      distance > maxVisibleDistance ||
      !insideViewCone(bot, target) ||
      (isPriority
        ? block.boundingBox !== "block" ||
          ["air", "cave_air", "void_air"].includes(block.name)
        : !bot.canSeeBlock(block))
    )
      continue;
    const signText = block.name.endsWith("sign")
      ? block.getSignText()
      : undefined;
    blocks.push({
      name: block.name,
      stateId: block.stateId,
      position: positionOf(block.position, dimension),
      distance,
      properties: { ...block.getProperties() },
      ...(signText === undefined
        ? {}
        : {
            signText:
              signText[1] === undefined
                ? [signText[0]]
                : [signText[0], signText[1]],
          }),
    });
  }

  blocks.sort((left, right) => left.distance - right.distance);
  return { blocks, mayBeTruncated, priorityPositionKeys };
}

function balancedVisibleBlocks(
  blocks: readonly BodyVisibleBlock[],
  limit: number,
  priorityPositionKeys: readonly string[] = [],
): BodyVisibleBlock[] {
  if (limit <= 0) return [];
  const blocksByPosition = new Map(
    blocks.map((block) => [blockPositionKey(block.position), block]),
  );
  const priorityBlocks: BodyVisibleBlock[] = [];
  const priorityKeys = new Set<string>();
  for (const key of priorityPositionKeys) {
    const block = blocksByPosition.get(key);
    if (block === undefined || priorityKeys.has(key)) continue;
    priorityBlocks.push(block);
    priorityKeys.add(key);
    if (priorityBlocks.length === limit) break;
  }
  const remainingBlocks = blocks.filter(
    (block) => !priorityKeys.has(blockPositionKey(block.position)),
  );
  const blocksByName = new Map<string, BodyVisibleBlock[]>();
  for (const block of remainingBlocks) {
    const sameName = blocksByName.get(block.name) ?? [];
    sameName.push(block);
    blocksByName.set(block.name, sameName);
  }
  const groups = [...blocksByName.values()].sort((left, right) => {
    const leftFirst = left[0];
    const rightFirst = right[0];
    if (leftFirst === undefined) return rightFirst === undefined ? 0 : 1;
    if (rightFirst === undefined) return -1;
    return (
      leftFirst.distance - rightFirst.distance ||
      leftFirst.name.localeCompare(rightFirst.name)
    );
  });
  const selected = [...priorityBlocks];
  for (let index = 0; selected.length < limit; index += 1) {
    let found = false;
    for (const group of groups) {
      const block = group[index];
      if (block === undefined) continue;
      selected.push(block);
      found = true;
      if (selected.length === limit) break;
    }
    if (!found) break;
  }
  return selected.sort((left, right) => left.distance - right.distance);
}

function placementCandidates(
  bot: Bot,
  dimension: string,
  supports: readonly BodyVisibleBlock[],
  searchMayBeTruncated: boolean,
): {
  readonly candidates: readonly BodyPlacementCandidate[];
  readonly omitted: number;
  readonly mayBeTruncated: boolean;
} {
  const eye = eyePosition(bot);
  const candidatesByPosition = new Map<
    string,
    {
      candidate: BodyPlacementCandidate;
      alignment: number;
      supportDistance: number;
    }
  >();
  const forward = new Vec3(
    -Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch),
    Math.sin(bot.entity.pitch),
    -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch),
  );

  for (const support of supports) {
    if (support.position.dimension !== dimension) continue;
    const supportPosition = new Vec3(
      support.position.x,
      support.position.y,
      support.position.z,
    ).floored();
    const supportCenter = supportPosition.offset(0.5, 0.5, 0.5);
    const supportDistance = eye.distanceTo(supportCenter);
    if (supportDistance > placementInteractionRange) continue;
    const supportBlock = bot.blockAt(supportPosition);
    if (
      supportBlock?.name !== support.name ||
      supportBlock.boundingBox !== "block" ||
      !bot.canSeeBlock(supportBlock)
    )
      continue;

    for (const { face, normal } of placementFaces) {
      const targetPosition = supportPosition.plus(normal);
      const targetBlock = bot.blockAt(targetPosition);
      if (
        targetBlock === null ||
        !airBlockNames.has(targetBlock.name) ||
        targetBlock.boundingBox !== "empty"
      )
        continue;

      const targetCenter = targetPosition.offset(0.5, 0.5, 0.5);
      const targetOffset = targetCenter.minus(eye);
      const targetDistance = targetOffset.norm();
      if (
        targetDistance === 0 ||
        targetDistance > placementInteractionRange ||
        !insideViewCone(bot, targetCenter)
      )
        continue;

      const rayDistance = Math.max(0, targetDistance - 0.05);
      if (rayDistance > 0) {
        const blocker = bot.world.raycast(
          eye,
          targetOffset.scaled(1 / targetDistance),
          rayDistance,
        );
        if (blocker !== null) continue;
      }

      const alignment = targetOffset.scaled(1 / targetDistance).dot(forward);
      const key = blockPositionKey(targetPosition);
      const current = candidatesByPosition.get(key);
      const candidate: BodyPlacementCandidate = {
        position: {
          x: targetPosition.x,
          y: targetPosition.y,
          z: targetPosition.z,
        },
        supportingBlock: {
          name: support.name,
          position: {
            x: supportPosition.x,
            y: supportPosition.y,
            z: supportPosition.z,
          },
        },
        distance: targetDistance,
        face,
      };
      if (current === undefined || supportDistance < current.supportDistance) {
        candidatesByPosition.set(key, {
          candidate,
          alignment,
          supportDistance,
        });
      }
    }
  }

  const ranked = [...candidatesByPosition.values()].sort(
    (left, right) =>
      right.alignment - left.alignment ||
      left.candidate.distance - right.candidate.distance ||
      left.candidate.position.x - right.candidate.position.x ||
      left.candidate.position.y - right.candidate.position.y ||
      left.candidate.position.z - right.candidate.position.z,
  );
  const candidates = ranked
    .slice(0, placementCandidateLimit)
    .map(({ candidate }) => candidate);
  const omitted = Math.max(0, ranked.length - candidates.length);
  return {
    candidates,
    omitted,
    mayBeTruncated: searchMayBeTruncated || omitted > 0,
  };
}

export function observePlayerBody(
  bot: Bot,
  ownerUsername: string | undefined,
  options: PlayerBodyObservationOptions = {},
  authoritativeOxygen: number | null = null,
): PlayerBodyObservation {
  const observedAt = new Date().toISOString();
  const dimension = bot.game.dimension;
  const origin = bot.entity.position;
  const blockObservation = visibleBlockCandidates(bot, origin, dimension);
  const visibleBlocks = blockObservation.blocks;
  const placementObservation = placementCandidates(
    bot,
    dimension,
    visibleBlocks,
    blockObservation.mayBeTruncated,
  );

  const entityCandidates = Object.values(bot.entities)
    .filter((entity) => entity.id !== bot.entity.id)
    .map((entity) => ({ entity, distance: origin.distanceTo(entity.position) }))
    .filter(({ distance }) => distance <= maxVisibleDistance)
    .sort((left, right) => left.distance - right.distance);
  const nearbyHostileCandidates = entityCandidates.filter(({ entity }) => {
    if (entity.type === "player" || entity.username !== undefined) return false;
    const name = entityName(entity);
    return isHostileEntity(name, entity.type, bot.registry);
  });
  const visibleEntities: BodyVisibleEntity[] = [];
  for (const { entity, distance } of entityCandidates.slice(
    0,
    entityCandidateLimit,
  )) {
    const target = entity.position.offset(
      0,
      Math.max(0.1, entity.height * 0.55),
      0,
    );
    if (!insideViewCone(bot, target) || !unoccludedToEntity(bot, entity))
      continue;
    visibleEntities.push(bodyVisibleEntity(bot, entity, distance, dimension));
  }

  const nearbyHostileCandidatesToCheck = nearbyHostileCandidates.slice(
    0,
    nearbyHostileCandidateLimit,
  );
  const unoccludedNearbyHostiles: BodyVisibleEntity[] = [];
  for (const { entity, distance } of nearbyHostileCandidatesToCheck) {
    if (!unoccludedToEntity(bot, entity)) continue;
    unoccludedNearbyHostiles.push(
      bodyVisibleEntity(bot, entity, distance, dimension),
    );
  }
  const nearbyHostiles: PlayerBodyNearbyHostiles = {
    source: "client_received_unoccluded_nearby_hostiles",
    observedAt,
    maxDistance: maxVisibleDistance,
    entityOutputLimit: nearbyHostileOutputLimit,
    omittedEntityCandidates: Math.max(
      0,
      unoccludedNearbyHostiles.length - nearbyHostileOutputLimit,
    ),
    candidateSearchMayBeTruncated:
      nearbyHostileCandidates.length > nearbyHostileCandidateLimit,
    entities: unoccludedNearbyHostiles.slice(0, nearbyHostileOutputLimit),
    aggregate: summarizeNearbyHostiles({
      candidates: nearbyHostileCandidates,
      selfPosition: origin,
      maxDistance: maxVisibleDistance,
      candidateLimit: nearbyHostileCandidateLimit,
      candidatesChecked: nearbyHostileCandidatesToCheck.length,
      unoccludedCandidates: unoccludedNearbyHostiles.length,
      detailOutputLimit: nearbyHostileOutputLimit,
    }),
  };

  const inventory: BodyItemStack[] = bot.inventory.slots.flatMap(
    (item, slot) => {
      const stack = itemStack(item, slot);
      return stack === null ? [] : [stack];
    },
  );
  const destinations = [
    "hand",
    "off-hand",
    "head",
    "torso",
    "legs",
    "feet",
  ] as const;
  const equipment = Object.fromEntries(
    destinations.map((destination) => {
      const slot = bot.getEquipmentDestSlot(destination);
      return [destination, itemStack(bot.inventory.slots[slot], slot)];
    }),
  );
  const feet = bot.blockAt(origin);
  const head = bot.blockAt(origin.offset(0, 1, 0));
  const physics = bot.entity as typeof bot.entity & {
    readonly isInWater?: boolean;
    readonly isInLava?: boolean;
    readonly onFire?: boolean;
  };
  const inWater =
    physics.isInWater ?? (feet === null ? null : feet.name === "water");
  const requestedOwner =
    options.ownerPositionException === true ? ownerUsername : undefined;
  const owner =
    requestedOwner === undefined
      ? undefined
      : Object.entries(bot.players).find(([username]) =>
          sameMinecraftIdentity(username, requestedOwner),
        )?.[1].entity;
  const ownerCurrentlyVisible =
    owner !== undefined &&
    insideViewCone(bot, owner.position.offset(0, owner.height * 0.55, 0)) &&
    unoccludedToEntity(bot, owner);
  const ownerPositionException =
    owner !== undefined && requestedOwner !== undefined
      ? {
          username: requestedOwner,
          position: positionOf(owner.position, dimension),
          source: "owner_position_exception" as const,
          currentlyVisible: ownerCurrentlyVisible,
        }
      : undefined;

  return {
    observedAt,
    source: "minecraft",
    gameVersion: bot.version,
    dimension,
    time: {
      day: Number.isFinite(bot.time.day) ? bot.time.day : null,
      timeOfDay: Number.isFinite(bot.time.timeOfDay)
        ? bot.time.timeOfDay
        : null,
      isDay: typeof bot.time.isDay === "boolean" ? bot.time.isDay : null,
      raining: typeof bot.isRaining === "boolean" ? bot.isRaining : null,
    },
    self: {
      username: bot.username,
      position: positionOf(origin, dimension),
      eyeHeight: entityEyeHeight(bot.entity),
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      velocity: {
        x: bot.entity.velocity.x,
        y: bot.entity.velocity.y,
        z: bot.entity.velocity.z,
      },
      health: Number.isFinite(bot.health) ? bot.health : null,
      food: Number.isFinite(bot.food) ? bot.food : null,
      foodSaturation: Number.isFinite(bot.foodSaturation)
        ? bot.foodSaturation
        : null,
      oxygen:
        typeof authoritativeOxygen === "number" &&
        Number.isFinite(authoritativeOxygen)
          ? authoritativeOxygen
          : null,
      inWater,
      inLava: physics.isInLava ?? (feet === null ? null : feet.name === "lava"),
      onFire: physics.onFire ?? null,
      suffocating:
        head === null
          ? null
          : !["air", "cave_air", "void_air", "water", "lava"].includes(
              head.name,
            ) && head.boundingBox === "block",
      sleeping: bot.isSleeping,
      mountedEntityId:
        (bot.entity as EntityWithOptionalVehicle).vehicle?.id ?? null,
      gameMode:
        typeof bot.game.gameMode === "string" ? bot.game.gameMode : null,
      experience: {
        level: bot.experience.level,
        points: bot.experience.points,
        progress: bot.experience.progress,
      },
      inventory,
      equipment,
    },
    perception: {
      horizontalFieldOfViewDegrees: horizontalFovDegrees,
      verticalFieldOfViewDegrees: verticalFovDegrees,
      maxDistance: maxVisibleDistance,
      coverage: "visible_subset",
      blockCountLimit: blockOutputLimit,
      entityCountLimit: entityOutputLimit,
      blockCandidateLimit,
      entityCandidateLimit,
      omittedBlockCandidates: Math.max(
        0,
        visibleBlocks.length - blockOutputLimit,
      ),
      omittedEntityCandidates: Math.max(
        0,
        visibleEntities.length - entityOutputLimit,
      ),
      candidateSearchMayBeTruncated:
        blockObservation.mayBeTruncated ||
        entityCandidates.length > entityCandidateLimit,
      blocks: balancedVisibleBlocks(
        visibleBlocks,
        blockOutputLimit,
        blockObservation.priorityPositionKeys,
      ),
      placementCandidateLimit,
      omittedPlacementCandidates: placementObservation.omitted,
      placementCandidatesMayBeTruncated: placementObservation.mayBeTruncated,
      placementCandidates: placementObservation.candidates,
      entities: visibleEntities.slice(0, entityOutputLimit),
      nearbyHostiles,
      ...(ownerPositionException === undefined
        ? {}
        : { ownerPositionException }),
    },
    window: windowSnapshot(bot.currentWindow),
  };
}

export const playerBodyFieldOfView = {
  horizontalDegrees: horizontalFovDegrees,
  verticalDegrees: verticalFovDegrees,
  maxDistance: maxVisibleDistance,
} as const;
