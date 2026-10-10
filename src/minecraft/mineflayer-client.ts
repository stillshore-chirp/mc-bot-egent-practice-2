import mineflayer, { type Bot, type BotOptions } from "mineflayer";
import { states } from "minecraft-protocol";
import { pathfinder } from "mineflayer-pathfinder";
import { AppError } from "../domain/errors.js";
import { sameMinecraftIdentity } from "../domain/minecraft-identity.js";
import { MineflayerPlayerBody, type PlayerBody } from "./player-body.js";

export interface MineflayerClientOptions {
  readonly bot: BotOptions;
  readonly ownerUsername: string;
}

interface ConnectionLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

type MovementPacketKind = "position" | "position_look" | "look";

interface MovementPacketFiniteState {
  readonly kind: MovementPacketKind;
  readonly positionFinite: boolean | null;
  readonly rotationFinite: boolean | null;
}

function movementPacketFiniteState(
  name: unknown,
  payload: unknown,
): MovementPacketFiniteState | undefined {
  if (name !== "position" && name !== "position_look" && name !== "look")
    return undefined;
  const packet =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const finite = (value: unknown): boolean =>
    typeof value === "number" && Number.isFinite(value);
  return {
    kind: name,
    positionFinite:
      name === "look"
        ? null
        : finite(packet.x) && finite(packet.y) && finite(packet.z),
    rotationFinite:
      name === "position" ? null : finite(packet.yaw) && finite(packet.pitch),
  };
}

function guardMovementPacketWrites(
  bot: Bot,
  logger: ConnectionLogger | undefined,
  isSpawned: () => boolean,
): void {
  const client = bot._client;
  // Forward writes with the original caller receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const write = client.write;
  if (typeof write !== "function") return;
  const warnedKinds = new Set<MovementPacketKind>();
  client.write = new Proxy(write, {
    apply(target, thisArg, args) {
      const finiteState = movementPacketFiniteState(args[0], args[1]);
      if (
        finiteState !== undefined &&
        (finiteState.positionFinite === false ||
          finiteState.rotationFinite === false)
      ) {
        if (!warnedKinds.has(finiteState.kind)) {
          warnedKinds.add(finiteState.kind);
          logger?.warn(
            {
              packetKind: finiteState.kind,
              positionFinite: finiteState.positionFinite,
              rotationFinite: finiteState.rotationFinite,
              clientPlayState: client.state === states.PLAY,
              spawned: isSpawned(),
            },
            "Suppressed a movement packet with non-finite values",
          );
        }
        return;
      }
      Reflect.apply(target, thisArg, args);
    },
  });
}

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
  if (
    typeof candidate.entityId !== "number" ||
    !Number.isInteger(candidate.entityId) ||
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
  return { entityId: candidate.entityId, metadata };
}

