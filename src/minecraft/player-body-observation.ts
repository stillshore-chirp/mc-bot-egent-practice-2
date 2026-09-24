import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Window } from "prismarine-windows";
import { Vec3 } from "vec3";

export interface BodyPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
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
    readonly entities: readonly BodyVisibleEntity[];
    readonly ownerPositionException?: {
      readonly username: string;
      readonly position: BodyPosition;
      readonly source: "owner_position_exception";
      readonly currentlyVisible: boolean;
    };
  };
  readonly window: BodyWindowSnapshot | null;
}

export interface PlayerBodyObservationOptions {
  /** Owner coordinates are returned only for an explicit owner-approach request. */
  readonly ownerPositionException?: boolean;
}

const horizontalFovDegrees = 110;
const verticalFovDegrees = 80;
const maxVisibleDistance = 16;
const blockCandidateLimit = 192;
const entityCandidateLimit = 128;
const blockOutputLimit = 96;
const entityOutputLimit = 64;

const positionOf = (position: Vec3, dimension: string): BodyPosition => ({
  x: position.x,
  y: position.y,
  z: position.z,
  dimension,
});

function eyePosition(bot: Bot): Vec3 {
  return bot.entity.position.offset(
    0,
    bot.entity.eyeHeight ?? Math.max(1.2, bot.entity.height * 0.9),
    0,
  );
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
    enchantments: (item.enchants ?? []).map((enchantment) => ({
      name: String(enchantment.name ?? enchantment.id),
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
    type: window.type,
    title: String(window.title),
    inventoryStart: window.inventoryStart,
    inventoryEnd: window.inventoryEnd,
    selectedItem: itemStack(window.selectedItem, -1),
    slots: window.slots.map((item, index) => itemStack(item, index)),
  };
}

function entityName(entity: Entity): string {
  return entity.name ?? entity.displayName ?? entity.type;
}

function entityHealth(entity: Entity): number | null {
  return typeof entity.health === "number" && Number.isFinite(entity.health)
    ? entity.health
    : null;
}

export function observePlayerBody(
  bot: Bot,
  ownerUsername: string | undefined,
  options: PlayerBodyObservationOptions = {},
): PlayerBodyObservation {
  const observedAt = new Date().toISOString();
  const dimension = bot.game.dimension;
  const origin = bot.entity.position;
  const blockCandidates = bot.findBlocks({
    matching: (block) => !["air", "cave_air", "void_air"].includes(block.name),
    maxDistance: maxVisibleDistance,
    count: blockCandidateLimit,
  });
  const visibleBlocks: BodyVisibleBlock[] = [];
  for (const candidate of blockCandidates) {
    const block = bot.blockAt(candidate);
    if (block === null) continue;
    const target = block.position.offset(0.5, 0.5, 0.5);
    const distance = origin.distanceTo(target);
    if (
      distance > maxVisibleDistance ||
      !insideViewCone(bot, target) ||
      !bot.canSeeBlock(block)
    )
      continue;
    visibleBlocks.push({
      name: block.name,
      stateId: block.stateId,
      position: positionOf(block.position, dimension),
      distance,
      properties: { ...(block.getProperties() ?? {}) },
      ...(block.name.endsWith("sign") ? { signText: block.getSignText() } : {}),
    });
  }
  visibleBlocks.sort((left, right) => left.distance - right.distance);

  const entityCandidates = Object.values(bot.entities)
    .filter((entity) => entity.id !== bot.entity.id)
    .map((entity) => ({ entity, distance: origin.distanceTo(entity.position) }))
    .filter(({ distance }) => distance <= maxVisibleDistance)
    .sort((left, right) => left.distance - right.distance);
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
    const name = entityName(entity);
    const category = bot.registry.entitiesByName[name]?.category ?? null;
    visibleEntities.push({
      id: entity.id,
      name,
      kind: entity.type,
      category,
      position: positionOf(entity.position, dimension),
      distance,
      health: entityHealth(entity),
      isPlayer: entity.username !== undefined,
      ...(entity.username === undefined ? {} : { username: entity.username }),
    });
  }

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
  const owner =
    options.ownerPositionException === true && ownerUsername !== undefined
      ? bot.players[ownerUsername]?.entity
      : undefined;
  const ownerCurrentlyVisible =
    owner !== undefined &&
    insideViewCone(bot, owner.position.offset(0, owner.height * 0.55, 0)) &&
    unoccludedToEntity(bot, owner);
  const ownerPositionException =
    owner !== undefined
      ? {
          username: ownerUsername as string,
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
      eyeHeight: bot.entity.eyeHeight ?? Math.max(1.2, bot.entity.height * 0.9),
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
      oxygen: Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : null,
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
        (bot.entity as typeof bot.entity & { readonly vehicle?: Entity })
          .vehicle?.id ?? null,
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
        blockCandidates.length >= blockCandidateLimit ||
        entityCandidates.length > entityCandidateLimit,
      blocks: visibleBlocks.slice(0, blockOutputLimit),
      entities: visibleEntities.slice(0, entityOutputLimit),
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
