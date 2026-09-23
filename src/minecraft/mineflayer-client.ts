import mineflayer, { type Bot, type BotOptions } from "mineflayer";
import pathfinderPackage, {
  Movements,
  pathfinder,
} from "mineflayer-pathfinder";
import type { goals as PathfinderGoals } from "mineflayer-pathfinder";
import type { Move } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { AppError } from "../domain/errors.js";
import { sameMinecraftIdentity } from "../domain/minecraft-identity.js";
import { recommendArmor } from "../decision/armor-equipment.js";
import {
  ExpectedDescentDamage,
  type PlannedLanding,
} from "../decision/expected-descent-damage.js";
import { isHostileEntity } from "../decision/hostile-classification.js";
import {
  assessDescentRoute,
  safeDescentLimits,
  type DescentBlockReason,
} from "../decision/safe-descent.js";
import {
  distance,
  oxygenObservationState,
  type ArmorEquipment,
  type ArmorSlot,
  type EntityObservation,
  type Position,
  type SurroundingsObservation,
  type WorldSnapshot,
} from "../domain/snapshot.js";
import { throwIfAborted } from "../runtime/cancellation.js";
import { delay, withTimeout } from "../runtime/timeout.js";
import { buildGroundNames } from "./port.js";
import {
  isHandOperableDoor,
  NavigationMovements,
} from "./navigation-movements.js";
import type {
  ArmorEquipResult,
  BuildBlockObservation,
  EscapeMode,
  MinecraftLogger,
  MinecraftPort,
  ResourceTarget,
  SafeMoveResult,
} from "./port.js";
import {
  actionGuardChannel,
  queryActionGuard,
  requireActionPermission,
} from "./action-guard.js";
import type {
  CollectItemInput,
  CraftItemInput,
  FurnaceSlotState,
  GeneralActionCandidate,
  GeneralActionObservationInput,
  MineBlockInput,
  PlaceBlockInput,
  SmeltItemInput,
} from "./general-actions.js";
import {
  craftRunsForOutput,
  furnaceBatchReadiness,
  goalMetadataForBlock,
  goalMetadataForOutput,
  knownBlockDrops,
  selectBalancedActionCandidates,
} from "./general-actions.js";

import {
  queryTreeProtection,
  requireTreePermission,
  treeProtectionChannel,
} from "./tree-protection.js";

import { queryStorageIdentity, storageChannel } from "./storage-identity.js";

import { depositIntoChest } from "./chest-deposit.js";
import type { ChestTarget } from "../memory/delivery-targets.js";
import { gatherableLogs } from "../skills/gather-logs/resource-catalog.js";

const unsafeFoods = new Set([
  "chicken",
  "chorus_fruit",
  "poisonous_potato",
  "pufferfish",
  "rotten_flesh",
  "spider_eye",
  "suspicious_stew",
]);

const { goals } = pathfinderPackage;

export interface MineflayerClientOptions {
  readonly bot: BotOptions;
  readonly ownerUsername: string;
  readonly pathfinderThinkTimeoutMs: number;
  readonly pathfinderTickTimeoutMs: number;
  readonly collectTimeoutMs: number;
}

const positionOf = (position: {
  x: number;
  y: number;
  z: number;
}): Position => ({
  x: position.x,
  y: position.y,
  z: position.z,
});

export interface EntityMetadataEntry {
  readonly key: number;
  readonly value: unknown;
}

export interface EntityMetadataPacket {
  readonly entityId: number;
  readonly metadata: readonly EntityMetadataEntry[];
}

function parseEntityMetadataPacket(
  packet: unknown,
): EntityMetadataPacket | undefined {
  if (typeof packet !== "object" || packet === null) return undefined;
  const candidate = packet as {
    readonly entityId?: unknown;
    readonly metadata?: unknown;
  };
  const entityId = candidate.entityId;
  if (
    typeof entityId !== "number" ||
    !Number.isInteger(entityId) ||
    !Array.isArray(candidate.metadata)
  )
    return undefined;
  const metadata = candidate.metadata.filter(
    (entry): entry is EntityMetadataEntry => {
      if (typeof entry !== "object" || entry === null) return false;
      const metadataEntry = entry as { readonly key?: unknown };
      return (
        typeof metadataEntry.key === "number" &&
        Number.isInteger(metadataEntry.key)
      );
    },
  );
  return { entityId, metadata };
}

/**
 * Mineflayer's named-metadata path can receive air supply for another entity
 * and overwrite bot.oxygenLevel. Only accept an air-supply field from the
 * bot's own entity packet; an invalid own value is explicitly unknown.
 */
export function oxygenFromEntityMetadata(
  packet: EntityMetadataPacket,
  botEntityId: number,
  metadataKeys: readonly string[] | undefined,
  legacyMetadata = false,
): number | null | undefined {
  if (packet.entityId !== botEntityId) return undefined;
  const airSupply = packet.metadata.find(
    (entry) =>
      metadataKeys?.[entry.key] === "air_supply" ||
      (legacyMetadata && entry.key === 1),
  );
  if (airSupply === undefined) return undefined;
  if (
    typeof airSupply.value !== "number" ||
    !Number.isFinite(airSupply.value)
  ) {
    return null;
  }
  // The safety threshold is expressed in 15-tick oxygen units. Ceil keeps
  // raw values above the five-unit cutoff from being reported as low.
  const oxygen = Math.ceil(airSupply.value / 15);
  return Number.isFinite(oxygen) && oxygen >= 0 && oxygen <= 20 ? oxygen : null;
}

export function escapeTarget(
  origin: Position,
  threats: readonly Position[],
  distance = 16,
): Position | undefined {
  if (threats.length === 0) return undefined;
  const candidates = Array.from({ length: 16 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 16;
    const candidate = {
      x: origin.x + Math.cos(angle) * distance,
      y: origin.y,
      z: origin.z + Math.sin(angle) * distance,
    };
    const clearances = threats.map((threat) =>
      Math.hypot(candidate.x - threat.x, candidate.z - threat.z),
    );
    const segmentX = candidate.x - origin.x;
    const segmentZ = candidate.z - origin.z;
    const segmentLengthSquared = segmentX ** 2 + segmentZ ** 2;
    const pathClearances = threats.map((threat) => {
      const projection =
        ((threat.x - origin.x) * segmentX + (threat.z - origin.z) * segmentZ) /
        segmentLengthSquared;
      const boundedProjection = Math.max(0, Math.min(1, projection));
      const closestX = origin.x + segmentX * boundedProjection;
      const closestZ = origin.z + segmentZ * boundedProjection;
      return Math.hypot(closestX - threat.x, closestZ - threat.z);
    });
    return {
      candidate,
      minimumPathClearance: Math.min(...pathClearances),
      totalPathClearance: pathClearances.reduce(
        (total, value) => total + value,
        0,
      ),
      minimumClearance: Math.min(...clearances),
      totalClearance: clearances.reduce((total, value) => total + value, 0),
    };
  });
  candidates.sort(
    (left, right) =>
      right.minimumPathClearance - left.minimumPathClearance ||
      right.totalPathClearance - left.totalPathClearance ||
      right.minimumClearance - left.minimumClearance ||
      right.totalClearance - left.totalClearance,
  );
  return candidates[0]?.candidate;
}

/** Select only observed, dry footholds beside water; path reachability is checked separately. */
export function observedShoreCandidates(
  origin: Position,
  blockAt: (
    position: Position,
  ) => { readonly name: string; readonly boundingBox: string } | null,
  hostiles: readonly Position[],
  radius = 7,
): Position[] {
  const baseX = Math.floor(origin.x);
  const baseY = Math.floor(origin.y);
  const baseZ = Math.floor(origin.z);
  const candidates: { position: Position; cost: number }[] = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const horizontalDistance = Math.hypot(dx, dz);
      if (horizontalDistance < 1 || horizontalDistance > radius) continue;
      const x = baseX + dx;
      const z = baseZ + dz;
      for (let y = baseY - 1; y <= baseY + 5; y += 1) {
        const position = { x, y, z };
        const feet = blockAt(position);
        const head = blockAt({ x, y: y + 1, z });
        const ground = blockAt({ x, y: y - 1, z });
        if (
          feet === null ||
          head === null ||
          ground === null ||
          !isAirName(feet.name) ||
          !isAirName(head.name) ||
          ground.boundingBox !== "block" ||
          unsafeDescentSurfaces.has(ground.name) ||
          hostiles.some((hostile) => distance(hostile, position) < 4)
        )
          continue;
        const waterAdjacent = (
          [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const
        ).some(([sideX, sideZ]) =>
          [y, y - 1].some(
            (level) =>
              blockAt({ x: x + sideX, y: level, z: z + sideZ })?.name ===
              "water",
          ),
        );
        if (!waterAdjacent) continue;
        candidates.push({
          position,
          cost: horizontalDistance + Math.abs(y - baseY) * 0.4,
        });
      }
    }
  }
  return candidates
    .sort((left, right) => left.cost - right.cost)
    .slice(0, 12)
    .map(({ position }) => position);
}

export function nearestItemDropPosition(
  origin: Position,
  expectedItemName: string,
  entities: readonly {
    readonly itemName: string | undefined;
    readonly position: Position;
  }[],
  maxDistance = 8,
): Position | undefined {
  return entities
    .filter(({ itemName }) => itemName === expectedItemName)
    .map(({ position }) => ({
      position,
      distance: distance(origin, position),
    }))
    .filter((candidate) => candidate.distance <= maxDistance)
    .sort((left, right) => left.distance - right.distance)[0]?.position;
}

function generalPermissionSafety(
  permission: GeneralActionCandidate["permission"],
  hazards: readonly string[],
): GeneralActionCandidate["safety"] {
  if (permission !== "allowed")
    return permission === "unknown" ? "unknown" : "blocked";
  return hazards.length === 0 ? "allowed" : "blocked";
}

function normalizePermission(
  decision: "allowed" | "unknown" | "protected" | "changed",
): GeneralActionCandidate["permission"] {
  return decision === "allowed"
    ? "allowed"
    : decision === "unknown"
      ? "unknown"
      : "denied";
}

function generalCandidateId(
  action: string,
  name: string,
  position: { x: number; y: number; z: number },
): string {
  return `${action}:${name}:${position.x}:${position.y}:${position.z}`;
}

function isAirName(name: string | undefined): boolean {
  return name === undefined || ["air", "cave_air", "void_air"].includes(name);
}

const unsafeDescentSurfaces = new Set([
  "magma_block",
  "cactus",
  "campfire",
  "soul_campfire",
  "powder_snow",
  "pointed_dripstone",
  "lava",
  "fire",
  "water",
]);

const descentNodeKey = (position: Position): string =>
  `${position.x},${position.y},${position.z}`;

class ObservedShoreMovements extends Movements {
  public constructor(
    private readonly minecraftBot: Bot,
    private readonly origin: Position,
    private readonly radius: number,
    private readonly approvedNodes?: ReadonlySet<string>,
  ) {
    super(minecraftBot);
    this.canDig = false;
    this.allow1by1towers = false;
    this.allowParkour = false;
    this.allowSprinting = false;
    this.maxDropDown = 2;
    this.infiniteLiquidDropdownDistance = false;
    this.exclusionAreasStep = [() => 0];
  }