/**
 * Mineflayer can receive air supply for another entity. Only accept the
 * bot's own air-supply metadata; an invalid own value is explicitly unknown.
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
  const oxygen = Math.ceil(airSupply.value / 15);
  return Number.isFinite(oxygen) && oxygen >= 0 && oxygen <= 20 ? oxygen : null;
}

export class MineflayerClient {
  private botInstance: Bot | undefined;
  private playerBodyInstance: MineflayerPlayerBody | undefined;
  private connecting: Promise<void> | undefined;
  private spawned = false;
  private intentionalDisconnect = false;
  private connectionEpoch = 0;
  private authoritativeOxygen: number | null | undefined;
  private readonly chatListeners = new Set<
    (username: string, message: string) => void
  >();
  private readonly disconnectListeners = new Set<(reason: string) => void>();

  public constructor(
    private readonly options: MineflayerClientOptions,
    private readonly logger?: ConnectionLogger,
  ) {}

  public get isConnected(): boolean {
    return this.spawned && this.botInstance !== undefined;
  }

  public createPlayerBody(): PlayerBody {
    this.playerBodyInstance ??= new MineflayerPlayerBody(
      () => this.requireBot(),
      this.options.ownerUsername,
      () => this.authoritativeOxygen ?? null,
    );
    if (this.botInstance !== undefined)
      this.playerBodyInstance.attach(this.botInstance);
    return this.playerBodyInstance;
  }

  public connect(signal?: AbortSignal): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    if (this.connecting !== undefined) return this.connecting;
    const connecting = this.connectOnce(signal).finally(() => {
      if (this.connecting === connecting) this.connecting = undefined;
    });
    this.connecting = connecting;
    return connecting;
  }

  private async connectOnce(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Minecraft connection cancelled");
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
    const connectionEpoch = ++this.connectionEpoch;
    const botOptions: BotOptions & {
      readonly respawnPositionDelayMs?: number;
    } =
      this.options.bot.version === "26.1"
        ? // The 26.1 bridge needs immediate position correction after respawn.
          { ...this.options.bot, respawnPositionDelayMs: 0 }
        : this.options.bot;
    const bot = mineflayer.createBot(botOptions);
    this.botInstance = bot;
    this.spawned = false;
    this.authoritativeOxygen = undefined;
    guardMovementPacketWrites(bot, this.logger, () => this.spawned);
    bot.loadPlugin(pathfinder);
    this.playerBodyInstance?.attach(bot);

    const sendsPlayerLoadedPacket = bot.supportFeature(
      "sendsPlayerLoadedPacket",
    );
    const sendsClientTickEndPacket = bot.supportFeature(
      "sendsClientTickEndPacket",
    );
    const usesNamedMetadata = bot.supportFeature("mcDataHasEntityMetadata");
    let connectionOpen = true;
    let connectSettled = false;
    let spawnGeneration = 0;
    let invalidatePendingSpawn: (() => void) | undefined;
    let rejectPendingConnect: ((reason: string) => void) | undefined;

    const isCurrentConnection = (): boolean =>
      this.botInstance === bot &&
      this.connectionEpoch === connectionEpoch &&
      connectionOpen;
    const invalidateSpawnWork = (): void => {
      spawnGeneration += 1;
    };
    const onPhysicsTick = (): void => {
      if (
        !sendsClientTickEndPacket ||
        !isCurrentConnection() ||
        this.intentionalDisconnect ||
        bot._client.state !== states.PLAY
      )
        return;
      // Close the previous physics tick before the next movement packet.
      bot._client.write("tick_end", {});
    };
    if (sendsClientTickEndPacket) bot.on("physicsTick", onPhysicsTick);

    bot._client.on("entity_metadata", (packet) => {
      if (!isCurrentConnection()) return;
      const metadataPacket = parseEntityMetadataPacket(packet as unknown);
      if (metadataPacket === undefined) return;
      const entityValue: unknown = Reflect.get(bot, "entity");
      if (typeof entityValue !== "object" || entityValue === null) return;
      const botEntity = entityValue as Bot["entity"];
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
      if (!isCurrentConnection() || this.intentionalDisconnect) return;
      if (
        sameMinecraftIdentity(username, bot.username) ||
        sameMinecraftIdentity(username, this.options.bot.username)
      )
        return;
      for (const listener of this.chatListeners) listener(username, message);
    });

    bot.on("end", (reason) => {
      bot.off("physicsTick", onPhysicsTick);
      if (this.botInstance !== bot || this.connectionEpoch !== connectionEpoch)
        return;
      connectionOpen = false;
      invalidatePendingSpawn?.();
      this.spawned = false;
      this.authoritativeOxygen = undefined;
      this.botInstance = undefined;
      rejectPendingConnect?.(reason);
      this.logger?.warn(
        { intentional: this.intentionalDisconnect },
        "Minecraft connection ended",
      );
      for (const listener of this.disconnectListeners) listener(reason);
    });

    bot.on("kicked", (reason) => {
      this.logger?.warn(
        { reasonType: typeof reason },
        "Minecraft bot was kicked",
      );
    });

    await new Promise<void>((resolve, reject) => {
      const cleanupConnectWait = (): void => {
        bot.off("login", onLogin);
        signal?.removeEventListener("abort", onAbort);
      };
      const settleResolve = (): void => {
        if (connectSettled) return;
        connectSettled = true;
        cleanupConnectWait();
        resolve();
      };
      const settleReject = (error: Error): void => {
        if (connectSettled) return;
        connectSettled = true;
        cleanupConnectWait();
        reject(error);
      };
      rejectPendingConnect = (reason): void =>
        settleReject(
          new AppError({
            category: "connection",
            code: "MINECRAFT_CONNECT_FAILED",
            message: "Minecraft connection ended before it was ready",
            retryable: true,
            confirmedState: { reasonType: typeof reason },
          }),
        );
      invalidatePendingSpawn = invalidateSpawnWork;

      const isCurrentSpawn = (generation: number): boolean =>
        isCurrentConnection() &&
        spawnGeneration === generation &&
        !this.intentionalDisconnect;

      const onLogin = (): void => {
        if (!isCurrentConnection()) return;
        if (!sameMinecraftIdentity(bot.username, this.options.ownerUsername))
          return;
        this.intentionalDisconnect = true;
        connectionOpen = false;
        invalidateSpawnWork();
        this.spawned = false;
        settleReject(
          new AppError({
            category: "connection",
            code: "MINECRAFT_IDENTITY_CONFLICT",
            message: "Bot and owner Minecraft identities conflict",
            retryable: false,
          }),
        );
        bot.end("identity conflict");
      };

      const onSpawn = (): void => {
        if (!isCurrentConnection() || this.intentionalDisconnect) return;
        const generation = ++spawnGeneration;
        void (async () => {
          if (sendsPlayerLoadedPacket) await bot.waitForChunksToLoad();
          if (!isCurrentSpawn(generation)) return;
          if (sendsPlayerLoadedPacket) bot._client.write("player_loaded", {});
          this.spawned = true;
          settleResolve();
        })().catch((error: unknown) => {
          if (!isCurrentSpawn(generation)) return;
          connectionOpen = false;
          invalidateSpawnWork();
          this.spawned = false;
          if (!connectSettled) {
            settleReject(
              new AppError(
                {
                  category: "connection",
                  code: "MINECRAFT_CONNECT_FAILED",
                  message: "Minecraft chunks failed to load",
                  retryable: true,
                  confirmedState: {
                    errorType:
                      error instanceof Error ? error.name : typeof error,
                  },
                },
                { cause: error },
              ),
            );
          } else {
            this.logger?.warn(
              { errorType: error instanceof Error ? error.name : typeof error },
              "Minecraft respawn chunks failed to load",
            );
          }
          bot.end("chunk loading failed");
        });
      };

      const onError = (error: Error): void => {
        if (!isCurrentConnection()) return;
        connectionOpen = false;
        invalidateSpawnWork();
        this.spawned = false;
        if (!connectSettled)
          settleReject(
            new AppError(
              {
                category: "connection",
                code: "MINECRAFT_CONNECT_FAILED",
                message: "Minecraft connection failed",
                retryable: true,
                confirmedState: { errorType: error.name },
              },
              { cause: error },
            ),
          );
        bot.end("connection error");
      };

      const onAbort = (): void => {
        if (!isCurrentConnection()) return;
        this.intentionalDisconnect = true;
        connectionOpen = false;
        invalidateSpawnWork();
        this.spawned = false;
        settleReject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Minecraft connection cancelled"),
        );
        bot.end("connect cancelled");
      };

      const onRespawn = (): void => {
        if (!isCurrentConnection()) return;
        invalidateSpawnWork();
        this.spawned = false;
        this.authoritativeOxygen = undefined;
      };

      bot.once("login", onLogin);
      bot.on("spawn", onSpawn);
      bot.on("error", onError);
      bot._client.on("respawn", onRespawn);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  }

  public async disconnect(reason = "shutdown"): Promise<void> {
    this.intentionalDisconnect = true;
    this.spawned = false;
    this.authoritativeOxygen = undefined;
    this.botInstance?.end(reason);
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

  private requireBot(): Bot {
    if (this.botInstance === undefined || !this.spawned) {
      throw new AppError({
        category: "connection",
        code: "MINECRAFT_NOT_READY",
        message: "Minecraft bot is not connected and spawned",
        retryable: true,
      });
    }
    return this.botInstance;
  }
}
