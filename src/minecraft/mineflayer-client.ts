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
import type { MinecraftLogger, MinecraftPort, ResourceTarget } from "./port.js";

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
          (player as { readonly entity?: unknown }).entity !== undefined,
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

  public async findResources(
    names: readonly string[],
    maxDistance: number,
    count: number,
  ): Promise<readonly ResourceTarget[]> {
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
    return bot
      .findBlocks({ matching: ids, maxDistance, count })
      .map((position) => bot.blockAt(position))
      .filter(
        (block): block is NonNullable<typeof block> =>
          block !== null && names.includes(block.name),
      )
      .map((block) => ({
        name: block.name,
        position: positionOf(block.position),
      }));
  }

  public async dig(target: ResourceTarget, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal, "dig");
    const bot = this.requireBot();
    const block = bot.blockAt(
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
    const abort = (): void => bot.stopDigging();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await bot.dig(block, true, "raycast");
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
      const itemEntity = Object.values(this.requireBot().entities)
        .filter((entity) => entity.name === "item" || entity.type === "object")
        .sort(
          (left, right) =>
            left.position.distanceTo(
              new Vec3(position.x, position.y, position.z),
            ) -
            right.position.distanceTo(
              new Vec3(position.x, position.y, position.z),
            ),
        )[0];
      if (itemEntity !== undefined) {
        await this.runPathfinder(
          new goals.GoalNear(
            itemEntity.position.x,
            itemEntity.position.y,
            itemEntity.position.z,
            1,
          ),
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

  public async escapeDanger(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal, "escape");
    const bot = this.requireBot();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.setControlState("jump", true);
    bot.setControlState("sprint", true);
    bot.setControlState("forward", true);
    try {
      await delay(1_000, signal);
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