  public override getNeighbors(node: Move): Move[] {
    return super.getNeighbors(node).filter((move) => {
      if (
        move.toBreak.length > 0 ||
        move.toPlace.length > 0 ||
        (this.approvedNodes !== undefined &&
          !this.approvedNodes.has(descentNodeKey(move))) ||
        Math.hypot(move.x - this.origin.x, move.z - this.origin.z) >
          this.radius + 1 ||
        Math.abs(move.y - this.origin.y) > 5
      )
        return false;
      const bot = this.minecraftBot;
      const feet = bot.blockAt(new Vec3(move.x, move.y, move.z));
      const head = bot.blockAt(new Vec3(move.x, move.y + 1, move.z));
      const ground = bot.blockAt(new Vec3(move.x, move.y - 1, move.z));
      if (
        feet === null ||
        head === null ||
        ground === null ||
        !["water", "air", "cave_air", "void_air"].includes(feet.name) ||
        !["water", "air", "cave_air", "void_air"].includes(head.name) ||
        (ground.name !== "water" && unsafeDescentSurfaces.has(ground.name)) ||
        (isAirName(feet.name) &&
          ground.name !== "water" &&
          ground.boundingBox !== "block")
      )
        return false;
      return !Object.values(bot.entities).some((entity) => {
        if (entity.id === bot.entity.id) return false;
        const name = entity.name ?? entity.displayName ?? entity.type;
        return (
          isHostileEntity(name, entity.type, bot.registry) &&
          entity.position.distanceTo(new Vec3(move.x, move.y, move.z)) < 3
        );
      });
    });
  }
}

class ObservedDescentMovements extends NavigationMovements {
  public constructor(
    private readonly minecraftBot: Bot,
    private readonly approvedNodes?: ReadonlySet<string>,
  ) {
    super(minecraftBot);
    this.canDig = false;
    this.allow1by1towers = false;
    this.allowParkour = false;
    this.allowSprinting = false;
    // The pathfinder compares feet Y with the supporting block one below the
    // landing feet. Its setting is therefore one greater than the foot drop.
    this.maxDropDown = safeDescentLimits.maxDrop + 1;
    this.infiniteLiquidDropdownDistance = false;
    // An active exclusion area also disables the pathfinder's straight-line
    // shortcut, which would otherwise bypass the individually checked nodes.
    this.exclusionAreasStep = [() => 0];
  }

  public override getNeighbors(node: Move): Move[] {
    return super.getNeighbors(node).filter((move) => {
      if (
        move.toBreak.length > 0 ||
        move.toPlace.some(
          (placement) =>
            (placement as { readonly useOne?: boolean }).useOne !== true,
        ) ||
        (this.approvedNodes !== undefined &&
          !this.approvedNodes.has(descentNodeKey(move)))
      ) {
        return false;
      }
      return this.isObservedSafeLanding(move);
    });
  }

  public isObservedSafeLanding(position: Position): boolean {
    return this.landingReason(position) === null;
  }

  public landingReason(position: Position): DescentBlockReason | null {
    const bot = this.minecraftBot;
    if (
      bot.entity.position.distanceTo(
        new Vec3(position.x, position.y, position.z),
      ) > 32
    )
      return "route_unobserved";
    const feet = bot.blockAt(new Vec3(position.x, position.y, position.z));
    const head = bot.blockAt(new Vec3(position.x, position.y + 1, position.z));
    const ground = bot.blockAt(
      new Vec3(position.x, position.y - 1, position.z),
    );
    if (
      feet === null ||
      head === null ||
      ground === null ||
      (!isAirName(feet.name) && !isHandOperableDoor(feet.name)) ||
      (!isAirName(head.name) && !isHandOperableDoor(head.name)) ||
      ground.boundingBox !== "block" ||
      unsafeDescentSurfaces.has(ground.name)
    ) {
      return feet === null || head === null || ground === null
        ? "route_unobserved"
        : "landing_unsafe";
    }
    const hostileNearby = Object.values(bot.entities).some((entity) => {
      if (entity.id === bot.entity.id) return false;
      const name = entity.name ?? entity.displayName ?? entity.type;
      return (
        isHostileEntity(name, entity.type, bot.registry) &&
        entity.position.distanceTo(
          new Vec3(position.x, position.y, position.z),
        ) < safeDescentLimits.hostileClearance
      );
    });
    return hostileNearby ? "hostile_nearby" : null;
  }
}

function nearbyDescentFailureReason(
  bot: Bot,
  movements: ObservedDescentMovements,
): DescentBlockReason {
  const origin = bot.entity.position.floored();
  let observedSafeLanding = false;
  let tooHigh = false;
  let unsafe = false;
  let hostile = false;
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    for (let drop = 1; drop <= safeDescentLimits.maxDrop + 4; drop += 1) {
      const feetY = origin.y - drop;
      const support = bot.blockAt(
        new Vec3(origin.x + dx, feetY - 1, origin.z + dz),
      );
      if (support === null) break;
      if (support.boundingBox !== "block") continue;
      if (drop <= 2) break;
      if (drop > safeDescentLimits.maxDrop) {
        tooHigh = true;
        break;
      }
      const reason = movements.landingReason({
        x: origin.x + dx,
        y: feetY,
        z: origin.z + dz,
      });
      if (reason === null) observedSafeLanding = true;
      else if (reason === "hostile_nearby") hostile = true;
      else if (reason === "landing_unsafe") unsafe = true;
      break;
    }
  }
  if (hostile) return "hostile_nearby";
  if (unsafe) return "landing_unsafe";
  if (tooHigh) return "drop_too_high";
  return observedSafeLanding ? "no_descent" : "route_unobserved";
}

function safeDescentBlocked(
  reason: DescentBlockReason,
  predictedMaxDamage = 0,
): AppError {
  return new AppError({
    category: "safety",
    code: "SAFE_DESCENT_BLOCKED",
    message: "A safe descent could not be confirmed",
    retryable: false,
    failedAt: "safe_descent",
    confirmedState: { reason, predictedMaxDamage },
  });
}

export class MineflayerClient implements MinecraftPort {
  private botInstance: Bot | undefined;
  private spawned = false;
  private intentionalDisconnect = false;
  private authoritativeOxygen: number | null | undefined;
  private expectedDescentDamage: ExpectedDescentDamage | undefined;
  private readonly chatListeners = new Set<
    (username: string, message: string) => void
  >();
  private readonly deathListeners = new Set<(observedAt: string) => void>();
  private readonly disconnectListeners = new Set<(reason: string) => void>();

  public constructor(
    private readonly options: MineflayerClientOptions,
    private readonly logger: MinecraftLogger,
  ) {}

