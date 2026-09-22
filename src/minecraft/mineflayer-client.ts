import mineflayer, { type Bot, type BotOptions } from "mineflayer";
import pathfinderPackage, {
  Movements,
  pathfinder,
} from "mineflayer-pathfinder";
import type { goals as PathfinderGoals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { AppError } from "../domain/errors.js";
import {
  distance,
  type EntityObservation,
  type Position,
  type SurroundingsObservation,
  type WorldSnapshot,
} from "../domain/snapshot.js";
import { throwIfAborted } from "../runtime/cancellation.js";
import { delay } from "../runtime/timeout.js";
import type {
  EscapeMode,
  MinecraftLogger,
  MinecraftPort,
  ResourceTarget,
} from "./port.js";
import {
  actionGuardChannel,
  queryActionGuard,
  requireActionPermission,
} from "./action-guard.js";
import type {
  CollectItemInput,
  CraftItemInput,
  GeneralActionCandidate,
  GeneralActionObservationInput,
  MineBlockInput,
  PlaceBlockInput,
  SmeltItemInput,
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

const hostileNames = new Set([
  "blaze",
  "cave_spider",
  "creeper",
  "drowned",
  "enderman",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager",
]);

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

export class MineflayerClient implements MinecraftPort {
  private botInstance: Bot | undefined;
  private spawned = false;
  private intentionalDisconnect = false;
  private readonly chatListeners = new Set<
    (username: string, message: string) => void
  >();
  private readonly disconnectListeners = new Set<(reason: string) => void>();

  public constructor(
    private readonly options: MineflayerClientOptions,
    private readonly logger: MinecraftLogger,
  ) {}

  public async connect(signal?: AbortSignal): Promise<void> {
    if (this.spawned) return;
    this.intentionalDisconnect = false;
    const bot = mineflayer.createBot(this.options.bot);
    bot.loadPlugin(pathfinder);
    this.botInstance = bot;
    bot.on("chat", (username, message) => {
      for (const listener of this.chatListeners) listener(username, message);
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
        bot.off("spawn", onSpawn);
        bot.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
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
        const movements = new Movements(bot);
        movements.canDig = false;
        movements.allow1by1towers = false;
        movements.allowParkour = false;
        movements.maxDropDown = 2;
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

  public onDisconnected(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public async observe(): Promise<WorldSnapshot> {
    const bot = this.requireBot();
    const botPosition = positionOf(bot.entity.position);
    const inventory = new Map<string, number>();
    for (const item of bot.inventory.items())
      inventory.set(item.name, (inventory.get(item.name) ?? 0) + item.count);

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
          hostile: hostileNames.has(name),
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
    return {
      observedAt: new Date().toISOString(),
      connected: true,
      spawned: this.spawned,
      dimension: bot.game.dimension,
      position: botPosition,
      velocityY: bot.entity.velocity.y,
      health: bot.health,
      food: bot.food,
      oxygen: bot.oxygenLevel,
      onFire: physicsState.onFire ?? false,
      inWater:
        physicsState.isInWater ?? blockNames.some((name) => name === "water"),
      inLava:
        physicsState.isInLava ?? blockNames.some((name) => name === "lava"),
      suffocating:
        head !== null &&
        !["air", "cave_air", "void_air", "water", "lava"].includes(head.name) &&
        head.boundingBox === "block",
      inventory: [...inventory].map(([name, count]) => ({ name, count })),
      players,
      nearbyEntities,
    };
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
              hostile: hostileNames.has(name),
            };
          })
          .sort((left, right) => left.distance - right.distance)
          .slice(0, 64)
      : [];
    const snapshot = await this.observe();
    const hazards = [
      ...(snapshot.inLava ? ["lava"] : []),
      ...(snapshot.onFire ? ["fire"] : []),
      ...(snapshot.oxygen <= 5 ? ["low_oxygen"] : []),
      ...(entities.some((entity) => entity.hostile) ? ["hostile_entity"] : []),
    ];
    return { observedAt: snapshot.observedAt, blocks, entities, hazards };
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
    await this.runPathfinder(
      new goals.GoalNear(position.x, position.y, position.z, range),
      signal,
    );
    const snapshot = await this.observe();
    if (distance(snapshot.position, position) > range + 0.75) {
      throw new AppError({
        category: "path",
        code: "MOVE_VERIFICATION_FAILED",
        message:
          "Pathfinder completed but the observed position is outside the goal",
        retryable: true,
        failedAt: "move_to",
      });
    }
    bot.clearControlStates();
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
        bot.on("path_update", onPathUpdate);
        bot.on("path_reset", onPathReset);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish();
        else bot.pathfinder.setGoal(goal, true);
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
      if (candidates.length < input.maxCandidates) {
        candidates.push({ ...candidate, order: candidates.length });
      }
    };

    for (const block of surrounding.blocks) {
      if (candidates.length >= input.maxCandidates) break;
      const target: ResourceTarget = {
        name: block.name,
        position: block.position,
      };
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
                  position: block.position,
                },
                signal,
              ),
        );
      } catch {
        permission = "unknown";
      }
      add({
        id: generalCandidateId("mine_block", block.name, block.position),
        label: `${block.name}を採掘`,
        action: "mine_block",
        args: { name: block.name, position: block.position },
        steps: [
          {
            tool: "mine_block",
            input: { name: block.name, position: block.position },
          },
        ],
        observed: true,
        purposeFit: requested.has(block.name) ? "direct" : "unknown",
        permission,
        safety: generalPermissionSafety(permission, surrounding.hazards),
        reversible: false,
        impact: "medium",
        operationClass: "natural_resource",
        requestedCount: 1,
        resourceName: block.name,
        distance: block.distance,
      });
    }

    const inventory = new Map<string, number>();
    for (const item of bot.inventory.items()) {
      inventory.set(item.name, (inventory.get(item.name) ?? 0) + item.count);
    }
    const craftingTable = findCraftingTable(bot, input.radius);
    for (const itemName of requested) {
      if (candidates.length >= input.maxCandidates) break;
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
        if (candidates.length >= input.maxCandidates) break;
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
          purposeFit: requested.has(itemName) ? "direct" : "unknown",
          permission,
          safety: generalPermissionSafety(permission, surrounding.hazards),
          reversible: false,
          impact: "medium",
          operationClass: "world_change",
          requestedCount: 1,
          scopeId: "observed-placement",
          distance: bot.entity.position.distanceTo(placePosition),
        });
      }
    }

    for (const entity of surrounding.entities) {
      if (candidates.length >= input.maxCandidates) break;
      const itemName = droppedItemName(
        entity as unknown as Parameters<typeof droppedItemName>[0],
      );
      if (itemName === undefined) continue;
      const permission: GeneralActionCandidate["permission"] = "allowed";
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
        purposeFit: requested.has(itemName) ? "direct" : "unknown",
        permission,
        safety: generalPermissionSafety(permission, surrounding.hazards),
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        requestedCount: 1,
        resourceName: itemName,
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
      if (candidates.length >= input.maxCandidates || furnace === null) break;
      const inputName = smeltingRecipes[output];
      if (inputName === undefined || (inventory.get(inputName) ?? 0) < 1)
        continue;
      const position = positionOf(furnace.position);
      const permission: GeneralActionCandidate["permission"] = "allowed";
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
        distance: bot.entity.position.distanceTo(furnace.position),
      });
    }
    return candidates;
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
    const before = await this.observe();
    await craft.call(bot, recipe, target.count, craftingTable);
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
        takeOutput(): Promise<void>;
        close(): Promise<void>;
      }>;
    };
    const inputItem = bot.registry.itemsByName[target.input];
    const fuelItem =
      bot.registry.itemsByName.coal ?? bot.registry.itemsByName.charcoal;
    if (
      typedBot.openFurnace === undefined ||
      inputItem === undefined ||
      fuelItem === undefined
    ) {
      throw new AppError({
        category: "resource",
        code: "SMELT_UNAVAILABLE",
        message: "The furnace or safe fuel contract is unavailable",
        retryable: false,
        failedAt: "smelt_item",
      });
    }
    const before = await this.observe();
    const furnace = await typedBot.openFurnace(furnaceBlock);
    try {
      await furnace.putInput(inputItem.id, null, target.count);
      await furnace.putFuel(fuelItem.id, null, target.count);
      const deadline = Date.now() + this.options.collectTimeoutMs;
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
        if (count - baseline >= target.count) return count - baseline;
        await furnace.takeOutput();
      }
    } finally {
      await furnace.close().catch(() => undefined);
    }
    const after = await this.observe();
    const baseline =
      before.inventory.find((entry) => entry.name === target.output)?.count ??
      0;
    const produced = Math.max(
      0,
      (after.inventory.find((entry) => entry.name === target.output)?.count ??
        0) - baseline,
    );
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

  public async escapeDanger(
    mode: EscapeMode,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "escape");
    const bot = this.requireBot();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    const target =
      mode === "hostile"
        ? escapeTarget(
            positionOf(bot.entity.position),
            Object.values(bot.entities)
              .filter(
                (entity) =>
                  hostileNames.has(
                    entity.name ?? entity.displayName ?? entity.type,
                  ) && bot.entity.position.distanceTo(entity.position) <= 8,
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

function droppedItemName(entity: {
  getDroppedItem(): { readonly name: string } | null;
}): string | undefined {
  try {
    return entity.getDroppedItem()?.name;
  } catch {
    return undefined;
  }
}
