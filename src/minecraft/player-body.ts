import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Bot, BotEvents } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Window } from "prismarine-windows";
import pathfinderPackage from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import {
  playerOperationSchema,
  type PlayerOperation,
  type PlayerOperationName,
} from "./player-body-schema.js";
import {
  entityEyeHeight,
  observePlayerBody,
  playerBodyLookSweepDirectionCount,
  playerBodyLookSweepSchema,
  summarizeLookSweepView,
  type BodyItemStack,
  type PlayerBodyLookSweep,
  type PlayerBodyObservation,
  type PlayerBodyObservationOptions,
} from "./player-body-observation.js";
import {
  queryPlayerKnowledge,
  type PlayerKnowledge,
} from "./player-body-knowledge.js";

export {
  isPlayerOperationName,
  playerOperationNames,
  playerOperationDescriptions,
  playerOperationSchema,
} from "./player-body-schema.js";
export type {
  PlayerOperation,
  PlayerOperationName,
} from "./player-body-schema.js";
export type {
  PlayerBodyLookSweep,
  PlayerBodyObservation,
  PlayerBodyObservationOptions,
} from "./player-body-observation.js";
export type {
  PlayerKnowledge,
  RegistryKnowledgeFact,
} from "./player-body-knowledge.js";

const { goals } = pathfinderPackage;
const bodyControls = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
] as const;
const interactRange = 4.5;
const attackRange = 3.2;
const stallCheckMs = 5_000;
const stallAfterMs = 20_000;
const minimumDigTimeoutMs = 35_000;
const digServerUpdateGraceMs = 5_000;
const placeServerUpdateGraceMs = 5_000;
const maximumDigTimeoutMs = 5 * 60_000;
const itemCollectionPollMs = 250;
// GoalNear evaluates floored block nodes; radius one includes adjacent nodes as goals.
const itemCollectionGoalRange = 1;
const itemCollectionPickupDistance = 1.25;
// Allow a bobbing item a short observation window after a path goal is reached.
const itemCollectionPickupGraceMs = 2_500;
const maximumItemCollectionTimeoutMs = 45_000;
interface LoadedPrismarineItem {
  toNotch(item: Item | null): unknown;
}

type PrismarineItemLoader = (registry: Bot["registry"]) => LoadedPrismarineItem;

const prismarineItemModule: unknown = createRequire(import.meta.url)(
  "prismarine-item",
);
if (typeof prismarineItemModule !== "function")
  throw new Error("The prismarine-item loader is unavailable");
const loadPrismarineItem = prismarineItemModule as PrismarineItemLoader;

interface WindowUpdateEventTarget {
  on(
    event: "updateSlot",
    listener: (
      slot: number,
      oldItem: Item | null,
      newItem: Item | null,
    ) => void,
  ): unknown;
  removeListener(
    event: "updateSlot",
    listener: (
      slot: number,
      oldItem: Item | null,
      newItem: Item | null,
    ) => void,
  ): unknown;
}

function slotUpdateEvents(window: Window): WindowUpdateEventTarget {
  return window;
}

function initializedInventory(bot: Bot): Bot["inventory"] | undefined {
  const inventory = (bot as unknown as { inventory?: Bot["inventory"] | null })
    .inventory;
  return inventory ?? undefined;
}

function activeWindow(bot: Bot): Window {
  return bot.currentWindow ?? bot.inventory;
}

function selectedItem(window: Window): Item | null {
  return window.selectedItem;
}