  public async connect(signal?: AbortSignal): Promise<void> {
    if (this.spawned) return;
    if (
      sameMinecraftIdentity(
        this.options.bot.username,
        this.options.ownerUsername,
      )
    ) {
      throw new AppError({
        category: "connection",
        code: "MINECRAFT_IDENTITY_CONFLICT",
        message: "Bot and owner Minecraft identities conflict",
        retryable: false,
      });
    }
    this.intentionalDisconnect = false;
    const bot = mineflayer.createBot(this.options.bot);
    bot.loadPlugin(pathfinder);
    this.botInstance = bot;
    this.authoritativeOxygen = undefined;
    this.expectedDescentDamage = undefined;
    const usesNamedMetadata = bot.supportFeature("mcDataHasEntityMetadata");
    bot._client.on("entity_metadata", (packet) => {
      const botEntity = bot.entity;
      const metadataPacket = parseEntityMetadataPacket(packet as unknown);
      if (metadataPacket === undefined) return;
      const metadataKeys =
        usesNamedMetadata && botEntity.name !== undefined
          ? bot.registry.entitiesByName[botEntity.name]?.metadataKeys
          : undefined;
      const oxygen = oxygenFromEntityMetadata(
        metadataPacket,
        botEntity.id,
        metadataKeys,
        !usesNamedMetadata,
      );
      if (oxygen !== undefined) this.authoritativeOxygen = oxygen;
    });
    bot.on("chat", (username, message) => {
      if (
        sameMinecraftIdentity(username, bot.username) ||
        sameMinecraftIdentity(username, this.options.bot.username)
      )
        return;
      for (const listener of this.chatListeners) listener(username, message);
    });
    bot.on("death", () => {
      if (this.botInstance !== bot || this.intentionalDisconnect) return;
      const observedAt = new Date().toISOString();
      for (const listener of this.deathListeners) listener(observedAt);
    });
    bot.on("end", (reason) => {
      this.spawned = false;
      this.logger.warn(
        { intentional: this.intentionalDisconnect },
        "Minecraft connection ended",
      );
      for (const listener of this.disconnectListeners) listener(reason);
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        bot.off("login", onLogin);
        bot.off("spawn", onSpawn);
        bot.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onLogin = (): void => {
        if (!sameMinecraftIdentity(bot.username, this.options.ownerUsername))
          return;
        cleanup();
        this.intentionalDisconnect = true;
        bot.end("identity conflict");
        reject(
          new AppError({
            category: "connection",
            code: "MINECRAFT_IDENTITY_CONFLICT",
            message: "Bot and owner Minecraft identities conflict",
            retryable: false,
          }),
        );
      };
      const onSpawn = (): void => {
        cleanup();
        this.spawned = true;
        bot._client.write("custom_payload", {
          channel: "minecraft:register",
          data: Buffer.from(
            `${treeProtectionChannel}\0${storageChannel}\0${actionGuardChannel}`,
          ),
        });
        const movements = new NavigationMovements(bot);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.thinkTimeout = this.options.pathfinderThinkTimeoutMs;
        bot.pathfinder.tickTimeout = this.options.pathfinderTickTimeoutMs;
        this.logger.info(
          { minecraftVersion: bot.version },
          "Minecraft bot spawned",
        );
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(
          new AppError(
            {
              category: "connection",
              code: "MINECRAFT_CONNECT_FAILED",
              message: error.message,
              retryable: true,
            },
            { cause: error },
          ),
        );
      };
      const onAbort = (): void => {
        cleanup();
        bot.end("connect cancelled");
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Minecraft connection cancelled"),
        );
      };
      bot.once("login", onLogin);
      bot.once("spawn", onSpawn);
      bot.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    bot.on("kicked", (reason) => {
      this.logger.warn(
        { reasonType: typeof reason },
        "Minecraft bot was kicked",
      );
    });
  }

  public async disconnect(reason = "shutdown"): Promise<void> {
    this.intentionalDisconnect = true;
    this.expectedDescentDamage = undefined;
    await this.stopCurrentAction();
    this.botInstance?.end(reason);
    this.spawned = false;
  }

  public onChat(
    listener: (username: string, message: string) => void,
  ): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  public onDeath(listener: (observedAt: string) => void): () => void {
    this.deathListeners.add(listener);
    return () => this.deathListeners.delete(listener);
  }

  public onDisconnected(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public async observe(): Promise<WorldSnapshot> {
    const bot = this.requireBot();
    const observedAt = new Date().toISOString();
    const botPosition = positionOf(bot.entity.position);
    const inventory = new Map<string, number>();
    for (const item of bot.inventory.items())
      inventory.set(item.name, (inventory.get(item.name) ?? 0) + item.count);

    const armorSlots: readonly ArmorSlot[] = ["head", "torso", "legs", "feet"];
    const observedArmor =
      typeof bot.getEquipmentDestSlot === "function"
        ? armorSlots.map((slot) => ({
            slot,
            item: bot.inventory.slots[bot.getEquipmentDestSlot(slot)],
          }))
        : null;
    const armor: ArmorEquipment | null =
      observedArmor === null ||
      observedArmor.some(({ item }) => item === undefined)
        ? null
        : {
            head: observedArmor[0]?.item?.name ?? null,
            torso: observedArmor[1]?.item?.name ?? null,
            legs: observedArmor[2]?.item?.name ?? null,
            feet: observedArmor[3]?.item?.name ?? null,
          };

    const players = Object.values(bot.players)
      .filter(
        (player) =>
          player.username !== bot.username &&
          (player as { readonly entity?: unknown }).entity !== undefined &&
          (player as { readonly entity?: unknown }).entity !== null,
      )
      .map((player) => ({
        username: player.username,
        position: positionOf(player.entity.position),
        distance: bot.entity.position.distanceTo(player.entity.position),
      }));
    const nearbyEntities: EntityObservation[] = Object.values(bot.entities)
      .filter((entity) => entity.id !== bot.entity.id)
      .map((entity) => {
        const name = entity.name ?? entity.displayName ?? entity.type;
        return {
          id: entity.id,
          name,
          kind: entity.type,
          position: positionOf(entity.position),
          distance: bot.entity.position.distanceTo(entity.position),
          hostile: isHostileEntity(name, entity.type, bot.registry),
        };
      })
      .filter((entity) => entity.distance <= 32);

    const feet = bot.blockAt(bot.entity.position);
    const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    const blockNames = [feet?.name, head?.name];
    const physicsState = bot.entity as unknown as {
      isInWater?: boolean;
      isInLava?: boolean;
      onFire?: boolean;
    };
    const inWater =
      physicsState.isInWater ?? blockNames.some((name) => name === "water");
    const oxygen = this.authoritativeOxygen ?? null;
    return {
      observedAt,
      subject: "bot",
      source: "minecraft",
      connected: true,
      spawned: this.spawned,
      dimension: bot.game.dimension,
      position: botPosition,
      velocityY: bot.entity.velocity.y,
      health: bot.health,
      food: bot.food,
      oxygen,
      oxygenState: oxygenObservationState(oxygen, inWater),
      onFire: physicsState.onFire ?? false,
      inWater,
      inLava:
        physicsState.isInLava ?? blockNames.some((name) => name === "lava"),
      suffocating:
        head !== null &&
        !["air", "cave_air", "void_air", "water", "lava"].includes(head.name) &&
        head.boundingBox === "block",
      inventory: [...inventory].map(([name, count]) => ({ name, count })),
      armor,
      players,
      nearbyEntities,
    };
  }

  public isExpectedDescentDamage(
    previous: WorldSnapshot,
    current: WorldSnapshot,
  ): boolean {
    return this.expectedDescentDamage?.consume(previous, current) ?? false;
  }

  public async observeSurroundings(
    radius: number,
    includeEntities: boolean,
  ): Promise<SurroundingsObservation> {
    if (!Number.isFinite(radius) || radius < 1 || radius > 32) {
      throw new AppError({
        category: "validation",
        code: "INVALID_OBSERVATION_RADIUS",
        message: "Surroundings radius must be between 1 and 32 blocks",
        retryable: false,
      });
    }
    const bot = this.requireBot();
    const origin = bot.entity.position;
    const blocks = bot
      .findBlocks({
        matching: (block) =>
          block.name !== "air" &&
          block.name !== "cave_air" &&
          block.name !== "void_air",
        maxDistance: radius,
        count: 128,
      })
      .map((position) => bot.blockAt(position))
      .filter((block): block is NonNullable<typeof block> => block !== null)
      .map((block) => ({
        name: block.name,
        position: positionOf(block.position),
        distance: origin.distanceTo(block.position),
      }))
      .sort((left, right) => left.distance - right.distance);
    const entities = includeEntities
      ? Object.values(bot.entities)
          .filter(
            (entity) =>
              entity.id !== bot.entity.id &&
              origin.distanceTo(entity.position) <= radius,
          )
          .map((entity) => {
            const name = entity.name ?? entity.displayName ?? entity.type;
            return {
              id: entity.id,
              name,
              kind: entity.type,
              position: positionOf(entity.position),
              distance: origin.distanceTo(entity.position),
              hostile: isHostileEntity(name, entity.type, bot.registry),
            };
          })
          .sort((left, right) => left.distance - right.distance)
          .slice(0, 64)
      : [];
    const snapshot = await this.observe();
    const hazards = [
      ...(snapshot.inLava ? ["lava"] : []),
      ...(snapshot.onFire ? ["fire"] : []),
      ...(snapshot.inWater && snapshot.oxygenState === "low"
        ? ["low_oxygen"]
        : []),
      ...(snapshot.inWater && snapshot.oxygenState === "unknown"
        ? ["oxygen_unconfirmed"]
        : []),
      ...(entities.some((entity) => entity.hostile) ? ["hostile_entity"] : []),
    ];
    return {
      observedAt: snapshot.observedAt,
      subject: snapshot.subject,
      source: snapshot.source,
      oxygen: snapshot.oxygen,
      oxygenState: snapshot.oxygenState,
      inWater: snapshot.inWater,
      blocks,
      entities,
      hazards,
    };
  }

  public async say(message: string): Promise<void> {
    if (message.length === 0 || message.length > 240) {
      throw new AppError({
        category: "validation",
        code: "INVALID_CHAT_MESSAGE",
        message: "Minecraft chat message must contain 1-240 characters",
        retryable: false,
      });
    }
    this.requireBot().chat(message);
  }

  public async moveTo(
    position: Position,
    range: number,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "move_to");
    const bot = this.requireBot();
    const origin = bot.entity.position.floored();
    let stagnantSegments = 0;
    for (let segment = 0; segment < 24; segment += 1) {
      throwIfAborted(signal, "move_to");
      const before = await this.observe();
      if (distance(before.position, position) <= range + 0.75) {
        bot.clearControlStates();
        return;
      }
      const checkedHighNodes = new Set<string>();
      const confirmReturn = (node: Move): boolean => {
        if (node.y - origin.y < 3) return true;
        const highNode = new Vec3(
          Math.floor(node.x),
          Math.floor(node.y),
          Math.floor(node.z),
        );
        const key = descentNodeKey(highNode);
        if (checkedHighNodes.has(key)) return true;
        if (checkedHighNodes.size >= 12) return false;
        try {
          if (!this.hasObservedReturnRoute(bot, highNode, origin)) return false;
        } catch {
          return false;
        }
        checkedHighNodes.add(key);
        return true;
      };
      const target = new goals.GoalNear(
        position.x,
        position.y,
        position.z,
        range,
      );
      const search = bot.pathfinder.getPathFromTo(
        bot.pathfinder.movements,
        bot.entity.position,
        target,
        {
          optimizePath: false,
          timeout: Math.min(this.options.pathfinderThinkTimeoutMs, 700),
        },
      );
      const nextPlan = ():
        | {
            readonly status: string;
            readonly path: Move[];
          }
        | undefined =>
        (
          search.next().value as
            | {
                readonly result: {
                  readonly status: string;
                  readonly path: Move[];
                };
              }
            | undefined
        )?.result;
      let planned = nextPlan();
      for (
        let continuation = 0;
        planned?.status === "partial" &&
        planned.path.length === 0 &&
        continuation < 3;
        continuation += 1
      ) {
        planned = nextPlan();
      }
      if (planned === undefined || planned.path.length === 0) {
        throw new AppError({
          category: "path",
          code: "PATHFINDER_FAILED",
          message: "No nearby walking progress could be planned",
          retryable: true,
          failedAt: "move_to",
        });
      }
      // A partial path is useful: take a few observed steps and plan again
      // instead of requiring a complete route before leaving the start.
      let waypoint: Move | undefined;
      for (const node of planned.path.slice(0, 4)) {
        if (!confirmReturn(node)) break;
        waypoint = node;
      }
      if (waypoint === undefined) {
        throw new AppError({
          category: "safety",
          code: "ASCENT_RETURN_UNCONFIRMED",
          message: "No observed safe return from the next high step",
          retryable: false,
          failedAt: "move_to",
        });
      }
      const unsafeAscent = new AbortController();
      const verifyNearbyRoute = (path: {
        readonly path: readonly Move[];
      }): void => {
        for (const node of path.path) {
          if (confirmReturn(node)) continue;
          unsafeAscent.abort(new Error("High-place return route unconfirmed"));
          break;
        }
      };
      bot.on("path_update", verifyNearbyRoute);
      try {
        await this.runPathfinder(
          new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, 0),
          AbortSignal.any([signal, unsafeAscent.signal]),
        );
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal, "move_to");
        if (unsafeAscent.signal.aborted) {
          bot.pathfinder.setGoal(null);
          bot.clearControlStates();
          throw new AppError({
            category: "safety",
            code: "ASCENT_RETURN_UNCONFIRMED",
            message: "The nearby high route has no observed safe return",
            retryable: false,
            failedAt: "move_to",
          });
        }
        throw error;
      } finally {
        bot.off("path_update", verifyNearbyRoute);
      }
      const after = await this.observe();
      stagnantSegments =
        distance(before.position, after.position) < 0.75
          ? stagnantSegments + 1
          : 0;
      if (stagnantSegments >= 2) {
        bot.clearControlStates();
        throw new AppError({
          category: "path",
          code: "PATH_PROGRESS_STALLED",
          message: "Two walking segments completed without observed progress",
          retryable: false,
          failedAt: "move_to",
        });
      }
    }
    bot.clearControlStates();
    throw new AppError({
      category: "path",
      code: "PATH_EXPLORATION_LIMIT",
      message: "Bounded walking exploration did not reach the goal",
      retryable: false,
      failedAt: "move_to",
    });
  }

  private hasObservedReturnRoute(
    bot: Bot,
    highNode: Vec3,
    origin: Vec3,
  ): boolean {
    const movements = new ObservedDescentMovements(bot);
    const route = (
      bot.pathfinder
        .getPathFromTo(
          movements,
          highNode,
          new goals.GoalNear(origin.x, origin.y, origin.z, 2),
          {
            optimizePath: false,
            timeout: this.options.pathfinderThinkTimeoutMs,
          },
        )
        .next().value as
        | {
            readonly result: { readonly status: string; readonly path: Move[] };
          }
        | undefined
    )?.result;
    if (route?.status !== "success") return false;
    const decision = assessDescentRoute(
      positionOf(highNode),
      bot.health,
      route.path.map((node) => ({
        position: positionOf(node),
        observed: true,
        landingSafe: movements.isObservedSafeLanding(node),
        hostileDistance: null,
      })),
    );
    return decision.allowed || decision.reason === "no_descent";
  }

  public async moveToWithSafeDescent(
    position: Position,
    range: number,
    signal: AbortSignal,
  ): Promise<SafeMoveResult> {
    this.expectedDescentDamage?.clear();
    this.expectedDescentDamage = undefined;
    const before = await this.observe();
    try {
      await this.moveTo(position, range, signal);
      const after = await this.observe();
      return {
        usedDescent: false,
        predictedMaxDamage: 0,
        healthBefore: before.health,
        minimumObservedHealth: Math.min(before.health, after.health),
        healthAfter: after.health,
      };
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        ![
          "PATHFINDER_FAILED",
          "MOVE_VERIFICATION_FAILED",
          "PATH_PROGRESS_STALLED",
          "PATH_EXPLORATION_LIMIT",
        ].includes(error.detail.code)
      ) {
        throw error;
      }
    }

    throwIfAborted(signal, "safe_descent");
    const bot = this.requireBot();
    const current = await this.observe();
    if (
      current.onFire ||
      current.inLava ||
      current.inWater ||
      current.suffocating ||
      current.velocityY < -0.1
    ) {
      throw safeDescentBlocked("landing_unsafe");
    }
    const goal = new goals.GoalNear(position.x, position.y, position.z, range);
    const planningMovements = new ObservedDescentMovements(bot);
    const nextPath = (
      bot.pathfinder
        .getPathFromTo(planningMovements, bot.entity.position, goal, {
          optimizePath: false,
          timeout: this.options.pathfinderThinkTimeoutMs,
        })
        .next().value as
        | {
            readonly result: { readonly status: string; readonly path: Move[] };
          }
        | undefined
    )?.result;
    if (nextPath?.status !== "success") {
      throw safeDescentBlocked(
        nearbyDescentFailureReason(bot, planningMovements),
      );
    }
    const route = nextPath.path;
    const plannedLandings: PlannedLanding[] = route.flatMap((node, index) => {
      const fromY = route[index - 1]?.y ?? current.position.y;
      return fromY - node.y > 2 ? [{ position: positionOf(node), fromY }] : [];
    });
    const decision = assessDescentRoute(
      current.position,
      current.health,
      route.map((move) => ({
        position: positionOf(move),
        observed: true,
        landingSafe: planningMovements.isObservedSafeLanding(move),
        hostileDistance: null,
      })),
    );
    if (!decision.allowed) {
      throw safeDescentBlocked(decision.reason, decision.predictedMaxDamage);
    }

    const approvedNodes = new Set(route.map(descentNodeKey));
    const constrainedMovements = new ObservedDescentMovements(
      bot,
      approvedNodes,
    );
    const previousMovements = bot.pathfinder.movements;
    const safetyStop = new AbortController();
    const minimumExpectedHealth = current.health - decision.predictedMaxDamage;
    const expectedDamage = new ExpectedDescentDamage(
      plannedLandings,
      minimumExpectedHealth,
    );
    this.expectedDescentDamage = expectedDamage;
    let minimumObservedY = current.position.y;
    let minimumObservedHealth = current.health;
    let lastObservedHealth = current.health;
    let observedDamage = 0;
    const onPhysicsTick = (): void => {
      minimumObservedY = Math.min(minimumObservedY, bot.entity.position.y);
      expectedDamage.observeFall(positionOf(bot.entity.position), bot.health);
    };
    const onHealth = (): void => {
      minimumObservedHealth = Math.min(minimumObservedHealth, bot.health);
      observedDamage += Math.max(0, lastObservedHealth - bot.health);
      lastObservedHealth = bot.health;
      if (
        bot.health < minimumExpectedHealth ||
        bot.health < safeDescentLimits.minimumRemainingHealth ||
        observedDamage > decision.predictedMaxDamage
      ) {
        safetyStop.abort(new Error("Descent exceeded the health budget"));
      }
    };
    bot.on("health", onHealth);
    bot.on("physicsTick", onPhysicsTick);
    try {
      try {
        bot.pathfinder.setMovements(constrainedMovements);
        await this.runPathfinder(
          goal,
          AbortSignal.any([signal, safetyStop.signal]),
        );
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal, "safe_descent");
        if (safetyStop.signal.aborted) {
          throw new AppError({
            category: "safety",
            code: "DESCENT_HEALTH_BUDGET_EXCEEDED",
            message:
              "The observed health loss exceeded the safe descent budget",
            retryable: false,
            failedAt: "safe_descent",
          });
        }
        throw error;
      } finally {
        bot.off("physicsTick", onPhysicsTick);
        bot.pathfinder.setGoal(null);
        bot.pathfinder.setMovements(previousMovements);
        bot.clearControlStates();
      }
      await delay(750, signal);
      const after = await this.observe();
      minimumObservedHealth = Math.min(minimumObservedHealth, after.health);
      if (safetyStop.signal.aborted) {
        throw new AppError({
          category: "safety",
          code: "DESCENT_HEALTH_BUDGET_EXCEEDED",
          message: "The observed health loss exceeded the safe descent budget",
          retryable: false,
          failedAt: "safe_descent",
        });
      }
      if (
        distance(after.position, position) > range + 0.75 ||
        after.velocityY < -0.1 ||
        minimumObservedHealth < safeDescentLimits.minimumRemainingHealth ||
        observedDamage > decision.predictedMaxDamage ||
        current.health - minimumObservedHealth > decision.predictedMaxDamage
      ) {
        throw new AppError({
          category: "observation",
          code: "DESCENT_RESULT_NOT_VERIFIED",
          message:
            "The descent result did not meet the verified position and health limits",
          retryable: false,
          failedAt: "safe_descent",
        });
      }
      return {
        usedDescent:
          current.position.y - Math.min(minimumObservedY, after.position.y) > 2,
        predictedMaxDamage: decision.predictedMaxDamage,
        healthBefore: current.health,
        minimumObservedHealth,
        healthAfter: after.health,
      };
    } finally {
      bot.off("health", onHealth);
      expectedDamage.clear();
      this.expectedDescentDamage = undefined;
    }
  }

  public async followPlayer(
    username: string,
    range: number,
    maxPathAttempts: number,
    signal: AbortSignal,
  ): Promise<void> {
    const bot = this.requireBot();
    const player = bot.players[username];
    if (player?.entity === undefined) {
      throw new AppError({
        category: "observation",
        code: "PLAYER_NOT_VISIBLE",
        message: "The target player is not visible",
        retryable: true,
        failedAt: "follow_player",
      });
    }
    if (!Number.isInteger(maxPathAttempts) || maxPathAttempts < 1) {
      throw new AppError({
        category: "validation",
        code: "INVALID_FOLLOW_PATH_ATTEMPTS",
        message: "Follow path attempts must be a positive integer",
        retryable: false,
        failedAt: "follow_player",
      });
    }
    const goal = new goals.GoalFollow(player.entity, range);
    let consecutiveFailures = 0;
    const resetFailures = new Set([
      "dig_error",
      "no_scaffolding_blocks",
      "place_error",
      "stuck",
    ]);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          bot.off("path_update", onPathUpdate);
          bot.off("path_reset", onPathReset);
          bot.off("physicsTick", onPositionUpdate);
          signal.removeEventListener("abort", onAbort);
        };
        const finish = (error?: AppError): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error === undefined) resolve();
          else reject(error);
        };
        const failedAttempt = (reason: string): void => {
          consecutiveFailures += 1;
          if (consecutiveFailures >= maxPathAttempts) {
            finish(
              new AppError({
                category: "path",
                code: "FOLLOW_PATH_RETRY_EXHAUSTED",
                message:
                  "The follow path remained unavailable after bounded retries",
                retryable: false,
                failedAt: "follow_player",
                confirmedState: {
                  attempts: consecutiveFailures,
                  lastReason: reason,
                },
              }),
            );
            return;
          }
          bot.pathfinder.setGoal(goal, true);
        };
        const onPathUpdate = (result: { readonly status: string }): void => {
          if (result.status === "success" || result.status === "partial") {
            consecutiveFailures = 0;
          } else if (
            result.status === "noPath" ||
            result.status === "timeout"
          ) {
            failedAttempt(result.status);
          }
        };
        const onPathReset = (reason: string): void => {
          if (resetFailures.has(reason)) failedAttempt(reason);
        };
        const onAbort = (): void => finish();
        const onPositionUpdate = (): void => {
          const target = bot.players[username]?.entity;
          if (
            target !== undefined &&
            bot.entity.position.distanceTo(target.position) <= range + 1
          ) {
            finish();
          }
        };
        bot.on("path_update", onPathUpdate);
        bot.on("path_reset", onPathReset);
        bot.on("physicsTick", onPositionUpdate);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish();
        else {
          bot.pathfinder.setGoal(goal, true);
          onPositionUpdate();
        }
      });
    } finally {
      await this.stopCurrentAction();
    }
  }

  public async storageIdentity(
    position: Position | null,
    register: boolean,
    signal: AbortSignal,
    resource?: string,
  ) {
    const bot = this.requireBot();
    if (
      position !== null &&
      register &&
      distance(positionOf(bot.entity.position), position) > 5
    ) {
      throw new AppError({
        category: "validation",
        code: "CHEST_REGISTRATION_OUT_OF_REACH",
        message: "指定チェストへ近づいてから登録してください。",
        retryable: false,
      });
    }
    return queryStorageIdentity(
      bot._client,
      position,
      register,
      signal,
      resource,
    );
  }

  public async depositLogs(
    target: ChestTarget,
    resource: string,
    count: number,
    signal: AbortSignal,
  ) {
    const bot = this.requireBot();
    return depositIntoChest(
      bot,
      target,
      resource,
      count,
      signal,
      (inspectionSignal) =>
        this.storageIdentity(
          target.position,
          false,
          inspectionSignal,
          resource,
        ),
    );
  }

  public async findResources(
    names: readonly string[],
    maxDistance: number,
    count: number,
    signal: AbortSignal,
  ): Promise<readonly ResourceTarget[]> {
    throwIfAborted(signal, "find_resources");
    const bot = this.requireBot();
    const ids = names
      .map((name) => bot.registry.blocksByName[name]?.id)
      .filter((id): id is number => id !== undefined);
    if (ids.length === 0) {
      throw new AppError({
        category: "resource",
        code: "UNSUPPORTED_RESOURCE",
        message:
          "None of the requested resource names exist in the connected Minecraft registry",
        retryable: false,
      });
    }
    const seen = new Set<string>();
    const allowed: ResourceTarget[] = [];
    while (allowed.length < count) {
      throwIfAborted(signal, "find_resources");
      const positions = bot.findBlocks({
        matching: ids,
        maxDistance,
        count: 64,
        useExtraInfo: (block) => !seen.has(block.position.toString()),
      });
      if (positions.length === 0) break;
      for (const position of positions) {
        seen.add(position.toString());
        throwIfAborted(signal, "find_resources");
        const block = bot.blockAt(position);
        if (block === null || !names.includes(block.name)) continue;
        const candidate = {
          name: block.name,
          position: positionOf(block.position),
        };
        if (
          (await queryTreeProtection(bot._client, candidate, signal)) ===
          "allowed"
        )
          allowed.push(candidate);
        if (allowed.length >= count) break;
      }
    }
    return allowed;
  }

  public async observeActionCandidates(
    input: GeneralActionObservationInput,
    signal: AbortSignal,
  ): Promise<readonly GeneralActionCandidate[]> {
    throwIfAborted(signal, "observe_actions");
    const bot = this.requireBot();
    const surrounding = await this.observeSurroundings(input.radius, true);
    const requested = new Set(input.requestedItems);
    const candidates: GeneralActionCandidate[] = [];
    const add = (candidate: Omit<GeneralActionCandidate, "order">): void => {
      candidates.push({ ...candidate, order: candidates.length });
    };

    // The general surroundings scan is capped at 128 solid blocks. On flat
    // terrain those slots can all be ground, hiding the requested resource.
    const resourcePositions = bot.findBlocks({
      matching: (block) =>
        knownBlockDrops[block.name] !== undefined &&
        (requested.size === 0 ||
          requested.has(block.name) ||
          goalMetadataForBlock(block.name, requested).goalItem !== undefined),
      maxDistance: input.radius,
      count: Math.min(64, Math.max(16, input.maxCandidates * 4)),
    });
    for (const position of resourcePositions) {
      throwIfAborted(signal, "observe_actions");
      const block = bot.blockAt(position);
      if (block === null || knownBlockDrops[block.name] === undefined) continue;
      const blockPosition = positionOf(block.position);
      const target: ResourceTarget = {
        name: block.name,
        position: blockPosition,
      };
      const goalMetadata = goalMetadataForBlock(block.name, requested);
      let permission: GeneralActionCandidate["permission"];
      try {
        permission = normalizePermission(
          gatherableLogs.includes(block.name as (typeof gatherableLogs)[number])
            ? await queryTreeProtection(bot._client, target, signal)
            : await queryActionGuard(
                bot._client,
                {
                  operation: "mine",
                  name: block.name,
                  position: blockPosition,
                },
                signal,
              ),
        );
      } catch {
        permission = "unknown";
      }
      add({
        id: generalCandidateId("mine_block", block.name, blockPosition),
        label: `${block.name}を採掘`,
        action: "mine_block",
        args: { name: block.name, position: blockPosition },
        steps: [
          {
            tool: "mine_block",
            input: { name: block.name, position: blockPosition },
          },
        ],
        observed: true,
        purposeFit:
          requested.has(block.name) || goalMetadata.goalItem !== undefined
            ? "direct"
            : "unknown",
        permission,
        safety: generalPermissionSafety(permission, surrounding.hazards),
        reversible: false,
        impact: "medium",
        operationClass: "natural_resource",
        requestedCount: 1,
        resourceName: block.name,
        ...goalMetadata,
        distance: bot.entity.position.distanceTo(block.position),
      });
    }

    const inventory = new Map<string, number>();
    for (const item of bot.inventory.items()) {
      inventory.set(item.name, (inventory.get(item.name) ?? 0) + item.count);
    }
    const craftingTable = findCraftingTable(bot, input.radius);
    for (const itemName of requested) {
      const item = bot.registry.itemsByName[itemName];
      const recipesFor = (
        bot as unknown as {
          recipesFor?: (...args: unknown[]) => readonly unknown[];
        }
      ).recipesFor;
      if (item === undefined || recipesFor === undefined) continue;
      let recipe: unknown;
      try {
        recipe = recipesFor.call(bot, item.id, null, 1, craftingTable)[0];
      } catch {
        recipe = undefined;
      }
      if (recipe === undefined) continue;
      const permission: GeneralActionCandidate["permission"] = "allowed";
      const goalMetadata = goalMetadataForOutput(itemName, requested);
      add({
        id: `craft_item:${itemName}`,
        label: `${itemName}を所持品からクラフト`,
        action: "craft_item",
        args: { name: itemName, count: 1 },
        steps: [{ tool: "craft_item", input: { name: itemName, count: 1 } }],
        observed: true,
        purposeFit: "direct",
        permission,
        safety: generalPermissionSafety(permission, surrounding.hazards),
        reversible: false,
        impact: "low",
        operationClass: "world_change",
        requestedCount: 1,
        scopeId: "inventory",
        ...goalMetadata,
        distance: 0,
      });
    }

    const origin = bot.entity.position.floored();
    const placePosition = [
      origin.offset(1, 0, 0),
      origin.offset(-1, 0, 0),
      origin.offset(0, 0, 1),
      origin.offset(0, 0, -1),
    ].find((position) => {
      const block = bot.blockAt(position);
      const support = bot.blockAt(position.offset(0, -1, 0));
      return (
        block !== null &&
        isAirName(block.name) &&
        support !== null &&
        !isAirName(support.name)
      );
    });
    if (placePosition !== undefined) {
      for (const [itemName, held] of inventory) {
        if (held <= 0 || bot.registry.blocksByName[itemName] === undefined)
          continue;
        const position = positionOf(placePosition);
        let permission: GeneralActionCandidate["permission"];
        try {
          permission = normalizePermission(
            await queryActionGuard(
              bot._client,
              { operation: "place", name: itemName, position },
              signal,
            ),
          );
        } catch {
          permission = "unknown";
        }
        const goalMetadata = goalMetadataForOutput(itemName, requested);
        add({
          id: generalCandidateId("place_block", itemName, position),
          label: `${itemName}を観測位置へ設置`,
          action: "place_block",
          args: { name: itemName, position },
          steps: [
            {
              tool: "place_block",
              input: { name: itemName, position },
            },
          ],
          observed: true,
          purposeFit:
            goalMetadata.goalItem !== undefined ? "direct" : "unknown",
          permission,
          safety: generalPermissionSafety(permission, surrounding.hazards),
          reversible: false,
          impact: "medium",
          operationClass: "world_change",
          requestedCount: 1,
          scopeId: "observed-placement",
          ...goalMetadata,
          distance: bot.entity.position.distanceTo(placePosition),
        });
      }
    }

    for (const entity of surrounding.entities) {
      const itemName = droppedItemName(
        entity as unknown as Parameters<typeof droppedItemName>[0],
      );
      if (itemName === undefined) continue;
      const permission: GeneralActionCandidate["permission"] = "allowed";
      const goalMetadata = goalMetadataForOutput(itemName, requested);
      add({
        id: generalCandidateId("collect_item", itemName, entity.position),
        label: `${itemName}を回収`,
        action: "collect_item",
        args: { name: itemName, position: entity.position, count: 1 },
        steps: [
          {
            tool: "collect_item",
            input: { name: itemName, position: entity.position, count: 1 },
          },
        ],
        observed: true,
        purposeFit: goalMetadata.goalItem !== undefined ? "direct" : "unknown",
        permission,
        safety: generalPermissionSafety(permission, surrounding.hazards),
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        requestedCount: 1,
        resourceName: itemName,
        ...goalMetadata,
        distance: entity.distance,
      });
    }

    const furnace = bot.findBlock({
      matching: ["furnace", "blast_furnace", "smoker"]
        .map((name) => bot.registry.blocksByName[name]?.id)
        .filter((id): id is number => id !== undefined),
      maxDistance: input.radius,
      count: 1,
    });
    const smeltingRecipes: Record<string, string> = {
      iron_ingot: "raw_iron",
      gold_ingot: "raw_gold",
      copper_ingot: "raw_copper",
    };
    for (const output of requested) {
      if (furnace === null) break;
      const inputName = smeltingRecipes[output];
      if (inputName === undefined || (inventory.get(inputName) ?? 0) < 1)
        continue;
      const position = positionOf(furnace.position);
      const permission: GeneralActionCandidate["permission"] = "allowed";
      const goalMetadata = goalMetadataForOutput(output, requested);
      add({
        id: generalCandidateId("smelt_item", output, position),
        label: `${inputName}を${output}へ精錬`,
        action: "smelt_item",
        args: { input: inputName, output, count: 1, furnace: position },
        steps: [
          {
            tool: "smelt_item",
            input: { input: inputName, output, count: 1, furnace: position },
          },
        ],
        observed: true,
        purposeFit: "direct",
        permission,
        safety: generalPermissionSafety(permission, surrounding.hazards),
        reversible: false,
        impact: "low",
        operationClass: "world_change",
        requestedCount: 1,
        scopeId: "inventory",
        ...goalMetadata,
        distance: bot.entity.position.distanceTo(furnace.position),
      });
    }
    return selectBalancedActionCandidates(candidates, input.maxCandidates);
  }

  public async dig(target: ResourceTarget, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal, "dig");
    const bot = this.requireBot();
    let block = bot.blockAt(
      new Vec3(target.position.x, target.position.y, target.position.z),
    );
    if (block?.name !== target.name) {
      throw new AppError({
        category: "resource",
        code: "RESOURCE_CHANGED",
        message: "The target block is no longer present",
        retryable: true,
        failedAt: "dig",
      });
    }
    await this.runPathfinder(
      new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.5 }),
      signal,
    );
    block = bot.blockAt(block.position);
    if (block?.name !== target.name) {
      throw new AppError({
        category: "resource",
        code: "RESOURCE_CHANGED",
        message: "The target block changed before a visible face was reached",
        retryable: true,
        failedAt: "dig",
      });
    }
    if (!bot.canDigBlock(block)) {
      throw new AppError({
        category: "resource",
        code: "RESOURCE_NOT_DIGGABLE",
        message: "The observed block cannot be dug from the current position",
        retryable: true,
        failedAt: "dig",
      });
    }
    const bestTool = bot.pathfinder.bestHarvestTool(block);
    if (bestTool !== null) await bot.equip(bestTool, "hand");
    requireTreePermission(
      await queryTreeProtection(bot._client, target, signal),
    );
    throwIfAborted(signal, "dig");
    if (
      this.requireBot() !== bot ||
      bot.blockAt(block.position)?.stateId !== block.stateId
    ) {
      throw new AppError({
        category: "resource",
        code: "RESOURCE_CHANGED",
        message: "The target changed during protection verification",
        retryable: false,
        failedAt: "dig",
      });
    }
    const abort = (): void => bot.stopDigging();
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        await bot.dig(block, true, "auto");
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal, "dig");
        throw new AppError(
          {
            category: "resource",
            code: "DIG_FAILED",
            message: error instanceof Error ? error.message : "Digging failed",
            retryable: true,
            failedAt: "dig",
          },
          { cause: error },
        );
      }
      throwIfAborted(signal, "dig");
      if (bot.blockAt(block.position)?.name === target.name) {
        throw new AppError({
          category: "resource",
          code: "DIG_VERIFICATION_FAILED",
          message: "The target block still exists after digging",
          retryable: true,
          failedAt: "dig",
        });
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  public async mineBlock(
    target: MineBlockInput,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "mine_block");
    const bot = this.requireBot();
    let block = bot.blockAt(
      new Vec3(target.position.x, target.position.y, target.position.z),
    );
    if (block?.name !== target.name) {
      throw new AppError({
        category: "resource",
        code: "RESOURCE_CHANGED",
        message: "The target block is no longer present",
        retryable: true,
        failedAt: "mine_block",
      });
    }
    await this.runPathfinder(
      new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.5 }),
      signal,
    );
    block = bot.blockAt(block.position);
    if (block?.name !== target.name) {
      throw new AppError({
        category: "resource",
        code: "RESOURCE_CHANGED",
        message: "The target block changed before a visible face was reached",
        retryable: true,
        failedAt: "mine_block",
      });
    }
    if (!bot.canDigBlock(block)) {
      throw new AppError({
        category: "resource",
        code: "RESOURCE_NOT_DIGGABLE",
        message: "The observed block cannot be dug from the current position",
        retryable: true,
        failedAt: "mine_block",
      });
    }
    const bestTool = bot.pathfinder.bestHarvestTool(block);
    if (bestTool !== null) await bot.equip(bestTool, "hand");
    requireActionPermission(
      await queryActionGuard(
        bot._client,
        { operation: "mine", name: target.name, position: target.position },
        signal,
      ),
    );
    throwIfAborted(signal, "mine_block");
    if (
      this.requireBot() !== bot ||
      bot.blockAt(block.position)?.stateId !== block.stateId
    ) {
      throw new AppError({
        category: "resource",
        code: "RESOURCE_CHANGED",
        message: "The target changed during permission verification",
        retryable: false,
        failedAt: "mine_block",
      });
    }
    const abort = (): void => bot.stopDigging();
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        await bot.dig(block, true, "auto");
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal, "mine_block");
        throw new AppError(
          {
            category: "resource",
            code: "DIG_FAILED",
            message: error instanceof Error ? error.message : "Digging failed",
            retryable: true,
            failedAt: "mine_block",
          },
          { cause: error },
        );
      }
      throwIfAborted(signal, "mine_block");
      // Mineflayer updates its local world optimistically when the dig timer
      // completes. Re-read the authoritative server block before reporting
      // success so a cancelled/expired permit cannot look like a completed
      // mutation.
      await delay(150, signal);
      const serverState = await queryActionGuard(
        bot._client,
        { operation: "inspect", name: "air", position: target.position },
        signal,
      );
      if (serverState !== "allowed") {
        throw new AppError({
          category: "resource",
          code: "MINE_SERVER_STATE_UNVERIFIED",
          message:
            "The authoritative server did not confirm the target was removed",
          retryable: true,
          failedAt: "mine_block",
          confirmedState: { decision: serverState },
        });
      }
      if (bot.blockAt(block.position)?.name === target.name) {
        throw new AppError({
          category: "resource",
          code: "DIG_VERIFICATION_FAILED",
          message: "The target block still exists after digging",
          retryable: true,
          failedAt: "mine_block",
        });
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  public async collectItem(
    target: CollectItemInput,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "collect_item");
    const before = await this.observe();
    const baseline =
      before.inventory.find((item) => item.name === target.name)?.count ?? 0;
    await this.runPathfinder(
      new goals.GoalNear(
        target.position.x,
        target.position.y,
        target.position.z,
        1,
      ),
      signal,
    );
    await this.collectDropsNear(
      target.position,
      target.name,
      baseline + target.count,
      signal,
    );
  }

  public async craftItem(
    target: CraftItemInput,
    signal: AbortSignal,
  ): Promise<number> {
    throwIfAborted(signal, "craft_item");
    const bot = this.requireBot();
    const item = bot.registry.itemsByName[target.name];
    const recipesFor = (
      bot as unknown as {
        recipesFor?: (...args: unknown[]) => readonly {
          readonly result?: { readonly count?: number };
        }[];
      }
    ).recipesFor;
    const craft = (
      bot as unknown as {
        craft?: (
          recipe: unknown,
          count: number,
          table?: unknown,
        ) => Promise<void>;
      }
    ).craft;
    if (item === undefined || recipesFor === undefined || craft === undefined) {
      throw new AppError({
        category: "resource",
        code: "CRAFT_RECIPE_UNAVAILABLE",
        message: "The requested item has no observed craft recipe",
        retryable: false,
        failedAt: "craft_item",
      });
    }
    const craftingTable = findCraftingTable(bot, 8);
    const recipe = recipesFor.call(bot, item.id, null, 1, craftingTable)[0];
    if (recipe === undefined) {
      throw new AppError({
        category: "resource",
        code: "CRAFT_RECIPE_UNAVAILABLE",
        message: "The requested item has no observed craft recipe",
        retryable: false,
        failedAt: "craft_item",
      });
    }
    const runCount = craftRunsForOutput(target.count, recipe.result?.count);
    if (runCount === undefined) {
      throw new AppError({
        category: "resource",
        code: "CRAFT_OUTPUT_UNKNOWN",
        message: "The observed recipe does not expose a safe output count",
        retryable: false,
        failedAt: "craft_item",
      });
    }
    const before = await this.observe();
    await craft.call(bot, recipe, runCount, craftingTable);
    throwIfAborted(signal, "craft_item");
    const after = await this.observe();
    const beforeCount =
      before.inventory.find((entry) => entry.name === target.name)?.count ?? 0;
    const afterCount =
      after.inventory.find((entry) => entry.name === target.name)?.count ?? 0;
    const delta = Math.max(0, afterCount - beforeCount);
    if (delta < target.count) {
      throw new AppError({
        category: "inventory",
        code: "CRAFT_OUTPUT_NOT_VERIFIED",
        message: "Crafting finished without the requested inventory delta",
        retryable: true,
        failedAt: "craft_item",
        confirmedState: { requested: target.count, produced: delta },
      });
    }
    return delta;
  }

  public async placeBlock(
    target: PlaceBlockInput,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "place_block");
    const bot = this.requireBot();
    const item = bot.registry.itemsByName[target.name];
    if (
      item === undefined ||
      bot.registry.blocksByName[target.name] === undefined
    ) {
      throw new AppError({
        category: "resource",
        code: "PLACE_BLOCK_UNAVAILABLE",
        message:
          "The requested placeable block is not observed in the registry",
        retryable: false,
        failedAt: "place_block",
      });
    }
    const targetPosition = new Vec3(
      target.position.x,
      target.position.y,
      target.position.z,
    );
    const existing = bot.blockAt(targetPosition);
    if (existing === null || !isAirName(existing.name)) {
      throw new AppError({
        category: "validation",
        code: "PLACE_TARGET_OCCUPIED",
        message: "The observed placement position is not empty",
        retryable: false,
        failedAt: "place_block",
      });
    }
    const reference = [
      {
        block: bot.blockAt(targetPosition.offset(-1, 0, 0)),
        face: new Vec3(1, 0, 0),
      },
      {
        block: bot.blockAt(targetPosition.offset(1, 0, 0)),
        face: new Vec3(-1, 0, 0),
      },
      {
        block: bot.blockAt(targetPosition.offset(0, -1, 0)),
        face: new Vec3(0, 1, 0),
      },
      {
        block: bot.blockAt(targetPosition.offset(0, 1, 0)),
        face: new Vec3(0, -1, 0),
      },
      {
        block: bot.blockAt(targetPosition.offset(0, 0, -1)),
        face: new Vec3(0, 0, 1),
      },
      {
        block: bot.blockAt(targetPosition.offset(0, 0, 1)),
        face: new Vec3(0, 0, -1),
      },
    ].find(({ block }) => block !== null && !isAirName(block.name));
    const referenceBlock = reference?.block;
    if (
      reference === undefined ||
      referenceBlock === null ||
      referenceBlock === undefined
    ) {
      throw new AppError({
        category: "path",
        code: "PLACE_SUPPORT_NOT_FOUND",
        message: "No observed solid block can support the placement",
        retryable: false,
        failedAt: "place_block",
      });
    }
    requireActionPermission(
      await queryActionGuard(
        bot._client,
        { operation: "place", name: target.name, position: target.position },
        signal,
      ),
    );
    await bot.equip(item.id, "hand");
    await bot.placeBlock(referenceBlock, reference.face);
    throwIfAborted(signal, "place_block");
    const serverState = await queryActionGuard(
      bot._client,
      { operation: "inspect", name: target.name, position: target.position },
      signal,
    );
    if (serverState !== "allowed") {
      throw new AppError({
        category: "resource",
        code: "PLACE_SERVER_STATE_UNVERIFIED",
        message: "The authoritative server did not confirm the placed block",
        retryable: true,
        failedAt: "place_block",
        confirmedState: { decision: serverState },
      });
    }
    if (bot.blockAt(targetPosition)?.name !== target.name) {
      throw new AppError({
        category: "inventory",
        code: "PLACE_VERIFICATION_FAILED",
        message: "The placed block was not observed at the requested position",
        retryable: true,
        failedAt: "place_block",
      });
    }
  }

  public async inspectBuildBlock(
    position: Position,
    material: string,
    signal: AbortSignal,
  ): Promise<BuildBlockObservation> {
    throwIfAborted(signal, "inspect_build_block");
    const bot = this.requireBot();
    const location = new Vec3(position.x, position.y, position.z);
    let block = bot.blockAt(location);
    if (block === null) {
      await withTimeout(
        () => bot.waitForChunksToLoad(),
        5_000,
        signal,
        "inspect_build_block",
      );
      block = bot.blockAt(location);
    }
    if (block === null) {
      return {
        name: null,
        serverConfirmed: false,
        placementAllowed: false,
        safeGround: false,
      };
    }
    if (isAirName(block.name)) {
      const decision = await queryActionGuard(
        bot._client,
        { operation: "place", name: material, position },
        signal,
      );
      return {
        name: "air",
        serverConfirmed: decision === "allowed" || decision === "protected",
        placementAllowed: decision === "allowed",
        safeGround: false,
      };
    }
    const decision = await queryActionGuard(
      bot._client,
      { operation: "inspect", name: block.name, position },
      signal,
    );
    const siteDecision = buildGroundNames.has(block.name)
      ? await queryActionGuard(
          bot._client,
          { operation: "site", name: block.name, position },
          signal,
        )
      : "unknown";
    return {
      name: block.name,
      serverConfirmed: decision === "allowed",
      placementAllowed: false,
      safeGround: decision === "allowed" && siteDecision === "allowed",
    };
  }

  public async smeltItem(
    target: SmeltItemInput,
    signal: AbortSignal,
  ): Promise<number> {
    throwIfAborted(signal, "smelt_item");
    const bot = this.requireBot();
    const furnacePosition =
      target.furnace ??
      positionOf(
        bot.findBlock({
          matching: ["furnace", "blast_furnace", "smoker"]
            .map((name) => bot.registry.blocksByName[name]?.id)
            .filter((id): id is number => id !== undefined),
          maxDistance: 8,
          count: 1,
        })?.position ?? bot.entity.position,
      );
    const furnaceBlock = bot.blockAt(
      new Vec3(furnacePosition.x, furnacePosition.y, furnacePosition.z),
    );
    if (
      furnaceBlock === null ||
      !["furnace", "blast_furnace", "smoker"].includes(furnaceBlock.name)
    ) {
      throw new AppError({
        category: "resource",
        code: "FURNACE_NOT_FOUND",
        message: "No observed furnace is available for smelting",
        retryable: false,
        failedAt: "smelt_item",
      });
    }
    const typedBot = bot as unknown as {
      openFurnace?: (block: unknown) => Promise<{
        putInput(
          itemId: number,
          metadata: unknown,
          count: number,
        ): Promise<void>;
        putFuel(
          itemId: number,
          metadata: unknown,
          count: number,
        ): Promise<void>;
        takeInput(): Promise<unknown>;
        takeFuel(): Promise<unknown>;
        takeOutput(): Promise<void>;
        close(): void;
        inputItem?: () => {
          readonly name: string;
          readonly count: number;
        } | null;
        fuelItem?: () => {
          readonly name: string;
          readonly count: number;
        } | null;
        outputItem?: () => {
          readonly name: string;
          readonly count: number;
        } | null;
      }>;
    };
    const inputItem = bot.registry.itemsByName[target.input];
    if (typedBot.openFurnace === undefined || inputItem === undefined) {
      throw new AppError({
        category: "resource",
        code: "SMELT_UNAVAILABLE",
        message: "The furnace or smelting input is unavailable",
        retryable: false,
        failedAt: "smelt_item",
      });
    }
    const before = await this.observe();
    const fuelCount = Math.ceil(target.count / 8);
    const fuelName = ["coal", "charcoal"].find(
      (name) =>
        (before.inventory.find((item) => item.name === name)?.count ?? 0) >=
        fuelCount,
    );
    const fuelItem =
      fuelName === undefined ? undefined : bot.registry.itemsByName[fuelName];
    if (fuelItem === undefined) {
      throw new AppError({
        category: "resource",
        code: "SMELT_FUEL_MISSING",
        message: "Not enough known fuel is held for this bounded batch",
        retryable: false,
        failedAt: "smelt_item",
        confirmedState: { requested: target.count, fuelNeeded: fuelCount },
      });
    }
    const furnace = await typedBot.openFurnace(furnaceBlock);
    let batchStarted = false;
    let batchCompleted = false;
    let operationFailed = false;
    let operationError: unknown;
    let cleanupError: unknown;
    try {
      throwIfAborted(signal, "smelt_item");
      const initialSlots = furnaceBatchReadiness({
        input: readFurnaceSlot(furnace.inputItem?.bind(furnace)),
        fuel: readFurnaceSlot(furnace.fuelItem?.bind(furnace)),
        output: readFurnaceSlot(furnace.outputItem?.bind(furnace)),
      });
      if (!initialSlots.allowed) {
        throw new AppError({
          category: "safety",
          code:
            initialSlots.reason === "occupied"
              ? "SMELT_FURNACE_NOT_EMPTY"
              : "SMELT_FURNACE_STATE_UNKNOWN",
          message:
            initialSlots.reason === "occupied"
              ? "The observed furnace contains an unrelated batch"
              : "The furnace slots could not be verified before smelting",
          retryable: initialSlots.reason === "unknown",
          failedAt: "smelt_item",
          confirmedState: {
            slot: initialSlots.slot,
            item: initialSlots.itemName ?? null,
          },
        });
      }
      throwIfAborted(signal, "smelt_item");
      batchStarted = true;
      await furnace.putInput(inputItem.id, null, target.count);
      throwIfAborted(signal, "smelt_item");
      await furnace.putFuel(fuelItem.id, null, fuelCount);
      throwIfAborted(signal, "smelt_item");
      const boundInput = readFurnaceSlot(furnace.inputItem?.bind(furnace));
      const boundFuel = readFurnaceSlot(furnace.fuelItem?.bind(furnace));
      if (
        !boundInput.known ||
        boundInput.itemName !== target.input ||
        !boundFuel.known ||
        boundFuel.itemName !== fuelItem.name
      ) {
        throw new AppError({
          category: "safety",
          code: "SMELT_BATCH_NOT_BOUND",
          message: "The furnace did not confirm the bot-owned input batch",
          retryable: true,
          failedAt: "smelt_item",
          confirmedState: {
            input: boundInput.itemName ?? null,
            fuel: boundFuel.itemName ?? null,
          },
        });
      }
      const boundInputCount = boundInput.count ?? target.count;
      // A vanilla furnace needs about 10 seconds per item at 20 TPS. The
      // generic pickup timeout can expire before its first output appears.
      const smeltWaitMs = Math.max(
        this.options.collectTimeoutMs,
        20_000 + Math.max(0, target.count - 1) * 10_000,
      );
      const deadline = Date.now() + smeltWaitMs;
      while (Date.now() < deadline) {
        throwIfAborted(signal, "smelt_item");
        await delay(250, signal);
        const current = await this.observe();
        const count =
          current.inventory.find((entry) => entry.name === target.output)
            ?.count ?? 0;
        const baseline =
          before.inventory.find((entry) => entry.name === target.output)
            ?.count ?? 0;
        if (count - baseline > target.count) {
          throw new AppError({
            category: "safety",
            code: "SMELT_OUTPUT_EXCEEDS_BOUND",
            message: "The observed output exceeds the authorized batch",
            retryable: false,
            failedAt: "smelt_item",
            confirmedState: {
              requested: target.count,
              observed: count - baseline,
            },
          });
        }
        if (count - baseline === target.count) {
          const remainingInput = readFurnaceSlot(
            furnace.inputItem?.bind(furnace),
          );
          const remainingOutput = readFurnaceSlot(
            furnace.outputItem?.bind(furnace),
          );
          if (
            remainingInput.known &&
            remainingInput.itemName === undefined &&
            remainingOutput.known &&
            remainingOutput.itemName === undefined
          ) {
            batchCompleted = true;
            break;
          }
        }
        const outputSlot = readFurnaceSlot(furnace.outputItem?.bind(furnace));
        if (!outputSlot.known) {
          throw new AppError({
            category: "safety",
            code: "SMELT_FURNACE_STATE_UNKNOWN",
            message: "The furnace output slot could not be verified",
            retryable: true,
            failedAt: "smelt_item",
          });
        }
        if (outputSlot.itemName !== undefined && (outputSlot.count ?? 1) > 0) {
          if (outputSlot.itemName !== target.output) {
            throw new AppError({
              category: "safety",
              code: "SMELT_OUTPUT_UNEXPECTED",
              message: "The furnace produced an output outside this batch",
              retryable: false,
              failedAt: "smelt_item",
              confirmedState: { output: outputSlot.itemName },
            });
          }
          const currentInput = readFurnaceSlot(
            furnace.inputItem?.bind(furnace),
          );
          if (
            !currentInput.known ||
            (currentInput.itemName === target.input &&
              (currentInput.count ?? 0) >= boundInputCount)
          ) {
            throw new AppError({
              category: "safety",
              code: "SMELT_OUTPUT_NOT_BOUND",
              message:
                "The furnace output was not linked to consumed batch input",
              retryable: true,
              failedAt: "smelt_item",
            });
          }
          await furnace.takeOutput();
        }
      }
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      try {
        if (batchStarted && !batchCompleted) {
          await reclaimOwnedFurnaceBatch(furnace, {
            input: target.input,
            fuel: fuelItem.name,
            output: target.output,
          });
        }
      } catch (error) {
        cleanupError = error;
        this.logger.error(
          { code: "SMELT_BATCH_CLEANUP_UNVERIFIED" },
          "bot-owned furnace batch could not be reclaimed",
        );
      } finally {
        try {
          furnace.close();
        } catch {
          // Mineflayer's close() is synchronous; cleanup already checked slots.
        }
      }
    }
    if (cleanupError !== undefined) {
      throw new AppError(
        {
          category: "safety",
          code: "SMELT_BATCH_CLEANUP_UNVERIFIED",
          message: "The bot-owned furnace batch could not be verified empty",
          retryable: false,
          failedAt: "smelt_item",
        },
        { cause: cleanupError },
      );
    }
    if (operationFailed) throw operationError;
    const after = await this.observe();
    const baseline =
      before.inventory.find((entry) => entry.name === target.output)?.count ??
      0;
    const produced = Math.max(
      0,
      (after.inventory.find((entry) => entry.name === target.output)?.count ??
        0) - baseline,
    );
    if (produced > target.count) {
      throw new AppError({
        category: "safety",
        code: "SMELT_OUTPUT_EXCEEDS_BOUND",
        message: "The observed output exceeds the authorized batch",
        retryable: false,
        failedAt: "smelt_item",
        confirmedState: { requested: target.count, observed: produced },
      });
    }
    if (produced < target.count) {
      throw new AppError({
        category: "inventory",
        code: "SMELT_OUTPUT_NOT_VERIFIED",
        message: "Smelting finished without the requested inventory delta",
        retryable: true,
        failedAt: "smelt_item",
        confirmedState: { requested: target.count, produced },
      });
    }
    return produced;
  }

  public async collectDropsNear(
    position: Position,
    itemName: string,
    expectedInventoryCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.options.collectTimeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal, "collect_drop");
      const current = await this.observe();
      const count =
        current.inventory.find((item) => item.name === itemName)?.count ?? 0;
      if (count >= expectedInventoryCount) return;
      const itemPosition = nearestItemDropPosition(
        position,
        itemName,
        Object.values(this.requireBot().entities).map((entity) => ({
          itemName: droppedItemName(entity),
          position: positionOf(entity.position),
        })),
      );
      if (itemPosition !== undefined) {
        await this.runPathfinder(
          new goals.GoalNear(itemPosition.x, itemPosition.y, itemPosition.z, 1),
          signal,
        );
      }
      await delay(200, signal);
    }
    throw new AppError({
      category: "inventory",
      code: "DROP_NOT_COLLECTED",
      message:
        "The expected item drop was not observed in inventory before timeout",
      retryable: true,
      failedAt: "collect_drop",
    });
  }

  public async eatBestFood(signal: AbortSignal): Promise<string> {
    throwIfAborted(signal, "eat");
    const bot = this.requireBot();
    const food = bot.inventory
      .items()
      .filter(
        (item) =>
          bot.registry.foodsByName[item.name] !== undefined &&
          !unsafeFoods.has(item.name),
      )
      .sort(
        (left, right) =>
          (bot.registry.foodsByName[right.name]?.effectiveQuality ?? 0) -
          (bot.registry.foodsByName[left.name]?.effectiveQuality ?? 0),
      )[0];
    if (food === undefined) {
      throw new AppError({
        category: "inventory",
        code: "NO_SAFE_FOOD",
        message: "No recognized food is available in inventory",
        retryable: false,
        failedAt: "eat",
      });
    }
    await bot.equip(food, "hand");
    throwIfAborted(signal, "eat");
    await bot.consume();
    return food.name;
  }

  public async attackHostile(
    entityId: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal, "hostile_attack");
    const bot = this.requireBot();
    const weapon = bot.inventory
      .items()
      .find((item) =>
        /^(?:wooden|stone|iron|golden|diamond|netherite)_(?:sword|axe)$/u.test(
          item.name,
        ),
      );
    if (weapon === undefined) {
      throw new AppError({
        category: "safety",
        code: "HOSTILE_ATTACK_WEAPON_MISSING",
        message: "No safe melee weapon is available",
        retryable: false,
        failedAt: "hostile_attack",
      });
    }
    await bot.equip(weapon, "hand");

    const deaths = new Set<number>();
    const onDeath = (entity: { readonly id: number }): void => {
      deaths.add(entity.id);
    };
    bot.on("entityDead", onDeath);
    try {
      for (let hit = 0; hit < 6 && !deaths.has(entityId); hit += 1) {
        throwIfAborted(signal, "hostile_attack");
        const entity = bot.entities[entityId];
        const name = entity?.name ?? entity?.displayName ?? entity?.type;
        const physics = bot.entity as unknown as {
          isInWater?: boolean;
          isInLava?: boolean;
          onFire?: boolean;
        };
        if (
          entity === undefined ||
          !["zombie", "husk", "zombie_villager"].includes(name ?? "") ||
          bot.entity.position.distanceTo(entity.position) > 3 ||
          bot.health < 16 ||
          bot.food < 8 ||
          physics.isInWater === true ||
          physics.isInLava === true ||
          physics.onFire === true ||
          Object.values(bot.entities).some(
            (other) =>
              other.id !== entityId &&
              other.id !== bot.entity.id &&
              other.name !== "item" &&
              other.name !== "experience_orb" &&
              bot.entity.position.distanceTo(other.position) <= 4,
          )
        ) {
          return false;
        }
        await bot.lookAt(entity.position.offset(0, 1, 0), true);
        if (bot.entityAtCursor(3.5)?.id !== entityId) return false;
        throwIfAborted(signal, "hostile_attack");
        bot.attack(entity);
        await delay(800, signal);
      }
      return deaths.has(entityId);
    } finally {
      bot.off("entityDead", onDeath);
    }
  }

  public async equipAvailableArmor(
    signal: AbortSignal,
  ): Promise<ArmorEquipResult> {
    throwIfAborted(signal, "equip_armor");
    const bot = this.requireBot();
    const choices = recommendArmor(await this.observe());
    const equipped: ArmorSlot[] = [];
    let failed = false;
    for (const choice of choices) {
      throwIfAborted(signal, "equip_armor");
      const physics = bot.entity as unknown as {
        isInWater?: boolean;
        isInLava?: boolean;
        onFire?: boolean;
      };
      const threatClose = Object.values(bot.entities).some(
        (entity) =>
          isHostileEntity(
            entity.name ?? entity.displayName ?? entity.type,
            entity.type,
            bot.registry,
          ) && bot.entity.position.distanceTo(entity.position) < 6,
      );
      if (
        threatClose ||
        physics.isInWater === true ||
        physics.isInLava === true ||
        physics.onFire === true
      ) {
        failed = true;
        break;
      }
      const slotIndex = bot.getEquipmentDestSlot(choice.slot);
      if (bot.inventory.slots[slotIndex] !== null) {
        failed = true;
        continue;
      }
      const item = bot.inventory
        .items()
        .find((candidate) => candidate.name === choice.itemName);
      if (item === undefined) {
        failed = true;
        continue;
      }
      try {
        await bot.equip(item, choice.slot);
        throwIfAborted(signal, "equip_armor");
        const equippedItem = bot.inventory.slots[slotIndex] as {
          readonly name: string;
        } | null;
        if (equippedItem?.name === choice.itemName) {
          equipped.push(choice.slot);
        } else {
          failed = true;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        failed = true;
      }
    }
    return { equipped, failed };
  }

  public async retreatFromHostiles(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal, "hostile_retreat");
    const bot = this.requireBot();
    const origin = positionOf(bot.entity.position);
    const threats = Object.values(bot.entities)
      .filter(
        (entity) =>
          isHostileEntity(
            entity.name ?? entity.displayName ?? entity.type,
            entity.type,
            bot.registry,
          ) && bot.entity.position.distanceTo(entity.position) <= 32,
      )
      .map((entity) => positionOf(entity.position));
    const target = escapeTarget(origin, threats, 8);
    if (target === undefined) {
      throw new AppError({
        category: "observation",
        code: "HOSTILE_RETREAT_TARGET_MISSING",
        message: "No hostile target remains observable",
        retryable: false,
        failedAt: "hostile_retreat",
      });
    }
    await this.runPathfinder(
      new goals.GoalNear(target.x, target.y, target.z, 2),
      signal,
    );
  }

  public async escapeDanger(
    mode: EscapeMode,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "escape");
    const bot = this.requireBot();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    if (mode === "environment") {
      const observed = await this.observe();
      if (observed.inWater && observed.oxygenState !== "normal") {
        // One second of generic jumping cannot reach air from a shallow
        // water column. Stop starting new ascent steps after four seconds;
        // one final confirmation may take the total to five seconds.
        const ascentDeadline = Date.now() + 4_000;
        bot.setControlState("jump", true);
        try {
          while (Date.now() < ascentDeadline) {
            await delay(Math.min(250, ascentDeadline - Date.now()), signal);
            const surfaced = await this.observe();
            if (!surfaced.inWater) {
              bot.clearControlStates();
              await delay(1_000, signal);
              if (!(await this.observe()).inWater) return;
              if (Date.now() < ascentDeadline)
                bot.setControlState("jump", true);
            }
            if (surfaced.oxygenState === "normal") break;
          }
        } finally {
          bot.clearControlStates();
        }
        const afterAscent = await this.observe();
        if (!afterAscent.inWater) return;
        const origin = afterAscent.position;
        const hostiles = afterAscent.nearbyEntities
          .filter((entity) => entity.hostile && entity.distance <= 12)
          .map((entity) => entity.position);
        const radius = afterAscent.oxygenState === "normal" ? 7 : 3;
        const candidates = observedShoreCandidates(
          origin,
          (position) =>
            bot.blockAt(new Vec3(position.x, position.y, position.z)),
          hostiles,
          radius,
        );
        if (candidates.length === 0) {
          throw new AppError({
            category: "safety",
            code: "SHORE_NOT_OBSERVED",
            message: "No nearby dry shore is observable after surfacing",
            retryable: true,
            failedAt: "water_escape",
          });
        }
        const planningMovements = new ObservedShoreMovements(
          bot,
          origin,
          radius,
        );
        const shoreDeadline =
          Date.now() + (afterAscent.oxygenState === "normal" ? 5_000 : 2_000);
        for (const candidate of candidates) {
          throwIfAborted(signal, "water_escape");
          if (Date.now() >= shoreDeadline) break;
          const beforePlanning = await this.observe();
          if (
            beforePlanning.health < afterAscent.health ||
            (beforePlanning.inWater && beforePlanning.oxygenState !== "normal")
          ) {
            throw new AppError({
              category: "safety",
              code: "SHORE_NOT_REACHED",
              message: "Health or air became unsafe before reaching shore",
              retryable: true,
              failedAt: "water_escape",
            });
          }
          const goal = new goals.GoalBlock(
            candidate.x,
            candidate.y,
            candidate.z,
          );
          const planned = (
            bot.pathfinder
              .getPathFromTo(planningMovements, bot.entity.position, goal, {
                optimizePath: false,
                timeout: Math.min(this.options.pathfinderThinkTimeoutMs, 700),
                searchRadius: radius + 2,
              })
              .next().value as
              | {
                  readonly result: {
                    readonly status: string;
                    readonly path: Move[];
                  };
                }
              | undefined
          )?.result;
          if (planned?.status !== "success" || planned.path.length === 0)
            continue;
          const previousMovements = bot.pathfinder.movements;
          const approvedNodes = new Set(planned.path.map(descentNodeKey));
          try {
            bot.pathfinder.setMovements(
              new ObservedShoreMovements(bot, origin, radius, approvedNodes),
            );
            await this.runShorePathfinder(
              goal,
              signal,
              shoreDeadline,
              afterAscent.health,
            );
          } catch (error) {
            if (signal.aborted) throw error;
            if (
              error instanceof AppError &&
              error.detail.code === "SHORE_NOT_REACHED"
            )
              throw error;
            continue;
          } finally {
            bot.pathfinder.setGoal(null);
            bot.pathfinder.setMovements(previousMovements);
            bot.clearControlStates();
          }
          await delay(750, signal);
          const after = await this.observe();
          // The coordinator separately confirms oxygen and health recovery.
          if (!after.inWater) return;
        }
        throw new AppError({
          category: "safety",
          code: "SHORE_NOT_REACHED",
          message: "No observed dry shore could be reached and confirmed",
          retryable: true,
          failedAt: "water_escape",
        });
      }
    }
    const target =
      mode === "hostile"
        ? escapeTarget(
            positionOf(bot.entity.position),
            Object.values(bot.entities)
              .filter(
                (entity) =>
                  isHostileEntity(
                    entity.name ?? entity.displayName ?? entity.type,
                    entity.type,
                    bot.registry,
                  ) && bot.entity.position.distanceTo(entity.position) <= 32,
              )
              .map((entity) => positionOf(entity.position)),
          )
        : undefined;
    if (target !== undefined) {
      await bot.lookAt(new Vec3(target.x, target.y + 1.6, target.z), true);
    }
    throwIfAborted(signal, "escape");
    bot.setControlState("jump", true);
    bot.setControlState("sprint", true);
    bot.setControlState("forward", true);
    try {
      await delay(
        mode === "hostile" && target !== undefined ? 2_500 : 1_000,
        signal,
      );
    } finally {
      bot.clearControlStates();
    }
  }

  public async recoverFromStuck(
    maxAttempts: number,
    signal: AbortSignal,
  ): Promise<void> {
    const bot = this.requireBot();
    const start = bot.entity.position.clone();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted(signal, "stuck_recovery");
      await this.stopCurrentAction();
      bot.setControlState("jump", true);
      bot.setControlState(attempt % 2 === 0 ? "left" : "right", true);
      bot.setControlState(attempt === maxAttempts ? "back" : "forward", true);
      try {
        await delay(350, signal);
      } finally {
        bot.clearControlStates();
      }
      if (bot.entity.position.distanceTo(start) >= 0.5) return;
    }
    throw new AppError({
      category: "path",
      code: "PATH_STUCK",
      message: "The bot remained stuck after the configured recovery attempts",
      retryable: false,
      failedAt: "stuck_recovery",
      confirmedState: { maxAttempts },
    });
  }

  public async stopCurrentAction(): Promise<void> {
    const bot = this.botInstance;
    if (bot === undefined) return;
    bot.pathfinder.setGoal(null);
    bot.stopDigging();
    bot.clearControlStates();
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  }

  private requireBot(): Bot {
    if (this.botInstance === undefined || !this.spawned) {
      throw new AppError({
        category: "connection",
        code: "MINECRAFT_NOT_CONNECTED",
        message: "Minecraft bot is not connected and spawned",
        retryable: true,
      });
    }
    return this.botInstance;
  }

  private async runShorePathfinder(
    goal: PathfinderGoals.Goal,
    signal: AbortSignal,
    deadline: number,
    baselineHealth: number,
  ): Promise<void> {
    const unsafeAbort = new AbortController();
    const traversalSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      unsafeAbort.signal,
    ]);
    const unsafeVitals = { detected: false };
    const vitalsTimer = setInterval(() => {
      if (traversalSignal.aborted) return;
      void this.observe()
        .then((vitals) => {
          if (traversalSignal.aborted) return;
          if (
            vitals.health < baselineHealth ||
            (vitals.inWater && vitals.oxygenState !== "normal")
          ) {
            unsafeVitals.detected = true;
            unsafeAbort.abort();
          }
        })
        .catch(() => {
          if (traversalSignal.aborted) return;
          unsafeVitals.detected = true;
          unsafeAbort.abort();
        });
    }, 250);
    try {
      await this.runPathfinder(goal, traversalSignal);
    } catch (error) {
      if (unsafeVitals.detected) {
        throw new AppError({
          category: "safety",
          code: "SHORE_NOT_REACHED",
          message: "Health or air became unsafe while moving to shore",
          retryable: true,
          failedAt: "water_escape",
        });
      }
      throw error;
    } finally {
      clearInterval(vitalsTimer);
      unsafeAbort.abort();
    }
  }

  private async runPathfinder(
    goal: PathfinderGoals.Goal,
    signal: AbortSignal,
  ): Promise<void> {
    const bot = this.requireBot();
    const abort = (): void => {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
    };
    const rejectOnAbort = (
      _event: Event,
      reject: (reason?: unknown) => void,
    ): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Pathfinding cancelled"),
      );
    };
    let abortRejection: ((event: Event) => void) | undefined;
    signal.addEventListener("abort", abort, { once: true });
    try {
      throwIfAborted(signal, "pathfinder");
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise<never>((_, reject) => {
          abortRejection = (event) => rejectOnAbort(event, reject);
          signal.addEventListener("abort", abortRejection, { once: true });
        }),
      ]);
      throwIfAborted(signal, "pathfinder");
    } catch (error) {
      if (signal.aborted) throwIfAborted(signal, "pathfinder");
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      throw new AppError(
        {
          category: "path",
          code: "PATHFINDER_FAILED",
          message: error instanceof Error ? error.message : "Pathfinder failed",
          retryable: true,
          failedAt: "pathfinder",
        },
        { cause: error },
      );
    } finally {
      signal.removeEventListener("abort", abort);
      if (abortRejection !== undefined) {
        signal.removeEventListener("abort", abortRejection);
      }
    }
  }
}

function findCraftingTable(bot: Bot, maxDistance: number): unknown {
  const tableId = bot.registry.blocksByName.crafting_table?.id;
  if (tableId === undefined) return null;
  return bot.findBlock({ matching: tableId, maxDistance, count: 1 });
}

function readFurnaceSlot(
  reader:
    | (() => { readonly name: string; readonly count: number } | null)
    | undefined,
): FurnaceSlotState {
  if (reader === undefined) return { known: false };
  try {
    const item = reader();
    if (item === null) return { known: true };
    if (
      typeof item.name !== "string" ||
      !Number.isFinite(item.count) ||
      item.count < 0
    ) {
      return { known: false };
    }
    return { known: true, itemName: item.name, count: item.count };
  } catch {
    return { known: false };
  }
}

async function reclaimOwnedFurnaceBatch(
  furnace: {
    inputItem?(): { readonly name: string; readonly count: number } | null;
    fuelItem?(): { readonly name: string; readonly count: number } | null;
    outputItem?(): { readonly name: string; readonly count: number } | null;
    takeInput(): Promise<unknown>;
    takeFuel(): Promise<unknown>;
    takeOutput(): Promise<unknown>;
  },
  expected: {
    readonly input: string;
    readonly fuel: string;
    readonly output: string;
  },
): Promise<void> {
  // This window was observed empty before depositing. Remove the input first so
  // an aborted task cannot keep smelting while the remaining slots are drained.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const [name, reader, take] of [
      ["input", furnace.inputItem?.bind(furnace), () => furnace.takeInput()],
      ["output", furnace.outputItem?.bind(furnace), () => furnace.takeOutput()],
      ["fuel", furnace.fuelItem?.bind(furnace), () => furnace.takeFuel()],
    ] as const) {
      const slot = readFurnaceSlot(reader);
      if (
        !slot.known ||
        (slot.itemName !== undefined && slot.itemName !== expected[name])
      ) {
        throw new Error(`Furnace ${name} slot is not the bot-owned batch`);
      }
      if (slot.itemName !== undefined) {
        try {
          await take();
        } catch {
          // A slot can change as the server finishes an in-flight smelt.
          // Re-read it before deciding that cleanup failed.
        }
      }
    }
    await delay(50);
    if (
      furnaceBatchReadiness({
        input: readFurnaceSlot(furnace.inputItem?.bind(furnace)),
        fuel: readFurnaceSlot(furnace.fuelItem?.bind(furnace)),
        output: readFurnaceSlot(furnace.outputItem?.bind(furnace)),
      }).allowed
    )
      return;
  }
  throw new Error("The bot-owned furnace batch remains in a slot");
}

function droppedItemName(entity: {
  getDroppedItem(): { readonly name: string } | null;
}): string | undefined {
  try {
    return entity.getDroppedItem()?.name;
  } catch {
    return undefined;
  }
}