function heldItemOrNull(bot: Bot): Item | null {
  return bot.heldItem;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

export type PlayerOperationStatus =
  "successful" | "failed" | "interrupted" | "unverified";

export type PlayerItemCollectionOutcome =
  | "collected"
  | "entity_removed"
  | "target_unobservable"
  | "invalid_target"
  | "path_failed"
  | "pickup_out_of_range"
  | "deadline_expired";

export type PlayerItemCollectionPathFailureReason =
  "no_path" | "path_timeout" | "goto_rejected" | "unknown";

export interface PlayerOperationResult {
  readonly operationId: string;
  readonly operation: PlayerOperation;
  readonly status: PlayerOperationStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly before: PlayerBodyObservation | null;
  readonly after: PlayerBodyObservation | null;
  /** True when cancellation returned boundedly but Mineflayer's underlying action is unresolved. */
  readonly recoveryRequired: boolean;
  /** Server-observed effect; an attack hit and confirmed death remain distinct. */
  readonly observedEffect?: {
    readonly type: "entity_hit" | "entity_died" | "item_collected";
    readonly entityId: number;
  };
  readonly itemCollectionOutcome?: PlayerItemCollectionOutcome;
  readonly itemCollectionPathFailureReason?: PlayerItemCollectionPathFailureReason;
  readonly lookSweep?: PlayerBodyLookSweep | undefined;
  readonly detail?: string;
}

export type PlayerBodyEvent =
  | {
      readonly type: "state_changed";
      readonly at: string;
      readonly reason:
        | "vitals"
        | "inventory"
        | "entities"
        | "blocks"
        | "time"
        | "position"
        | "window";
    }
  | { readonly type: "bot_death"; readonly at: string }
  | {
      readonly type: "disconnected";
      readonly at: string;
      readonly reason: string;
    }
  | { readonly type: "reconnected"; readonly at: string }
  | {
      readonly type: "operation_started";
      readonly at: string;
      readonly operationId: string;
      readonly operation: PlayerOperationName;
    }
  | {
      readonly type: "operation_completed";
      readonly at: string;
      readonly operationId: string;
      readonly operation: PlayerOperationName;
      readonly status: Exclude<PlayerOperationStatus, "failed">;
    }
  | {
      readonly type: "operation_failed";
      readonly at: string;
      readonly operationId: string;
      readonly operation: PlayerOperationName;
      readonly detail: string;
    }
  | {
      readonly type: "operation_stalled";
      readonly at: string;
      readonly operationId: string;
      readonly operation: PlayerOperationName;
      readonly elapsedMs: number;
    }
  | {
      readonly type: "operation_path_updated";
      readonly at: string;
      readonly operationId: string;
      readonly operation: "move_to" | "move_relative";
      readonly status: "noPath" | "timeout" | "success" | "partial";
      readonly pathLength: number;
    }
  | {
      readonly type: "operation_recovery_required";
      readonly at: string;
      readonly operationId: string;
      readonly operation: PlayerOperationName;
      readonly detail: string;
    };

export interface PlayerBody {
  observe(
    options?: PlayerBodyObservationOptions,
  ): Promise<PlayerBodyObservation>;
  execute(
    operation: PlayerOperation,
    signal?: AbortSignal,
  ): Promise<PlayerOperationResult>;
  stop(): Promise<void>;
  knowledge(query: string): PlayerKnowledge;
  onEvent(listener: (event: PlayerBodyEvent) => void): () => void;
}

interface ActiveOperation {
  readonly id: string;
  readonly operation: PlayerOperation;
  readonly controller: AbortController;
  readonly bot: Bot;
  readonly startedAt: string;
  readonly startedAtMs: number;
  resolvedMoveTarget?: Vec3;
  done: Promise<PlayerOperationResult>;
  timedOut: boolean;
  lastProgressAt: number;
  lastProgressSignature: string;
  lastTravelPosition: PlayerBodyObservation["self"]["position"] | undefined;
  stallReported: boolean;
  stallTimer: ReturnType<typeof setInterval> | undefined;
  actionSettled: boolean;
  actionPromise?: Promise<void>;
  runFinished: boolean;
  botDisconnected: boolean;
  effectItemName?: string;
  lookSweep?: PlayerBodyLookSweep;
  expectedTrade?: {
    readonly input1Name: string;
    readonly input1Count: number;
    readonly input2Name: string | null;
    readonly input2Count: number;
    readonly outputName: string;
    readonly outputCount: number;
  };
  fishingCollectedItem?: { readonly name: string; readonly count: number };
  targetHitObserved?: boolean;
  targetDiedObserved?: boolean;
  itemCollectionOutcome?: PlayerItemCollectionOutcome;
  itemCollectionPathFailureReason?: PlayerItemCollectionPathFailureReason;
  externalAbort?: () => void;
}

interface ServerBlockUpdate {
  readonly stateId: number;
  readonly name: string;
}

interface PacketClient {
  on(event: string, listener: (packet: unknown) => void): void;
  removeListener(event: string, listener: (packet: unknown) => void): void;
  write(event: string, packet: unknown): void;
}

class ActionTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Player operation exceeded its ${timeoutMs} ms time limit`);
    this.name = "ActionTimeoutError";
  }
}

class ItemCollectionError extends Error {
  public constructor(
    public readonly outcome: Exclude<
      PlayerItemCollectionOutcome,
      "collected" | "deadline_expired"
    >,
    message: string,
    public readonly pathFailureReason?: PlayerItemCollectionPathFailureReason,
  ) {
    super(message);
    this.name = "ItemCollectionError";
  }
}

function classifyItemCollectionPathFailure(
  error: unknown,
): PlayerItemCollectionPathFailureReason {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "NoPath") return "no_path";
  if (error.name === "Timeout") return "path_timeout";
  return "goto_rejected";
}

function positionVector(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

function blockPosition(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): Vec3 {
  return positionVector(position).floored();
}

function blockKey(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): string {
  const point = blockPosition(position);
  return `${point.x},${point.y},${point.z}`;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 320);
  return String(error).slice(0, 320);
}

function digTimeoutFor(
  bot: Bot,
  position: { readonly x: number; readonly y: number; readonly z: number },
): number {
  try {
    const block = bot.blockAt(blockPosition(position));
    if (block === null) return minimumDigTimeoutMs;
    const estimateMs = bot.digTime(block);
    if (!Number.isFinite(estimateMs) || estimateMs < 0)
      return minimumDigTimeoutMs;
    return Math.min(
      maximumDigTimeoutMs,
      Math.max(
        minimumDigTimeoutMs,
        Math.ceil(estimateMs) + digServerUpdateGraceMs,
      ),
    );
  } catch {
    return minimumDigTimeoutMs;
  }
}

function timeoutFor(operation: PlayerOperation, bot: Bot): number {
  switch (operation.kind) {
    case "move_to":
    case "move_relative":
      return 90_000;
    case "fish":
      return 60_000;
    case "collect_item":
      return maximumItemCollectionTimeoutMs;
    case "control":
    case "move_vehicle":
      return Math.min(10_000, operation.ticks * 50 + 3_000);
    case "use":
      return operation.target.kind === "item"
        ? operation.target.holdTicks * 50 + 3_000
        : 15_000;
    case "elytra_fly":
      return 45_000;
    case "dig":
      return digTimeoutFor(bot, operation.position);
    case "place":
      return 15_000 + placeServerUpdateGraceMs;
    case "craft":
    case "trade":
    case "enchant":
    case "anvil":
    case "write_book":
      return 35_000;
    default:
      return 15_000;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Player operation interrupted");
}

function waitForItemCollectionPoll(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    const timer = setTimeout(finish, itemCollectionPollMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAction<T>(action: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    action.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error("Mineflayer action rejected"),
          ),
        ),
    );
  });
}

function waitTicks(ticks: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ticks * 50);
    const abort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function stableSignature(observation: PlayerBodyObservation): string {
  return JSON.stringify({
    dimension: observation.dimension,
    self: {
      position: observation.self.position,
      health: observation.self.health,
      food: observation.self.food,
      oxygen: observation.self.oxygen,
      inventory: observation.self.inventory,
      equipment: observation.self.equipment,
      sleeping: observation.self.sleeping,
      mountedEntityId: observation.self.mountedEntityId,
    },
    window: observation.window,
    visibleEntities: observation.perception.entities.map((entity) => [
      entity.id,
      entity.position,
      entity.health,
    ]),
    visibleBlocks: observation.perception.blocks.map((block) => [
      block.name,
      block.position,
    ]),
  });
}

function isTravelOperation(operation: PlayerOperation): boolean {
  return (
    operation.kind === "move_to" ||
    operation.kind === "move_relative" ||
    operation.kind === "control" ||
    operation.kind === "move_vehicle" ||
    operation.kind === "elytra_fly"
  );
}

function travelProgressed(
  previous: PlayerBodyObservation["self"]["position"],
  current: PlayerBodyObservation["self"]["position"],
): boolean {
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  const dz = current.z - previous.z;
  return dx * dx + dy * dy + dz * dz >= 0.75 * 0.75;
}

function semanticSignature(
  observation: PlayerBodyObservation,
  reason: Extract<PlayerBodyEvent, { type: "state_changed" }>["reason"],
): string {
  switch (reason) {
    case "vitals":
      return JSON.stringify({
        health: observation.self.health,
        food: observation.self.food,
        saturation: observation.self.foodSaturation,
        oxygen: observation.self.oxygen,
        experience: observation.self.experience,
        sleeping: observation.self.sleeping,
      });
    case "inventory":
      return JSON.stringify({
        inventory: observation.self.inventory,
        equipment: observation.self.equipment,
      });
    case "entities":
      return JSON.stringify(
        observation.perception.entities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          position: [
            Math.round(entity.position.x * 2) / 2,
            Math.round(entity.position.y * 2) / 2,
            Math.round(entity.position.z * 2) / 2,
          ],
          health: entity.health,
        })),
      );
    case "blocks":
      return JSON.stringify(
        observation.perception.blocks.map((block) => ({
          name: block.name,
          position: [block.position.x, block.position.y, block.position.z],
          properties: block.properties,
          signText: block.signText,
        })),
      );
    case "time":
      return JSON.stringify({
        day: observation.time.day,
        hourBucket:
          observation.time.timeOfDay === null
            ? null
            : Math.floor(observation.time.timeOfDay / 1_000),
        isDay: observation.time.isDay,
        raining: observation.time.raining,
      });
    case "position":
      return JSON.stringify({
        dimension: observation.dimension,
        position: [
          Math.round(observation.self.position.x * 4) / 4,
          Math.round(observation.self.position.y * 4) / 4,
          Math.round(observation.self.position.z * 4) / 4,
        ],
        yawBucket: Math.round(observation.self.yaw * 12) / 12,
        pitchBucket: Math.round(observation.self.pitch * 12) / 12,
      });
    case "window":
      return JSON.stringify(observation.window);
  }
}

function countNamedItem(
  observation: PlayerBodyObservation | null,
  itemName: string,
): number {
  return (
    observation?.self.inventory
      .filter((item) => item.name === itemName)
      .reduce((total, item) => total + item.count, 0) ?? 0
  );
}

function stackAt(observation: PlayerBodyObservation | null, slot: number) {
  return observation?.self.inventory.find((item) => item.slot === slot) ?? null;
}

function countWindowItem(
  observation: PlayerBodyObservation | null,
  itemName: string,
): number {
  const window = observation?.window;
  if (window === null || window === undefined) return 0;
  return window.slots
    .slice(0, window.inventoryStart)
    .filter((item): item is BodyItemStack => item?.name === itemName)
    .reduce((total, item) => total + item.count, 0);
}

function countWindowItemInPlayerInventory(
  observation: PlayerBodyObservation | null,
  itemName: string,
): number {
  const window = observation?.window;
  if (window === null || window === undefined)
    return countNamedItem(observation, itemName);
  return window.slots
    .slice(window.inventoryStart, window.inventoryEnd)
    .filter((item) => item?.name === itemName)
    .reduce((total, item) => total + (item?.count ?? 0), 0);
}

function newEnchantmentObserved(
  before: PlayerBodyObservation | null,
  after: PlayerBodyObservation | null,
  itemName: string,
): boolean {
  const oldEnchantments = new Set(
    before?.self.inventory
      .filter((item) => item.name === itemName)
      .flatMap((item) =>
        item.enchantments.map((entry) => `${entry.name}:${entry.level}`),
      ) ?? [],
  );
  return (
    after?.self.inventory.some(
      (item) =>
        item.name === itemName &&
        item.enchantments.some(
          (entry) => !oldEnchantments.has(`${entry.name}:${entry.level}`),
        ),
    ) ?? false
  );
}

function blockAtObservation(
  observation: PlayerBodyObservation | null,
  position: { readonly x: number; readonly y: number; readonly z: number },
) {
  const key = blockKey(position);
  return observation?.perception.blocks.find(
    (block) => blockKey(block.position) === key,
  );
}

function captureAttackEvidence(
  bot: Bot,
  operation: PlayerOperation,
  active: ActiveOperation,
): (() => void) | undefined {
  if (operation.kind !== "attack") return undefined;
  const targetId = operation.entityId;
  const onEntityHurt = (target: Entity, source: Entity | undefined): void => {
    if (target.id === targetId && source?.id === bot.entity.id)
      active.targetHitObserved = true;
  };
  const onEntityDead = (target: Entity): void => {
    if (target.id === targetId && active.targetHitObserved === true)
      active.targetDiedObserved = true;
  };
  bot.on("entityHurt", onEntityHurt);
  bot.on("entityDead", onEntityDead);
  return () => {
    bot.removeListener("entityHurt", onEntityHurt);
    bot.removeListener("entityDead", onEntityDead);
  };
}

function captureItemCollectionEvidence(
  bot: Bot,
  operation: PlayerOperation,
  active: ActiveOperation,
): (() => void) | undefined {
  if (operation.kind !== "collect_item") return undefined;
  const targetId = operation.entityId;
  const onPlayerCollect = (collector: Entity, collected: Entity): void => {
    if (collector.id === bot.entity.id && collected.id === targetId)
      active.itemCollectionOutcome = "collected";
  };
  bot.on("playerCollect", onPlayerCollect);
  return () => bot.removeListener("playerCollect", onPlayerCollect);
}

function operationEvidence(
  bot: Bot,
  operation: PlayerOperation,
  before: PlayerBodyObservation | null,
  after: PlayerBodyObservation | null,
  serverBlockUpdates: ReadonlyMap<string, ServerBlockUpdate>,
  active: ActiveOperation,
): boolean {
  if (operation.kind === "attack") return active.targetHitObserved === true;
  if (operation.kind === "collect_item")
    return active.itemCollectionOutcome === "collected";
  if (before === null || after === null) return false;
  const beforePos = before.self.position;
  const afterPos = after.self.position;
  const moved =
    Math.hypot(
      afterPos.x - beforePos.x,
      afterPos.y - beforePos.y,
      afterPos.z - beforePos.z,
    ) > 0.15;
  switch (operation.kind) {
    case "move_to":
    case "move_relative": {
      const target =
        operation.kind === "move_to"
          ? operation.position
          : {
              x: beforePos.x + operation.offset.x,
              y: beforePos.y + operation.offset.y,
              z: beforePos.z + operation.offset.z,
            };
      const dx = Math.floor(afterPos.x) - Math.floor(target.x);
      const dy = Math.floor(afterPos.y) - Math.floor(target.y);
      const dz = Math.floor(afterPos.z) - Math.floor(target.z);
      const arrived =
        dx * dx + dy * dy + dz * dz <= operation.range * operation.range;
      return operation.kind === "move_relative" ? arrived && moved : arrived;
    }
    case "look": {
      const target = positionVector(operation.target);
      const eye = new Vec3(
        afterPos.x,
        afterPos.y + after.self.eyeHeight,
        afterPos.z,
      );
      const delta = target.minus(eye);
      const expectedYaw = Math.atan2(-delta.x, -delta.z);
      const expectedPitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
      const yawDiff = Math.atan2(
        Math.sin(after.self.yaw - expectedYaw),
        Math.cos(after.self.yaw - expectedYaw),
      );
      return (
        Math.abs(yawDiff) < 0.12 &&
        Math.abs(after.self.pitch - expectedPitch) < 0.12
      );
    }
    case "look_sweep":
      return active.lookSweep?.complete === true;
    case "control":
    case "move_vehicle":
    case "elytra_fly":
      return (
        moved ||
        Math.hypot(
          after.self.velocity.x,
          after.self.velocity.y,
          after.self.velocity.z,
        ) > 0.1
      );
    case "equip":
      return (
        after.self.equipment[operation.destination]?.name === operation.item
      );
    case "dig": {
      const update = serverBlockUpdates.get(blockKey(operation.position));
      const observed = bot.blockAt(blockPosition(operation.position));
      return (
        update !== undefined &&
        observed?.stateId === update.stateId &&
        ["air", "cave_air", "void_air"].includes(update.name)
      );
    }
    case "place": {
      const update = serverBlockUpdates.get(blockKey(operation.position));
      const observed = bot.blockAt(blockPosition(operation.position));
      const bucketBlock = operation.item.endsWith("_bucket")
        ? operation.item.slice(0, -"_bucket".length)
        : operation.item;
      const expectedBlock = bot.registry.blocksByName[bucketBlock];
      return (
        update !== undefined &&
        observed?.stateId === update.stateId &&
        !["air", "cave_air", "void_air"].includes(update.name) &&
        update.name !== "unknown" &&
        expectedBlock?.name === update.name
      );
    }
    case "craft":
      return (
        countNamedItem(after, operation.item) >=
        countNamedItem(before, operation.item) + operation.count
      );
    case "open_window":
      return after.window !== null && before.window?.id !== after.window.id;
    case "window_click": {
      const beforeSlot = before.window?.slots[operation.slot] ?? null;
      const afterSlot = after.window?.slots[operation.slot] ?? null;
      return (
        JSON.stringify(beforeSlot) !== JSON.stringify(afterSlot) ||
        JSON.stringify(before.window?.selectedItem) !==
          JSON.stringify(after.window?.selectedItem)
      );
    }
    case "window_transfer": {
      if (before.window === null || after.window === null) return false;
      const inventoryBefore = countWindowItemInPlayerInventory(
        before,
        operation.item,
      );
      const inventoryAfter = countWindowItemInPlayerInventory(
        after,
        operation.item,
      );
      const windowBefore = countWindowItem(before, operation.item);
      const windowAfter = countWindowItem(after, operation.item);
      return operation.direction === "inventory_to_window"
        ? inventoryBefore - inventoryAfter === operation.count &&
            windowAfter - windowBefore === operation.count
        : windowBefore - windowAfter === operation.count &&
            inventoryAfter - inventoryBefore === operation.count;
    }
    case "window_close":
      return before.window !== null && after.window === null;
    case "consume":
      return (
        active.effectItemName !== undefined &&
        after.self.food !== null &&
        before.self.food !== null &&
        after.self.food > before.self.food &&
        countNamedItem(after, active.effectItemName) <
          countNamedItem(before, active.effectItemName)
      );
    case "toss":
      return (
        countNamedItem(after, operation.item) <=
        countNamedItem(before, operation.item) - operation.count
      );
    case "transfer": {
      const sourceBefore = stackAt(before, operation.sourceSlot);
      const sourceAfter = stackAt(after, operation.sourceSlot);
      const destinationBefore = stackAt(before, operation.destinationSlot);
      const destinationAfter = stackAt(after, operation.destinationSlot);
      if (sourceBefore === null || destinationAfter === null) return false;
      const sourceReduced =
        sourceAfter === null ||
        sourceAfter.count < sourceBefore.count ||
        sourceAfter.itemId !== sourceBefore.itemId;
      const destinationReceived =
        destinationAfter.itemId === sourceBefore.itemId &&
        (destinationBefore === null ||
          destinationAfter.count > destinationBefore.count);
      const swapped =
        destinationBefore !== null &&
        sourceAfter !== null &&
        sourceAfter.itemId === destinationBefore.itemId &&
        destinationAfter.itemId === sourceBefore.itemId;
      return sourceReduced && (destinationReceived || swapped);
    }
    case "fish":
      return (
        active.fishingCollectedItem !== undefined &&
        countNamedItem(after, active.fishingCollectedItem.name) -
          countNamedItem(before, active.fishingCollectedItem.name) >=
          active.fishingCollectedItem.count
      );
    case "sleep":
      return after.self.sleeping;
    case "wake":
      return !after.self.sleeping;
    case "mount":
      return after.self.mountedEntityId === operation.entityId;
    case "dismount":
      return (
        before.self.mountedEntityId !== null &&
        after.self.mountedEntityId === null
      );
    case "trade": {
      const trade = active.expectedTrade;
      if (trade === undefined) return false;
      const deltas = new Map<string, number>();
      deltas.set(
        trade.outputName,
        (deltas.get(trade.outputName) ?? 0) + trade.outputCount,
      );
      deltas.set(
        trade.input1Name,
        (deltas.get(trade.input1Name) ?? 0) - trade.input1Count,
      );
      if (trade.input2Name !== null)
        deltas.set(
          trade.input2Name,
          (deltas.get(trade.input2Name) ?? 0) - trade.input2Count,
        );
      return [...deltas].every(
        ([name, expectedDelta]) =>
          countNamedItem(after, name) - countNamedItem(before, name) ===
          expectedDelta,
      );
    }
    case "enchant":
      return newEnchantmentObserved(before, after, operation.item);
    case "anvil": {
      const afterStacks = after.self.inventory.filter(
        (item) => item.name === operation.firstItem,
      );
      if (operation.operation === "rename")
        return (
          afterStacks.some((item) => item.customName === operation.name) &&
          !before.self.inventory.some(
            (item) =>
              item.name === operation.firstItem &&
              item.customName === operation.name,
          )
        );
      if (operation.name !== undefined)
        return (
          afterStacks.some((item) => item.customName === operation.name) &&
          !before.self.inventory.some(
            (item) =>
              item.name === operation.firstItem &&
              item.customName === operation.name,
          )
        );
      const oldStacks = before.self.inventory.filter(
        (item) => item.name === operation.firstItem,
      );
      return afterStacks.some(
        (item) =>
          (item.durability !== null &&
            oldStacks.some(
              (old) =>
                old.durability !== null &&
                item.durability !== null &&
                item.durability > old.durability,
            )) ||
          item.enchantments.some(
            (enchantment) =>
              !oldStacks.some((old) =>
                old.enchantments.some(
                  (oldEnchantment) =>
                    oldEnchantment.name === enchantment.name &&
                    oldEnchantment.level >= enchantment.level,
                ),
              ),
          ),
      );
    }
    case "use":
      if (operation.target.kind === "block") {
        const key = blockKey(operation.target.position);
        const update = serverBlockUpdates.get(key);
        const oldBlock = blockAtObservation(before, operation.target.position);
        const observed = bot.blockAt(blockPosition(operation.target.position));
        const blockChanged =
          update !== undefined &&
          oldBlock !== undefined &&
          update.stateId !== oldBlock.stateId &&
          observed?.stateId === update.stateId;
        const openedWindow =
          after.window !== null && before.window?.id !== after.window.id;
        return blockChanged || openedWindow;
      }
      if (operation.target.kind === "item") {
        const itemName = active.effectItemName;
        return (
          itemName !== undefined &&
          countNamedItem(after, itemName) < countNamedItem(before, itemName)
        );
      }
      return (
        JSON.stringify(before.window) !== JSON.stringify(after.window) ||
        (active.effectItemName !== undefined &&
          countNamedItem(after, active.effectItemName) <
            countNamedItem(before, active.effectItemName))
      );
    case "write_book": {
      const beforePages = stackAt(before, operation.slot)?.bookPages;
      const afterPages = stackAt(after, operation.slot)?.bookPages;
      return (
        afterPages !== undefined &&
        JSON.stringify(afterPages) === JSON.stringify(operation.pages) &&
        JSON.stringify(beforePages) !== JSON.stringify(afterPages)
      );
    }
    case "update_sign": {
      const block = blockAtObservation(after, operation.position);
      const oldBlock = blockAtObservation(before, operation.position);
      const actualText = block?.signText?.[operation.back ? 1 : 0];
      return (
        typeof actualText === "string" &&
        actualText === operation.text.join("\n") &&
        oldBlock?.signText?.[operation.back ? 1 : 0] !== actualText
      );
    }
  }
}

function captureServerBlockUpdates(
  bot: Bot,
  target: Vec3,
): {
  readonly updates: Map<string, ServerBlockUpdate>;
  waitForTargetAirUpdate(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<boolean>;
  waitForTargetNamedUpdate(
    signal: AbortSignal,
    timeoutMs: number,
    expectedName: string,
  ): Promise<boolean>;
  dispose(): void;
} {
  const updates = new Map<string, ServerBlockUpdate>();
  const targetUpdateWaiters = new Set<() => void>();
  const client = bot._client as unknown as PacketClient;
  const accept = (point: Vec3, stateId: number): void => {
    if (blockKey(point) !== blockKey(target) || !Number.isInteger(stateId))
      return;
    const state = bot.registry.blocksByStateId[stateId];
    const update = {
      stateId,
      name: state?.name ?? (stateId === 0 ? "air" : "unknown"),
    };
    updates.set(blockKey(point), update);
    targetUpdateWaiters.forEach((notify) => notify());
  };
  const single = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null) return;
    const packet = raw as {
      readonly location?: {
        readonly x?: unknown;
        readonly y?: unknown;
        readonly z?: unknown;
      };
      readonly type?: unknown;
    };
    const point = packet.location;
    if (
      typeof point?.x === "number" &&
      typeof point.y === "number" &&
      typeof point.z === "number" &&
      typeof packet.type === "number"
    )
      accept(new Vec3(point.x, point.y, point.z), packet.type);
  };
  const multi = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null) return;
    const packet = raw as {
      readonly records?: readonly unknown[];
      readonly chunkCoordinates?: {
        readonly x?: unknown;
        readonly y?: unknown;
        readonly z?: unknown;
      };
      readonly chunkX?: unknown;
      readonly chunkZ?: unknown;
    };
    if (!Array.isArray(packet.records)) return;
    for (const rawRecord of packet.records) {
      let point: Vec3;
      let stateId: number;
      if (bot.supportFeature("usesMultiblockSingleLong")) {
        if (typeof rawRecord !== "number") continue;
        const base = packet.chunkCoordinates;
        if (
          typeof base?.x !== "number" ||
          typeof base.y !== "number" ||
          typeof base.z !== "number"
        )
          continue;
        point = new Vec3(base.x, base.y, base.z)
          .scale(16)
          .offset(
            (rawRecord >> 8) & 0x0f,
            rawRecord & 0x0f,
            (rawRecord >> 4) & 0x0f,
          );
        stateId = rawRecord >> 12;
      } else {
        if (typeof rawRecord !== "object" || rawRecord === null) continue;
        const record = rawRecord as {
          readonly horizontalPos?: unknown;
          readonly y?: unknown;
          readonly blockId?: unknown;
        };
        if (
          typeof record.horizontalPos !== "number" ||
          typeof record.y !== "number" ||
          typeof record.blockId !== "number" ||
          typeof packet.chunkX !== "number" ||
          typeof packet.chunkZ !== "number"
        )
          continue;
        const x = (record.horizontalPos >> 4) & 0x0f;
        const z = record.horizontalPos & 0x0f;
        point = new Vec3(
          packet.chunkX * 16 + x,
          record.y,
          packet.chunkZ * 16 + z,
        );
        stateId = record.blockId;
      }
      accept(point, stateId);
    }
  };
  client.on("block_change", single);
  client.on("multi_block_change", multi);
  const waitForMatchingTargetUpdate = (
    signal: AbortSignal,
    timeoutMs: number,
    matches: (update: ServerBlockUpdate) => boolean,
  ): Promise<boolean> => {
    const hasMatchingUpdate = (): boolean => {
      const update = updates.get(blockKey(target));
      return update !== undefined && matches(update);
    };
    if (hasMatchingUpdate()) return Promise.resolve(true);
    if (signal.aborted || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        targetUpdateWaiters.delete(onTargetUpdate);
        resolve(confirmed);
      };
      const onTargetUpdate = (): void => {
        if (hasMatchingUpdate()) finish(true);
      };
      const onAbort = (): void => finish(false);
      targetUpdateWaiters.add(onTargetUpdate);
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => finish(hasMatchingUpdate()), timeoutMs);
      if (signal.aborted) finish(false);
    });
  };
  return {
    updates,
    waitForTargetAirUpdate: (signal, timeoutMs) =>
      waitForMatchingTargetUpdate(signal, timeoutMs, (update) =>
        ["air", "cave_air", "void_air"].includes(update.name),
      ),
    waitForTargetNamedUpdate: (signal, timeoutMs, expectedName) =>
      waitForMatchingTargetUpdate(
        signal,
        timeoutMs,
        (update) => update.name === expectedName,
      ),
    dispose: () => {
      client.removeListener("block_change", single);
      client.removeListener("multi_block_change", multi);
      targetUpdateWaiters.clear();
    },
  };
}

export class MineflayerPlayerBody implements PlayerBody {
  private active: ActiveOperation | undefined;
  private admission: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: PlayerBodyEvent) => void>();
  private boundBot: Bot | undefined;
  private readonly botHandlers: (() => void)[] = [];
  private readonly inventoryHandlers: (() => void)[] = [];
  private inventoryBoundBot: Bot | undefined;
  private readonly windowUpdateHandlers = new Map<Window, () => void>();
  private readonly stateTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly lastStateSignatures = new Map<
    Extract<PlayerBodyEvent, { type: "state_changed" }>["reason"],
    string
  >();
  private disconnectedSinceBind = false;

  public constructor(
    private readonly getBot: () => Bot,
    private readonly ownerUsername?: string,
  ) {}

  /** @internal MineflayerClient uses this to keep lifecycle events across reconnects. */
  public attach(bot: Bot): void {
    this.bindBot(bot);
  }

  public async observe(
    options: PlayerBodyObservationOptions = {},
  ): Promise<PlayerBodyObservation> {
    const bot = this.getBot();
    this.bindBot(bot);
    return observePlayerBody(bot, this.ownerUsername, options);
  }

  public knowledge(query: string): PlayerKnowledge {
    const bot = this.getBot();
    this.bindBot(bot);
    return queryPlayerKnowledge(bot, query.slice(0, 256));
  }

  public onEvent(listener: (event: PlayerBodyEvent) => void): () => void {
    this.listeners.add(listener);
    try {
      this.bindBot(this.getBot());
    } catch {
      // A disconnected client will be rebound on the next body operation.
    }
    return () => this.listeners.delete(listener);
  }

  public async execute(
    rawOperation: PlayerOperation,
    signal?: AbortSignal,
  ): Promise<PlayerOperationResult> {
    const operation = playerOperationSchema.parse(rawOperation);
    const previousAdmission = this.admission;
    let resolveAdmission!: () => void;
    const nextAdmission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    this.admission = previousAdmission.then(
      () => nextAdmission,
      () => nextAdmission,
    );

    let active: ActiveOperation | undefined;
    try {
      await previousAdmission;
      const bot = this.getBot();
      this.bindBot(bot);
      const previous = this.active;
      if (previous !== undefined) {
        previous.controller.abort(
          new Error("Replaced by a newer player operation"),
        );
        await previous.done;
        if (
          !previous.actionSettled &&
          !(previous.botDisconnected && previous.bot !== bot)
        ) {
          throw new Error(
            "The previous Mineflayer action is still settling; no replacement action was started.",
          );
        }
        if (this.active === previous) this.active = undefined;
      }
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      else if (signal !== undefined) {
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        active = this.makeActive(operation, bot, controller, abort);
      }
      active ??= this.makeActive(operation, bot, controller);
      this.active = active;
      this.emit({
        type: "operation_started",
        at: active.startedAt,
        operationId: active.id,
        operation: operation.kind,
      });
      active.done = this.runActive(active);
    } finally {
      resolveAdmission();
    }

    const result = await active.done;
    if (signal !== undefined && active.externalAbort !== undefined)
      signal.removeEventListener("abort", active.externalAbort);
    return result;
  }

  public async stop(): Promise<void> {
    const active = this.active;
    if (active !== undefined) {
      active.controller.abort(new Error("Player body stopped"));
      this.cleanupAction(active, true);
      this.stopBot(active.bot);
      await active.done;
    }
    try {
      this.stopBot(this.getBot());
    } catch {
      // The bot may already be disconnected; its current physical action cannot be controlled then.
    }
  }

  private makeActive(
    operation: PlayerOperation,
    bot: Bot,
    controller: AbortController,
    externalAbort?: () => void,
  ): ActiveOperation {
    const startedAt = new Date().toISOString();
    return {
      id: randomUUID(),
      operation,
      controller,
      bot,
      startedAt,
      startedAtMs: Date.now(),
      done: Promise.resolve({
        operationId: "",
        operation,
        status: "interrupted",
        startedAt,
        completedAt: startedAt,
        before: null,
        after: null,
        recoveryRequired: false,
      }),
      timedOut: false,
      lastProgressAt: Date.now(),
      lastProgressSignature: "",
      lastTravelPosition: undefined,
      stallReported: false,
      stallTimer: undefined,
      actionSettled: true,
      runFinished: false,
      botDisconnected: false,
      ...(externalAbort === undefined ? {} : { externalAbort }),
    };
  }

  private async runActive(
    active: ActiveOperation,
  ): Promise<PlayerOperationResult> {
    const { bot, operation, controller } = active;
    const before = this.safeObserve(bot);
    if (operation.kind === "move_relative") {
      const origin = before?.self.position ?? bot.entity.position;
      active.resolvedMoveTarget = new Vec3(
        origin.x + operation.offset.x,
        origin.y + operation.offset.y,
        origin.z + operation.offset.z,
      );
    }
    active.lastProgressSignature =
      before === null ? "" : stableSignature(before);
    active.lastTravelPosition = before?.self.position;
    this.startStallMonitor(active);
    const blockTarget =
      operation.kind === "dig" || operation.kind === "place"
        ? blockPosition(operation.position)
        : operation.kind === "use" && operation.target.kind === "block"
          ? blockPosition(operation.target.position)
          : undefined;
    const blockEvidence =
      blockTarget === undefined
        ? undefined
        : captureServerBlockUpdates(bot, blockTarget);
    const attackEvidence = captureAttackEvidence(bot, operation, active);
    const itemCollectionEvidence = captureItemCollectionEvidence(
      bot,
      operation,
      active,
    );
    let commandError: unknown;
    const timeoutMs = timeoutFor(operation, bot);
    const timer = setTimeout(() => {
      active.timedOut = true;
      controller.abort(new ActionTimeoutError(timeoutMs));
    }, timeoutMs);
    try {
      if (!controller.signal.aborted) {
        const action = this.dispatch(bot, operation, controller.signal, active);
        active.actionPromise = action;
        active.actionSettled = false;
        void action.then(
          () => this.noteActionSettled(active),
          () => this.noteActionSettled(active),
        );
        await waitForAction(action, controller.signal);
        if (operation.kind === "dig" && blockEvidence !== undefined)
          await blockEvidence.waitForTargetAirUpdate(
            controller.signal,
            digServerUpdateGraceMs,
          );
        if (operation.kind === "place" && blockEvidence !== undefined) {
          const expectedBlockName = operation.item.endsWith("_bucket")
            ? operation.item.slice(0, -"_bucket".length)
            : operation.item;
          await blockEvidence.waitForTargetNamedUpdate(
            controller.signal,
            placeServerUpdateGraceMs,
            expectedBlockName,
          );
        }
      }
    } catch (error) {
      commandError = error;
      if (
        operation.kind === "collect_item" &&
        error instanceof ItemCollectionError
      ) {
        active.itemCollectionOutcome = error.outcome;
        if (error.pathFailureReason !== undefined)
          active.itemCollectionPathFailureReason = error.pathFailureReason;
      }
    } finally {
      clearTimeout(timer);
      blockEvidence?.dispose();
      attackEvidence?.();
      itemCollectionEvidence?.();
      this.stopStallMonitor(active);
      this.cleanupAction(
        active,
        commandError !== undefined || controller.signal.aborted,
      );
      if (active.actionPromise !== undefined && !active.actionSettled)
        await this.waitForActionSettlement(active, 2_000);
    }

    const after = this.safeObserve(bot);
    const serverUpdates =
      blockEvidence?.updates ?? new Map<string, ServerBlockUpdate>();
    const confirmed = operationEvidence(
      bot,
      operation,
      before,
      after,
      serverUpdates,
      active,
    );
    const interrupted = controller.signal.aborted && !active.timedOut;
    const recoveryRequired = !active.actionSettled;
    const observedEffect =
      operation.kind === "attack" && active.targetHitObserved === true
        ? {
            type:
              active.targetDiedObserved === true
                ? ("entity_died" as const)
                : ("entity_hit" as const),
            entityId: operation.entityId,
          }
        : operation.kind === "collect_item" &&
            active.itemCollectionOutcome === "collected"
          ? {
              type: "item_collected" as const,
              entityId: operation.entityId,
            }
          : undefined;
    const itemCollectionOutcome =
      operation.kind !== "collect_item"
        ? undefined
        : (active.itemCollectionOutcome ??
          (active.timedOut ? "deadline_expired" : undefined));
    let status: PlayerOperationStatus;
    let detail: string;
    if (confirmed) {
      status = "successful";
      detail =
        operation.kind === "attack"
          ? active.targetDiedObserved === true
            ? "Mineflayer observed this player damage the target and then observed the target die."
            : "Mineflayer observed this player damage the target; target death was not observed."
          : operation.kind === "collect_item"
            ? "Mineflayer observed this player collect the requested item entity."
            : "Observed post-action state confirms the requested effect.";
    } else if (active.timedOut) {
      status = "unverified";
      detail =
        operation.kind === "collect_item"
          ? "The bounded item collection deadline expired without an observed pickup."
          : "The bounded action wait expired; the requested world effect was not confirmed.";
    } else if (interrupted) {
      status = "interrupted";
      detail = recoveryRequired
        ? "Cancellation cleanup ran, but Mineflayer's native action is still pending. Reconnect before issuing another action."
        : "The action was stopped before an observed effect could be confirmed.";
    } else if (commandError !== undefined) {
      status = "failed";
      detail = errorDetail(commandError);
    } else {
      status = "unverified";
      detail =
        "Mineflayer accepted the request, but the resulting world effect was not observable.";
    }

    const completedAt = new Date().toISOString();
    const result: PlayerOperationResult = {
      operationId: active.id,
      operation,
      status,
      startedAt: active.startedAt,
      completedAt,
      before,
      after,
      recoveryRequired,
      ...(observedEffect === undefined ? {} : { observedEffect }),
      ...(itemCollectionOutcome === undefined ? {} : { itemCollectionOutcome }),
      ...(active.itemCollectionPathFailureReason === undefined
        ? {}
        : {
            itemCollectionPathFailureReason:
              active.itemCollectionPathFailureReason,
          }),
      ...(active.lookSweep === undefined
        ? {}
        : { lookSweep: active.lookSweep }),
      detail,
    };
    if (recoveryRequired) {
      this.emit({
        type: "operation_recovery_required",
        at: completedAt,
        operationId: active.id,
        operation: operation.kind,
        detail,
      });
    }
    active.runFinished = true;
    if (
      this.active === active &&
      (active.actionSettled || active.botDisconnected)
    )
      this.active = undefined;
    if (status === "failed") {
      this.emit({
        type: "operation_failed",
        at: completedAt,
        operationId: active.id,
        operation: operation.kind,
        detail,
      });
    } else {
      this.emit({
        type: "operation_completed",
        at: completedAt,
        operationId: active.id,
        operation: operation.kind,
        status,
      });
    }
    return result;
  }

  private safeObserve(bot: Bot): PlayerBodyObservation | null {
    try {
      return observePlayerBody(bot, this.ownerUsername);
    } catch {
      return null;
    }
  }

  private noteActionSettled(active: ActiveOperation): void {
    active.actionSettled = true;
    if (active.runFinished && this.active === active) this.active = undefined;
  }

  private async waitForActionSettlement(
    active: ActiveOperation,
    timeoutMs: number,
  ): Promise<void> {
    const action = active.actionPromise;
    if (action === undefined || active.actionSettled) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      action.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }

  private stopBot(bot: Bot): void {
    try {
      bot.clearControlStates();
      bot.deactivateItem();
      bot.stopDigging();
      bot.pathfinder.setGoal(null);
      bot.moveVehicle(0, 0);
      if (bot.currentWindow !== null) bot.closeWindow(bot.currentWindow);
    } catch {
      // A disconnected bot has no active controls to release.
    }
  }

  private startStallMonitor(active: ActiveOperation): void {
    active.stallTimer = setInterval(() => {
      if (this.active !== active || active.controller.signal.aborted) return;
      const observation = this.safeObserve(active.bot);
      if (observation === null) return;
      const isTravel = isTravelOperation(active.operation);
      const lastTravelPosition = active.lastTravelPosition;
      const signature = isTravel ? undefined : stableSignature(observation);
      const progressed = isTravel
        ? lastTravelPosition === undefined ||
          travelProgressed(lastTravelPosition, observation.self.position)
        : signature !== active.lastProgressSignature;
      if (progressed) {
        if (isTravel) active.lastTravelPosition = observation.self.position;
        else active.lastProgressSignature = signature ?? "";
        active.lastProgressAt = Date.now();
        active.stallReported = false;
      } else if (
        !active.stallReported &&
        Date.now() - active.lastProgressAt >= stallAfterMs
      ) {
        active.stallReported = true;
        this.emit({
          type: "operation_stalled",
          at: new Date().toISOString(),
          operationId: active.id,
          operation: active.operation.kind,
          elapsedMs: Date.now() - active.startedAtMs,
        });
      }
    }, stallCheckMs);
  }

  private stopStallMonitor(active: ActiveOperation): void {
    if (active.stallTimer !== undefined) clearInterval(active.stallTimer);
    active.stallTimer = undefined;
  }

  private cleanupAction(
    active: ActiveOperation,
    cancelledOrFailed: boolean,
  ): void {
    const { bot, operation } = active;
    try {
      if (
        operation.kind === "move_to" ||
        operation.kind === "move_relative" ||
        operation.kind === "collect_item"
      )
        bot.pathfinder.setGoal(null);
      if (operation.kind === "control") bot.clearControlStates();
      if (operation.kind === "move_vehicle") bot.moveVehicle(0, 0);
      if (operation.kind === "dig") bot.stopDigging();
      if (
        operation.kind === "use" ||
        operation.kind === "consume" ||
        operation.kind === "fish"
      )
        bot.deactivateItem();
      if (
        cancelledOrFailed &&
        [
          "open_window",
          "window_click",
          "window_transfer",
          "transfer",
          "trade",
          "enchant",
          "anvil",
          "craft",
          "write_book",
        ].includes(operation.kind) &&
        bot.currentWindow !== null
      )
        bot.closeWindow(bot.currentWindow);
    } catch {
      // The connection can end while an action is being cancelled.
    }
  }

  private async dispatch(
    bot: Bot,
    operation: PlayerOperation,
    signal: AbortSignal,
    active: ActiveOperation,
  ): Promise<void> {
    switch (operation.kind) {
      case "move_to":
      case "move_relative": {
        const target =
          operation.kind === "move_to"
            ? operation.position
            : active.resolvedMoveTarget;
        if (target === undefined)
          throw new Error("Relative movement target was not initialized");
        const goal = new goals.GoalNear(
          target.x,
          target.y,
          target.z,
          operation.range,
        );
        let latestPathUpdateStatus: string | undefined;
        let observingPathUpdates = true;
        const capturePathUpdate = (results: {
          readonly status: string;
          readonly path?: readonly unknown[];
        }) => {
          latestPathUpdateStatus = results.status;
          if (
            results.status === "noPath" ||
            results.status === "timeout" ||
            results.status === "success" ||
            results.status === "partial"
          ) {
            this.emit({
              type: "operation_path_updated",
              at: new Date().toISOString(),
              operationId: active.id,
              operation: operation.kind,
              status: results.status,
              pathLength: Array.isArray(results.path) ? results.path.length : 0,
            });
          }
        };
        const stopObservingPathUpdates = () => {
          if (!observingPathUpdates) return;
          observingPathUpdates = false;
          bot.removeListener("path_update", capturePathUpdate);
          signal.removeEventListener("abort", stopObservingPathUpdates);
        };
        bot.on("path_update", capturePathUpdate);
        if (signal.aborted) stopObservingPathUpdates();
        else
          signal.addEventListener("abort", stopObservingPathUpdates, {
            once: true,
          });
        try {
          if (signal.aborted) return;
          await bot.pathfinder.goto(goal);
          if (latestPathUpdateStatus === "noPath")
            throw new Error("No path to the goal!");
        } finally {
          stopObservingPathUpdates();
        }
        return;
      }
      case "look":
        await bot.lookAt(positionVector(operation.target), true);
        return;
      case "look_sweep":
        await this.runLookSweep(bot, operation, signal, active);
        return;
      case "control":
        for (const control of bodyControls)
          bot.setControlState(control, operation.controls[control] ?? false);
        await waitTicks(operation.ticks, signal);
        return;
      case "equip": {
        const item = findInventoryItem(bot, operation.item);
        await bot.equip(item, operation.destination);
        return;
      }
      case "use": {
        if (operation.target.kind === "item") {
          const hand = operation.target.offHand ? "off-hand" : "hand";
          const slot = bot.getEquipmentDestSlot(hand);
          const item = bot.inventory.slots[slot];
          if (item !== null && item !== undefined)
            active.effectItemName = item.name;
          bot.activateItem(operation.target.offHand);
          await waitTicks(operation.target.holdTicks, signal);
          return;
        }
        if (operation.target.kind === "block") {
          const block = requireReachableBlock(bot, operation.target.position);
          await activateBlockCancellable(bot, block, signal);
          return;
        }
        const entity = requireVisibleEntity(
          bot,
          operation.target.entityId,
          interactRange,
        );
        const heldItem = heldItemOrNull(bot);
        if (heldItem !== null) active.effectItemName = heldItem.name;
        await activateEntityCancellable(bot, entity, signal);
        return;
      }
      case "attack": {
        const entity = requireVisibleEntity(
          bot,
          operation.entityId,
          attackRange,
        );
        bot.attack(entity);
        await waitTicks(6, signal);
        return;
      }
      case "dig": {
        const block = requireReachableBlock(bot, operation.position);
        await bot.dig(block);
        return;
      }
      case "place": {
        const item = findInventoryItem(bot, operation.item);
        const destination = blockPosition(operation.position);
        const current = bot.blockAt(destination);
        if (current === null)
          throw new Error("Target block is outside loaded world data");
        if (
          current.boundingBox !== "empty" &&
          !["water", "lava"].includes(current.name)
        )
          throw new Error(`Target position is occupied by ${current.name}`);
        await bot.equip(item, "hand");
        if (signal.aborted) throw abortError(signal);
        const visibleBlockKeys = new Set(
          observePlayerBody(bot, undefined).perception.blocks.map((candidate) =>
            blockKey(candidate.position),
          ),
        );
        const faceNormal =
          operation.face === undefined ? undefined : faceVector(operation.face);
        const choices =
          faceNormal === undefined
            ? [
                faceVector("up"),
                faceVector("north"),
                faceVector("south"),
                faceVector("east"),
                faceVector("west"),
                faceVector("down"),
              ]
            : [faceNormal];
        let reference: Block | null = null;
        let selectedFace: Vec3 | undefined;
        for (const face of choices) {
          const candidate = bot.blockAt(destination.minus(face));
          if (
            candidate !== null &&
            candidate.boundingBox === "block" &&
            bot.canSeeBlock(candidate) &&
            visibleBlockKeys.has(blockKey(candidate.position))
          ) {
            reference = candidate;
            selectedFace = face;
            break;
          }
        }
        if (reference === null || selectedFace === undefined)
          throw new Error(
            "No visible supporting block face exists next to the target",
          );
        await placeBlockCancellable(bot, reference, selectedFace, signal);
        return;
      }
      case "craft": {
        const item = bot.registry.itemsByName[operation.item];
        if (item === undefined)
          throw new Error(`Unknown registry item: ${operation.item}`);
        const tableId = bot.registry.blocksByName.crafting_table?.id;
        const craftingTable =
          tableId === undefined
            ? null
            : bot.findBlock({ matching: tableId, maxDistance: 4.5 });
        const recipes = bot.recipesFor(
          item.id,
          null,
          operation.count,
          craftingTable ?? false,
        );
        const recipe = recipes[0];
        if (recipe === undefined)
          throw new Error(
            `No recipe for ${operation.item} can be made from current inventory and available crafting surface`,
          );
        const repetitions = Math.ceil(operation.count / recipe.result.count);
        const craftingSurface = recipe.requiresTable
          ? craftingTable
          : undefined;
        if (craftingSurface === null)
          throw new Error("This recipe requires a reachable crafting table");
        await bot.craft(recipe, repetitions, craftingSurface);
        return;
      }
      case "open_window": {
        if (bot.currentWindow !== null)
          throw new Error(
            "Close the current window before opening another one",
          );
        if (operation.target.kind === "block") {
          const block = requireReachableBlock(bot, operation.target.position);
          await openWindowCancellable(
            bot,
            (markPacketSent) =>
              activateBlockCancellable(bot, block, signal, markPacketSent),
            signal,
          );
          return;
        }
        const entity = requireVisibleEntity(
          bot,
          operation.target.entityId,
          interactRange,
        );
        await openWindowCancellable(
          bot,
          (markPacketSent) =>
            activateEntityCancellable(bot, entity, signal, markPacketSent),
          signal,
        );
        return;
      }
      case "window_click": {
        const window = requireOpenWindow(bot);
        if (operation.slot >= window.slots.length)
          throw new Error(`Slot ${operation.slot} is outside the open window`);
        await bot.clickWindow(operation.slot, operation.button, operation.mode);
        return;
      }
      case "window_transfer": {
        const window = requireOpenWindow(bot);
        const registryItem = bot.registry.itemsByName[operation.item];
        if (registryItem === undefined)
          throw new Error(`Unknown registry item: ${operation.item}`);
        const sourceStart =
          operation.direction === "inventory_to_window"
            ? window.inventoryStart
            : 0;
        const sourceEnd =
          operation.direction === "inventory_to_window"
            ? window.inventoryEnd
            : window.inventoryStart;
        const sourceItem = window.slots
          .slice(sourceStart, sourceEnd)
          .find((item) => item?.type === registryItem.id);
        if (sourceItem == null)
          throw new Error(
            `${operation.item} is absent from the selected transfer source`,
          );
        await transferByClicks(
          bot,
          window,
          registryItem.id,
          sourceItem.metadata,
          operation.count,
          sourceStart,
          sourceEnd,
          operation.direction === "inventory_to_window"
            ? 0
            : window.inventoryStart,
          operation.direction === "inventory_to_window"
            ? window.inventoryStart
            : window.inventoryEnd,
          signal,
        );
        return;
      }
      case "window_close": {
        const window = requireOpenWindow(bot);
        bot.closeWindow(window);
        await waitTicks(2, signal);
        return;
      }
      case "consume": {
        const food = chooseFood(bot, operation.item);
        active.effectItemName = food.name;
        await bot.equip(food, "hand");
        if (signal.aborted) throw abortError(signal);
        await bot.consume();
        return;
      }
      case "toss": {
        const item = findInventoryItem(bot, operation.item);
        await bot.toss(item.type, item.metadata, operation.count);
        return;
      }
      case "collect_item":
        await this.collectItem(bot, operation.entityId, signal, active);
        return;
      case "transfer":
        await moveSlotWithClicks(
          bot,
          operation.sourceSlot,
          operation.destinationSlot,
          signal,
        );
        return;
      case "fish":
        {
          const rod = bot.inventory
            .items()
            .find((item) => item.name === "fishing_rod");
          if (rod === undefined)
            throw new Error("A fishing_rod is required to fish");
          if (bot.heldItem?.name !== rod.name) {
            await bot.equip(rod, "hand");
            if (signal.aborted) throw abortError(signal);
          }
        }
        await fishWithCancellation(bot, signal, (item) => {
          const caught = item.getDroppedItem();
          if (caught !== null)
            active.fishingCollectedItem = {
              name: caught.name,
              count: caught.count,
            };
        });
        await waitTicks(4, signal);
        return;
      case "sleep": {
        const bed = requireReachableBlock(bot, operation.position);
        if (!bot.isABed(bed)) throw new Error(`${bed.name} is not a bed`);
        await bot.sleep(bed);
        return;
      }
      case "wake":
        await bot.wake();
        return;
      case "mount": {
        const entity = requireVisibleEntity(
          bot,
          operation.entityId,
          interactRange,
        );
        bot.mount(entity);
        await waitTicks(4, signal);
        return;
      }
      case "dismount":
        bot.dismount();
        await waitTicks(2, signal);
        return;
      case "move_vehicle":
        for (let tick = 0; tick < operation.ticks; tick += 1) {
          if (signal.aborted) throw abortError(signal);
          bot.moveVehicle(operation.left, operation.forward);
          await waitTicks(1, signal);
        }
        bot.moveVehicle(0, 0);
        return;
      case "elytra_fly":
        await bot.elytraFly();
        return;
      case "trade": {
        if (bot.currentWindow !== null)
          throw new Error(
            "Close the current window before opening a villager trade",
          );
        const entity = requireVisibleEntity(
          bot,
          operation.entityId,
          interactRange,
        );
        const villager = await bot.openVillager(entity);
        if (signal.aborted) throw abortError(signal);
        const index =
          typeof operation.tradeIndex === "number"
            ? operation.tradeIndex
            : Number.parseInt(operation.tradeIndex, 10);
        const offer = villager.trades[index];
        if (Number.isInteger(index) && offer !== undefined) {
          active.expectedTrade = {
            input1Name: offer.inputItem1.name,
            input1Count:
              (offer.realPrice ?? offer.inputItem1.count) * operation.times,
            input2Name:
              offer.hasItem2 && offer.inputItem2 !== null
                ? offer.inputItem2.name
                : null,
            input2Count:
              offer.hasItem2 && offer.inputItem2 !== null
                ? offer.inputItem2.count * operation.times
                : 0,
            outputName: offer.outputItem.name,
            outputCount: offer.outputItem.count * operation.times,
          };
        }
        await bot.trade(villager, operation.tradeIndex, operation.times);
        return;
      }
      case "enchant": {
        if (bot.currentWindow !== null)
          throw new Error(
            "Close the current window before opening an enchanting table",
          );
        const block = requireReachableBlock(bot, operation.position);
        const table = await bot.openEnchantmentTable(block);
        if (signal.aborted) throw abortError(signal);
        const item = findInventoryItem(bot, operation.item);
        const lapis = findInventoryItem(bot, operation.lapisItem);
        await table.putTargetItem(item);
        throwIfAborted(signal);
        await table.putLapis(lapis);
        throwIfAborted(signal);
        await table.enchant(operation.choice);
        return;
      }
      case "anvil": {
        if (bot.currentWindow !== null)
          throw new Error("Close the current window before opening an anvil");
        const block = requireReachableBlock(bot, operation.position);
        const anvil = await bot.openAnvil(block);
        if (signal.aborted) throw abortError(signal);
        const item = findInventoryItem(bot, operation.firstItem);
        if (operation.operation === "rename")
          await anvil.rename(item, operation.name);
        else {
          const secondItem = operation.secondItem;
          if (secondItem === undefined)
            throw new Error("Combining items requires a second inventory item");
          const second = findInventoryItem(bot, secondItem);
          await anvil.combine(item, second, operation.name);
        }
        return;
      }
      case "write_book":
        await bot.writeBook(operation.slot, [...operation.pages]);
        return;
      case "update_sign": {
        const sign = requireReachableBlock(bot, operation.position);
        if (!sign.name.endsWith("sign"))
          throw new Error(`${sign.name} is not a sign block`);
        bot.updateSign(sign, operation.text.join("\n"), operation.back);
        await waitTicks(2, signal);
        return;
      }
    }
  }

  private async collectItem(
    bot: Bot,
    entityId: number,
    signal: AbortSignal,
    active: ActiveOperation,
  ): Promise<void> {
    let pathPromise: Promise<void> | undefined;
    let pathTargetKey: string | undefined;
    let settledTargetKey: string | undefined;
    let settledTargetSince: number | undefined;
    let pathFailurePromise: Promise<never> | undefined;
    let rejectPathFailure: ((error: ItemCollectionError) => void) | undefined;
    const onPathUpdate = (results: {
      readonly status: string;
      readonly path?: readonly unknown[];
    }): void => {
      if (results.status === "noPath" || results.status === "timeout")
        rejectPathFailure?.(
          new ItemCollectionError(
            "path_failed",
            "The normal pathfinder could not reach the visible item target.",
            results.status === "noPath" ? "no_path" : "path_timeout",
          ),
        );
    };
    bot.on("path_update", onPathUpdate);

    const stopPath = async (): Promise<void> => {
      const pendingPath = pathPromise;
      if (pendingPath === undefined) return;
      pathPromise = undefined;
      pathTargetKey = undefined;
      pathFailurePromise = undefined;
      rejectPathFailure = undefined;
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // A disconnect can make the pathfinder unavailable during cleanup.
      }
      await pendingPath.catch(() => undefined);
    };

    try {
      const initial = this.safeObserve(bot);
      if (initial === null)
        throw new ItemCollectionError(
          "target_unobservable",
          "The requested item is not currently visible.",
        );
      const initiallyVisible = initial.perception.entities.find(
        (entity) => entity.id === entityId,
      );
      if (initiallyVisible === undefined) {
        const outcome =
          bot.entities[entityId] === undefined
            ? "entity_removed"
            : "target_unobservable";
        throw new ItemCollectionError(
          outcome,
          outcome === "entity_removed"
            ? "The requested item entity has left the current client entity table."
            : "The requested item entity is not currently visible.",
        );
      }
      if (initiallyVisible.name !== "item")
        throw new ItemCollectionError(
          "invalid_target",
          "The requested visible entity is not an item entity.",
        );

      while (active.itemCollectionOutcome !== "collected") {
        throwIfAborted(signal);

        const observation = this.safeObserve(bot);
        if (observation === null)
          throw new ItemCollectionError(
            "target_unobservable",
            "The current view is unavailable; item pursuit was stopped.",
          );
        const target = observation.perception.entities.find(
          (entity) => entity.id === entityId,
        );
        if (target === undefined) {
          const outcome =
            bot.entities[entityId] === undefined
              ? "entity_removed"
              : "target_unobservable";
          throw new ItemCollectionError(
            outcome,
            outcome === "entity_removed"
              ? "The requested item entity left the current client entity table before collection was observed."
              : "The requested item is no longer visible; pursuit was stopped.",
          );
        }
        if (target.name !== "item")
          throw new ItemCollectionError(
            "invalid_target",
            "The requested entity is no longer an item entity.",
          );

        const playerPosition = observation.self.position;
        const targetPosition = target.position;
        const distance = new Vec3(
          playerPosition.x,
          playerPosition.y,
          playerPosition.z,
        ).distanceTo(
          new Vec3(targetPosition.x, targetPosition.y, targetPosition.z),
        );
        if (distance <= itemCollectionPickupDistance) {
          await stopPath();
          await waitForItemCollectionPoll(signal);
          continue;
        }

        const targetKey = blockKey(targetPosition);
        if (pathPromise !== undefined && pathTargetKey !== targetKey)
          await stopPath();

        if (pathPromise === undefined && settledTargetKey === targetKey) {
          if (
            settledTargetSince !== undefined &&
            Date.now() - settledTargetSince < itemCollectionPickupGraceMs
          ) {
            await waitForItemCollectionPoll(signal);
            continue;
          }
          throw new ItemCollectionError(
            "pickup_out_of_range",
            "The pathfinder reached a nearby block, but the visible item remained outside pickup range.",
          );
        }

        if (pathPromise === undefined) {
          settledTargetKey = undefined;
          settledTargetSince = undefined;
          pathTargetKey = targetKey;
          pathFailurePromise = new Promise<never>((_resolve, reject) => {
            rejectPathFailure = reject;
          });
          void pathFailurePromise.catch(() => undefined);
          pathPromise = bot.pathfinder.goto(
            new goals.GoalNear(
              targetPosition.x,
              targetPosition.y,
              targetPosition.z,
              itemCollectionGoalRange,
            ),
          );
        }

        const pendingPath = pathPromise;
        const pendingFailure = pathFailurePromise;
        const pathResult = pendingPath.then(
          () => "goal_reached" as const,
          (error: unknown) => {
            throw new ItemCollectionError(
              "path_failed",
              "Normal pathfinding to the visible item target failed.",
              classifyItemCollectionPathFailure(error),
            );
          },
        );
        await Promise.race([
          pathResult,
          waitForItemCollectionPoll(signal).then(() => "poll" as const),
          pendingFailure,
        ]).then((result) => {
          if (result === "goal_reached") {
            settledTargetKey = pathTargetKey;
            settledTargetSince = Date.now();
            pathPromise = undefined;
            pathTargetKey = undefined;
            pathFailurePromise = undefined;
            rejectPathFailure = undefined;
          }
        });
      }
      await stopPath();
    } finally {
      bot.removeListener("path_update", onPathUpdate);
      await stopPath();
    }
  }

  private async runLookSweep(
    bot: Bot,
    operation: Extract<PlayerOperation, { kind: "look_sweep" }>,
    signal: AbortSignal,
    active: ActiveOperation,
  ): Promise<void> {
    const current = this.safeObserve(bot);
    if (current === null)
      throw new Error("Current view is unavailable for a look sweep");
    const currentView = summarizeLookSweepView(current, null);
    let lookSweep = playerBodyLookSweepSchema.parse({
      current: currentView,
      directions: [],
      plannedDirectionCount: playerBodyLookSweepDirectionCount,
      complete: false,
      candidateSearchMayBeTruncated: currentView.candidateSearchMayBeTruncated,
      worldAbsenceEstablished: false,
    });
    active.lookSweep = lookSweep;

    const baseYaw = current.self.yaw;
    if (!Number.isFinite(baseYaw) || !Number.isFinite(current.self.pitch))
      throw new Error("Current view angles are unavailable for a look sweep");
    const origin = current.self.position;
    const eye = new Vec3(origin.x, origin.y + current.self.eyeHeight, origin.z);
    const horizontalDistance = 8;
    const pitchRadians = ((operation.pitchDegrees ?? -25) * Math.PI) / 180;
    const verticalOffset = Math.tan(pitchRadians) * horizontalDistance;

    for (
      let directionIndex = 0;
      directionIndex < playerBodyLookSweepDirectionCount;
      directionIndex += 1
    ) {
      throwIfAborted(signal);
      const yaw =
        baseYaw +
        (directionIndex * Math.PI * 2) / playerBodyLookSweepDirectionCount;
      const target = eye.offset(
        -Math.sin(yaw) * horizontalDistance,
        verticalOffset,
        -Math.cos(yaw) * horizontalDistance,
      );
      await bot.lookAt(target, true);
      throwIfAborted(signal);
      const observation = this.safeObserve(bot);
      if (observation === null)
        throw new Error("View observation is unavailable during look sweep");
      const view = summarizeLookSweepView(observation, directionIndex);
      lookSweep = playerBodyLookSweepSchema.parse({
        ...lookSweep,
        directions: [...lookSweep.directions, view],
        candidateSearchMayBeTruncated:
          lookSweep.candidateSearchMayBeTruncated ||
          view.candidateSearchMayBeTruncated,
      });
      active.lookSweep = lookSweep;
    }

    active.lookSweep = playerBodyLookSweepSchema.parse({
      ...lookSweep,
      complete: true,
    });
  }

  private bindBot(bot: Bot): void {
    if (this.boundBot === bot) return;
    for (const detach of this.botHandlers.splice(0)) detach();
    for (const detach of this.inventoryHandlers.splice(0)) detach();
    this.inventoryBoundBot = undefined;
    for (const detach of this.windowUpdateHandlers.values()) detach();
    this.windowUpdateHandlers.clear();
    for (const timer of this.stateTimers.values()) clearTimeout(timer);
    this.stateTimers.clear();
    this.boundBot = bot;
    this.lastStateSignatures.clear();
    const listen = (
      event: keyof BotEvents,
      handler: (...args: never[]) => void,
    ): void => {
      const typedHandler = handler as never;
      bot.on(event, typedHandler);
      this.botHandlers.push(() => bot.removeListener(event, typedHandler));
    };
    const state =
      (
        reason: Extract<PlayerBodyEvent, { type: "state_changed" }>["reason"],
      ): (() => void) =>
      () =>
        this.scheduleStateEvent(reason);
    listen("health", state("vitals"));
    listen("breath", state("vitals"));
    listen("experience", state("vitals"));
    listen("heldItemChanged", state("inventory"));
    listen("playerCollect", state("inventory"));
    listen("windowOpen", (window: Window) => {
      this.scheduleStateEvent("window");
      this.windowUpdateHandlers.get(window)?.();
      const onWindowUpdate = (): void => this.scheduleStateEvent("window");
      const events = slotUpdateEvents(window);
      events.on("updateSlot", onWindowUpdate);
      this.windowUpdateHandlers.set(window, () =>
        events.removeListener("updateSlot", onWindowUpdate),
      );
    });
    listen("windowClose", (window: Window | null) => {
      this.scheduleStateEvent("window");
      if (window === null) return;
      const detach = this.windowUpdateHandlers.get(window);
      if (detach === undefined) return;
      detach();
      this.windowUpdateHandlers.delete(window);
    });
    listen("blockUpdate", state("blocks"));
    listen("time", state("time"));
    listen("move", state("position"));
    listen("entitySpawn", state("entities"));
    listen("entityGone", state("entities"));
    listen("entityMoved", state("entities"));
    listen("entityUpdate", state("entities"));
    listen("death", () =>
      this.emit({ type: "bot_death", at: new Date().toISOString() }),
    );
    listen("end", (reason: unknown) => {
      this.disconnectedSinceBind = true;
      if (this.active?.bot === bot) {
        this.active.botDisconnected = true;
        if (this.active.runFinished) this.active = undefined;
      }
      this.emit({
        type: "disconnected",
        at: new Date().toISOString(),
        reason:
          typeof reason === "string"
            ? reason.slice(0, 200)
            : "connection ended",
      });
    });
    listen("spawn", () => {
      if (this.disconnectedSinceBind) {
        this.disconnectedSinceBind = false;
        this.emit({ type: "reconnected", at: new Date().toISOString() });
      }
      this.scheduleStateEvent("position");
    });
    this.bindInventoryEventsWhenReady(bot);
  }

  private bindInventoryEventsWhenReady(bot: Bot): void {
    if (this.boundBot !== bot || this.inventoryBoundBot === bot) return;
    const inventory = initializedInventory(bot);
    if (inventory !== undefined) {
      this.inventoryBoundBot = bot;
      const onInventoryUpdate = (): void =>
        this.scheduleStateEvent("inventory");
      inventory.on("updateSlot", onInventoryUpdate);
      this.inventoryHandlers.push(() =>
        inventory.removeListener("updateSlot", onInventoryUpdate),
      );
      return;
    }

    const onPluginsInjected = (): void => {
      // Mineflayer injects its plugins synchronously while emitting this event.
      // Run after all listeners so the inventory plugin has installed its API.
      queueMicrotask(() => this.bindInventoryEventsWhenReady(bot));
    };
    bot.once("inject_allowed", onPluginsInjected);
    this.botHandlers.push(() =>
      bot.removeListener("inject_allowed", onPluginsInjected),
    );
  }

  private scheduleStateEvent(
    reason: Extract<PlayerBodyEvent, { type: "state_changed" }>["reason"],
  ): void {
    if (this.stateTimers.has(reason)) return;
    const timer = setTimeout(
      () => {
        this.stateTimers.delete(reason);
        const bot = this.boundBot;
        if (bot === undefined) return;
        const observation = this.safeObserve(bot);
        if (observation === null) return;
        const signature = semanticSignature(observation, reason);
        if (this.lastStateSignatures.get(reason) === signature) return;
        this.lastStateSignatures.set(reason, signature);
        this.emit({
          type: "state_changed",
          at: observation.observedAt,
          reason,
        });
      },
      reason === "entities" || reason === "blocks" ? 300 : 150,
    );
    this.stateTimers.set(reason, timer);
  }

  private emit(event: PlayerBodyEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Event consumers are isolated from Mineflayer's packet/event loop.
      }
    }
  }
}

function findInventoryItem(bot: Bot, name: string): Item {
  const item = bot.inventory
    .items()
    .find((candidate) => candidate.name === name);
  if (item === undefined)
    throw new Error(`Item not present in inventory: ${name}`);
  return item;
}

function chooseFood(bot: Bot, requested?: string): Item {
  const candidates = bot.inventory
    .items()
    .filter(
      (item) =>
        bot.registry.foodsByName[item.name] !== undefined &&
        (requested === undefined || item.name === requested),
    );
  const food = candidates.sort(
    (left, right) =>
      (bot.registry.foodsByName[right.name]?.effectiveQuality ?? 0) -
      (bot.registry.foodsByName[left.name]?.effectiveQuality ?? 0),
  )[0];
  if (food === undefined)
    throw new Error(
      requested === undefined
        ? "No edible item is present in inventory"
        : `No edible ${requested} is present in inventory`,
    );
  return food;
}

function requireReachableBlock(
  bot: Bot,
  rawPosition: { readonly x: number; readonly y: number; readonly z: number },
): Block {
  const position = blockPosition(rawPosition);
  const block = bot.blockAt(position);
  if (block === null)
    throw new Error("Target block is outside loaded world data");
  const target = block.position.offset(0.5, 0.5, 0.5);
  const eye = bot.entity.position.offset(0, entityEyeHeight(bot.entity), 0);
  if (eye.distanceTo(target) > interactRange + 0.15)
    throw new Error("Target block is outside normal player reach");
  if (!bot.canSeeBlock(block)) throw new Error("Target block is occluded");
  const visible = observePlayerBody(bot, undefined).perception.blocks.some(
    (candidate) => blockKey(candidate.position) === blockKey(position),
  );
  if (!visible)
    throw new Error("Target block is outside the current field of view");
  return block;
}

function requireVisibleEntity(
  bot: Bot,
  entityId: number,
  reach: number,
): Entity {
  const entity = bot.entities[entityId];
  if (entity === undefined)
    throw new Error(`Entity ${entityId} is not currently loaded`);
  const visible = observePlayerBody(bot, undefined).perception.entities.some(
    (candidate) => candidate.id === entityId,
  );
  if (!visible) throw new Error(`Entity ${entityId} is not currently visible`);
  const eye = bot.entity.position.offset(0, entityEyeHeight(bot.entity), 0);
  const target = entity.position.offset(
    0,
    Math.max(0.1, entity.height * 0.55),
    0,
  );
  if (eye.distanceTo(target) > reach)
    throw new Error(`Entity ${entityId} is outside normal player reach`);
  return entity;
}

function requireOpenWindow(bot: Bot): Window {
  if (bot.currentWindow === null)
    throw new Error("No block or entity window is open");
  return bot.currentWindow;
}

function fishWithCancellation(
  bot: Bot,
  signal: AbortSignal,
  onCollected: (item: Entity) => void,
): Promise<void> {
  const client = bot._client as unknown as PacketClient;
  return new Promise<void>((resolve, reject) => {
    let bobberId: number | undefined;
    let bobberPosition: Vec3 | undefined;
    let hooked = false;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      client.removeListener("spawn_entity", onSpawn);
      client.removeListener("world_particles", onParticles);
      client.removeListener("entity_destroy", onDestroy);
      bot.removeListener("playerCollect", onCollect);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onSpawn = (raw: unknown): void => {
      if (typeof raw !== "object" || raw === null) return;
      const packet = raw as {
        readonly entityId?: unknown;
        readonly type?: unknown;
        readonly x?: unknown;
        readonly y?: unknown;
        readonly z?: unknown;
      };
      const fishingBobberId = bot.registry.entitiesByName.fishing_bobber?.id;
      const matches =
        fishingBobberId === undefined
          ? packet.type === 90
          : packet.type === fishingBobberId;
      if (!matches || typeof packet.entityId !== "number") return;
      bobberId = packet.entityId;
      const entity = bot.entities[bobberId];
      if (entity !== undefined) bobberPosition = entity.position.clone();
      else if (
        typeof packet.x === "number" &&
        typeof packet.y === "number" &&
        typeof packet.z === "number"
      )
        bobberPosition = new Vec3(packet.x, packet.y, packet.z);
    };
    const onParticles = (raw: unknown): void => {
      if (
        bobberId === undefined ||
        hooked ||
        typeof raw !== "object" ||
        raw === null
      )
        return;
      const packet = raw as {
        readonly particle?: { readonly type?: unknown };
        readonly particleId?: unknown;
        readonly amount?: unknown;
        readonly particles?: unknown;
        readonly x?: unknown;
        readonly z?: unknown;
      };
      const kind = packet.particle?.type;
      const expectedIds = [
        bot.registry.particlesByName.fishing?.id,
        bot.registry.particlesByName.bubble?.id,
      ].filter((id): id is number => typeof id === "number");
      const isFishingParticle =
        kind === "fishing" ||
        kind === "bubble" ||
        (typeof packet.particleId === "number" &&
          expectedIds.includes(packet.particleId));
      const amount = packet.amount ?? packet.particles;
      const position = bot.entities[bobberId]?.position ?? bobberPosition;
      if (
        !isFishingParticle ||
        amount !== 6 ||
        position === undefined ||
        typeof packet.x !== "number" ||
        typeof packet.z !== "number" ||
        position.distanceTo(new Vec3(packet.x, position.y, packet.z)) > 1.23
      )
        return;
      hooked = true;
      bobberPosition = position.clone();
      bot.activateItem();
    };
    const onDestroy = (raw: unknown): void => {
      if (bobberId === undefined || typeof raw !== "object" || raw === null)
        return;
      const packet = raw as { readonly entityIds?: readonly unknown[] };
      if (packet.entityIds?.includes(bobberId) && !hooked)
        finish(
          new Error("Fishing bobber disappeared before a bite was observed"),
        );
    };
    const onCollect = (collector: Entity, collected: Entity): void => {
      if (
        hooked &&
        collector.id === bot.entity.id &&
        collected.name === "item" &&
        bobberPosition !== undefined &&
        collected.position.distanceTo(bobberPosition) <= 6
      ) {
        onCollected(collected);
        finish();
      }
    };
    const onAbort = (): void => {
      try {
        bot.deactivateItem();
        if (bobberId !== undefined) bot.activateItem();
      } catch {
        // The server may already have removed the bobber or connection.
      }
      finish(abortError(signal));
    };

    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    client.on("spawn_entity", onSpawn);
    client.on("world_particles", onParticles);
    client.on("entity_destroy", onDestroy);
    bot.on("playerCollect", onCollect);
    signal.addEventListener("abort", onAbort, { once: true });
    bot.activateItem();
  });
}

async function activateBlockCancellable(
  bot: Bot,
  block: Block,
  signal: AbortSignal,
  markPacketSent?: () => void,
): Promise<void> {
  await waitForAction(
    bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false),
    signal,
  );
  throwIfAborted(signal);
  const client = bot._client as unknown as PacketClient;
  const directionNumber = 1;
  const cursor = new Vec3(0.5, 0.5, 0.5);
  const writePacket = (packet: unknown): void => {
    client.write("block_place", packet);
    markPacketSent?.();
  };
  if (bot.supportFeature("blockPlaceHasHeldItem")) {
    const Item = loadPrismarineItem(bot.registry);
    writePacket({
      location: block.position,
      direction: directionNumber,
      heldItem: Item.toNotch(heldItemOrNull(bot)),
      cursorX: cursor.x * 16,
      cursorY: cursor.y * 16,
      cursorZ: cursor.z * 16,
    });
  } else if (bot.supportFeature("blockPlaceHasHandAndIntCursor")) {
    writePacket({
      location: block.position,
      direction: directionNumber,
      hand: 0,
      cursorX: cursor.x * 16,
      cursorY: cursor.y * 16,
      cursorZ: cursor.z * 16,
    });
  } else if (bot.supportFeature("blockPlaceHasHandAndFloatCursor")) {
    writePacket({
      location: block.position,
      direction: directionNumber,
      hand: 0,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorZ: cursor.z,
    });
  } else if (bot.supportFeature("blockPlaceHasInsideBlock")) {
    writePacket({
      location: block.position,
      direction: directionNumber,
      hand: 0,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cursorZ: cursor.z,
      insideBlock: false,
      sequence: 0,
      worldBorderHit: false,
    });
  } else {
    throw new Error(
      "This Minecraft protocol has no supported block-use packet",
    );
  }
  bot.swingArm("right");
}

async function activateEntityCancellable(
  bot: Bot,
  entity: Entity,
  signal: AbortSignal,
  markPacketSent?: () => void,
): Promise<void> {
  await waitForAction(
    bot.lookAt(entity.position.offset(0, 1, 0), false),
    signal,
  );
  throwIfAborted(signal);
  const client = bot._client as unknown as PacketClient;
  client.write("use_entity", {
    target: entity.id,
    mouse: 0,
    sneaking: false,
    hand: 0,
  });
  markPacketSent?.();
}

async function placeBlockCancellable(
  bot: Bot,
  referenceBlock: Block,
  face: Vec3,
  signal: AbortSignal,
): Promise<void> {
  const point = referenceBlock.position.offset(
    0.5 + face.x * 0.5,
    0.5 + face.y * 0.5,
    0.5 + face.z * 0.5,
  );
  await waitForAction(bot.lookAt(point, true), signal);
  throwIfAborted(signal);
  const internal = bot as Bot & {
    _genericPlace?: (
      block: Block,
      direction: Vec3,
      options: { readonly forceLook: "ignore"; readonly swingArm: "right" },
    ) => Promise<Vec3>;
  };
  if (internal._genericPlace === undefined)
    throw new Error(
      "This Mineflayer version has no cancellable generic block placement primitive",
    );
  await internal._genericPlace(referenceBlock, face, {
    forceLook: "ignore",
    swingArm: "right",
  });
}

function openWindowCancellable(
  bot: Bot,
  activate: (markPacketSent: () => void) => Promise<void>,
  signal: AbortSignal,
): Promise<Window> {
  return new Promise<Window>((resolve, reject) => {
    let finished = false;
    let packetSent = false;
    let abortedAfterPacket = false;
    const finish = (error?: unknown, window?: Window): void => {
      if (finished) return;
      finished = true;
      bot.removeListener("windowOpen", onOpen);
      bot.removeListener("end", onEnd);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined)
        reject(
          error instanceof Error
            ? error
            : new Error("Mineflayer window activation failed"),
        );
      else if (window !== undefined) resolve(window);
      else reject(new Error("Window opened without a Mineflayer window"));
    };
    const onOpen = (window: Window): void => {
      if (abortedAfterPacket) {
        if (bot.currentWindow === window) {
          try {
            bot.closeWindow(window);
          } catch {
            // A disconnect will settle this operation if closing is no longer possible.
            return;
          }
        }
        finish(abortError(signal));
        return;
      }
      finish(undefined, window);
    };
    const onEnd = (): void =>
      finish(new Error("Minecraft disconnected while opening a window"));
    const onAbort = (): void => {
      if (packetSent) {
        abortedAfterPacket = true;
        return;
      }
      finish(abortError(signal));
    };
    const markPacketSent = (): void => {
      packetSent = true;
    };
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    bot.on("windowOpen", onOpen);
    bot.once("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
    void activate(markPacketSent).catch((error: unknown) => {
      if (!packetSent) finish(error);
    });
  });
}

async function clickWindowCancellable(
  bot: Bot,
  slot: number,
  button: number,
  mode: number,
  signal: AbortSignal,
): Promise<void> {
  await bot.clickWindow(slot, button, mode);
  if (signal.aborted) throw abortError(signal);
}

async function transferByClicks(
  bot: Bot,
  window: Window,
  itemType: number,
  metadata: number,
  count: number,
  sourceStart: number,
  sourceEnd: number,
  destinationStart: number,
  destinationEnd: number,
  signal: AbortSignal,
): Promise<void> {
  if (selectedItem(window) !== null)
    throw new Error(
      "Close or empty the carried cursor item before transferring",
    );
  let remaining = count;
  let lastSourceSlot: number | undefined;
  while (remaining > 0) {
    if (signal.aborted) throw abortError(signal);
    let held = selectedItem(window);
    if (held?.type !== itemType || held.metadata !== metadata) {
      const source = window.findItemRange(
        sourceStart,
        sourceEnd,
        itemType,
        metadata,
        false,
        null,
      );
      if (source === null)
        throw new Error(
          "The requested item count is not available in the transfer source",
        );
      lastSourceSlot = source.slot;
      await clickWindowCancellable(bot, source.slot, 0, 0, signal);
      held = selectedItem(window);
    }
    if (held?.type !== itemType || held.metadata !== metadata)
      throw new Error("The server did not select the requested transfer item");
    const destination = window.findItemRange(
      destinationStart,
      destinationEnd,
      itemType,
      metadata,
      true,
      null,
    );
    const destinationSlot =
      destination?.slot ??
      window.firstEmptySlotRange(destinationStart, destinationEnd);
    if (destinationSlot === null)
      throw new Error("Transfer destination is full");
    const destinationCount = destination?.count ?? 0;
    const capacity = held.stackSize - destinationCount;
    const amount = Math.min(capacity, held.count);
    if (amount <= 0)
      throw new Error("Transfer destination has no capacity for this item");
    if (amount <= remaining) {
      await clickWindowCancellable(bot, destinationSlot, 0, 0, signal);
      remaining -= amount;
    } else {
      await clickWindowCancellable(bot, destinationSlot, 1, 0, signal);
      remaining -= 1;
    }
  }
  if (selectedItem(window) !== null && lastSourceSlot !== undefined)
    await clickWindowCancellable(bot, lastSourceSlot, 0, 0, signal);
}

async function moveSlotWithClicks(
  bot: Bot,
  sourceSlot: number,
  destinationSlot: number,
  signal: AbortSignal,
): Promise<void> {
  if (sourceSlot === destinationSlot)
    throw new Error("Source and destination slots must differ");
  const window = activeWindow(bot);
  if (
    sourceSlot >= window.slots.length ||
    destinationSlot >= window.slots.length
  )
    throw new Error("A requested slot is outside the current window");
  if (selectedItem(window) !== null)
    throw new Error(
      "Close or empty the carried cursor item before transferring",
    );
  if (window.slots[sourceSlot] === null)
    throw new Error("The requested source slot is empty");
  try {
    await clickWindowCancellable(bot, sourceSlot, 0, 0, signal);
    throwIfAborted(signal);
    await clickWindowCancellable(bot, destinationSlot, 0, 0, signal);
    throwIfAborted(signal);
    if (selectedItem(window) !== null)
      await clickWindowCancellable(bot, sourceSlot, 0, 0, signal);
  } catch (error) {
    if (selectedItem(window) !== null) {
      try {
        await bot.clickWindow(sourceSlot, 0, 0);
      } catch {
        // The window close cleanup is the fallback for an unresponsive inventory transaction.
      }
    }
    throw error;
  }
}

function faceVector(
  face: NonNullable<Extract<PlayerOperation, { kind: "place" }>["face"]>,
): Vec3 {
  switch (face) {
    case "up":
      return new Vec3(0, 1, 0);
    case "down":
      return new Vec3(0, -1, 0);
    case "north":
      return new Vec3(0, 0, -1);
    case "south":
      return new Vec3(0, 0, 1);
    case "east":
      return new Vec3(1, 0, 0);
    case "west":
      return new Vec3(-1, 0, 0);
  }
}
