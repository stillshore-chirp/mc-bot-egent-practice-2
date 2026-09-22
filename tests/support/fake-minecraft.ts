import type { ChestTarget } from "../../src/memory/delivery-targets.js";
import type {
  DepositResult,
  StorageIdentity,
} from "../../src/minecraft/port.js";
import type {
  Position,
  SurroundingsObservation,
  WorldSnapshot,
} from "../../src/domain/snapshot.js";
import type {
  EscapeMode,
  MinecraftPort,
  ResourceTarget,
} from "../../src/minecraft/port.js";
import { AppError } from "../../src/domain/errors.js";
import type {
  CollectItemInput,
  CraftItemInput,
  GeneralActionCandidate,
  GeneralActionObservationInput,
  MineBlockInput,
  PlaceBlockInput,
  SmeltItemInput,
} from "../../src/minecraft/general-actions.js";
import { goalMetadataForBlock } from "../../src/minecraft/general-actions.js";

const now = (): string => new Date().toISOString();

export function createSnapshot(
  overrides: Partial<WorldSnapshot> = {},
): WorldSnapshot {
  return {
    observedAt: now(),
    connected: true,
    spawned: true,
    dimension: "overworld",
    position: { x: 0, y: 64, z: 0 },
    velocityY: 0,
    health: 20,
    food: 20,
    oxygen: 20,
    onFire: false,
    inWater: false,
    inLava: false,
    suffocating: false,
    inventory: [],
    players: [
      { username: "owner", position: { x: 0, y: 64, z: 0 }, distance: 0 },
    ],
    nearbyEntities: [],
    ...overrides,
  };
}

export class FakeMinecraft implements MinecraftPort {
  public snapshot: WorldSnapshot;
  public resources: ResourceTarget[] = [];
  public readonly actions: string[] = [];
  public stopCount = 0;
  public actionGuardDecisions = new Map<
    string,
    "allowed" | "unknown" | "denied"
  >();
  public craftableItems = new Set<string>(["planks", "stick", "iron_pickaxe"]);
  public placedBlocks = new Map<string, string>();
  private pendingDrop: ResourceTarget | undefined;
  private readonly chatListeners = new Set<
    (username: string, message: string) => void
  >();
  private readonly disconnectListeners = new Set<(reason: string) => void>();

  public constructor(snapshot = createSnapshot()) {
    this.snapshot = snapshot;
  }

  public storageIdentities = new Map<string, string>();
  public async storageIdentity(
    position: Position | null,
    _register: boolean,
    signal: AbortSignal,
  ): Promise<StorageIdentity> {
    signal.throwIfAborted();
    return {
      position: { ...this.snapshot.position },
      worldId: "00000000-0000-4000-8000-000000000001",
      identity:
        position === null
          ? null
          : (this.storageIdentities.get(JSON.stringify(position)) ?? null),
    };
  }

  public chestCounts = new Map<string, number>();
  public chestCapacity = 64;
  public async depositLogs(
    target: ChestTarget,
    resource: string,
    count: number,
    signal: AbortSignal,
  ): Promise<DepositResult> {
    signal.throwIfAborted();
    if (
      this.storageIdentities.get(JSON.stringify(target.position)) !==
      target.identity
    )
      throw new Error("Chest changed");
    const held =
      this.snapshot.inventory.find((item) => item.name === resource)?.count ??
      0;
    const stored = this.chestCounts.get(resource) ?? 0;
    const deposited = Math.min(
      count,
      held,
      Math.max(0, this.chestCapacity - stored),
    );
    this.chestCounts.set(resource, stored + deposited);
    this.snapshot = {
      ...this.snapshot,
      inventory: this.snapshot.inventory.map((item) =>
        item.name === resource
          ? { ...item, count: item.count - deposited }
          : item,
      ),
    };
    this.actions.push(`deposit:${resource}:${deposited}`);
    return {
      requested: count,
      deposited,
      remaining: count - deposited,
      heldCount: held - deposited,
      verified: true,
      reason: deposited === count ? "completed" : "full",
    };
  }

  public async connect(): Promise<void> {
    this.actions.push("connect");
  }

  public async disconnect(): Promise<void> {
    this.actions.push("disconnect");
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

  public emitChat(username: string, message: string): void {
    for (const listener of this.chatListeners) listener(username, message);
  }

  public emitDisconnected(reason = "test disconnect"): void {
    for (const listener of this.disconnectListeners) listener(reason);
  }

  public async observe(): Promise<WorldSnapshot> {
    return structuredClone({ ...this.snapshot, observedAt: now() });
  }

  public async observeSurroundings(
    _radius: number,
    includeEntities: boolean,
  ): Promise<SurroundingsObservation> {
    return {
      observedAt: now(),
      blocks: this.resources.map((resource) => ({ ...resource, distance: 1 })),
      entities: includeEntities ? this.snapshot.nearbyEntities : [],
      hazards: [
        ...(this.snapshot.inLava ? ["lava"] : []),
        ...(this.snapshot.onFire ? ["fire"] : []),
      ],
    };
  }

  public async say(message: string): Promise<void> {
    this.actions.push(`say:${message}`);
  }

  public async moveTo(
    position: Position,
    _range: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.actions.push(
      `move:${String(position.x)},${String(position.y)},${String(position.z)}`,
    );
    this.snapshot = {
      ...this.snapshot,
      position,
      players: this.snapshot.players.map((player) => ({
        ...player,
        distance: Math.hypot(
          position.x - player.position.x,
          position.y - player.position.y,
          position.z - player.position.z,
        ),
      })),
    };
  }

  public async followPlayer(
    username: string,
    _range: number,
    _maxPathAttempts: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.actions.push(`follow:${username}`);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  public async findResources(
    names: readonly string[],
    _maxDistance: number,
    count: number,
  ): Promise<readonly ResourceTarget[]> {
    return this.resources
      .filter((resource) => names.includes(resource.name))
      .slice(0, count);
  }

  public async dig(target: ResourceTarget, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.actions.push(`dig:${target.name}`);
    const index = this.resources.findIndex(
      (resource) =>
        resource.name === target.name &&
        resource.position.x === target.position.x &&
        resource.position.y === target.position.y &&
        resource.position.z === target.position.z,
    );
    if (index < 0) throw new Error("RESOURCE_CHANGED");
    this.resources.splice(index, 1);
    this.pendingDrop = {
      ...target,
      name:
        {
          stone: "cobblestone",
          deepslate: "cobbled_deepslate",
          iron_ore: "raw_iron",
          deepslate_iron_ore: "raw_iron",
          gold_ore: "raw_gold",
          deepslate_gold_ore: "raw_gold",
          copper_ore: "raw_copper",
          deepslate_copper_ore: "raw_copper",
        }[target.name] ?? target.name,
    };
  }

  public async observeActionCandidates(
    input: GeneralActionObservationInput,
    signal: AbortSignal,
  ): Promise<readonly GeneralActionCandidate[]> {
    signal.throwIfAborted();
    const candidates: GeneralActionCandidate[] = [];
    for (const resource of this.resources.slice(0, input.maxCandidates)) {
      const key = `${resource.name}:${resource.position.x}:${resource.position.y}:${resource.position.z}`;
      const permission = this.actionGuardDecisions.get(key) ?? "allowed";
      const goalMetadata = goalMetadataForBlock(
        resource.name,
        new Set(input.requestedItems),
      );
      candidates.push({
        id: `mine_block:${key}`,
        label: `${resource.name}を採掘`,
        action: "mine_block",
        args: { name: resource.name, position: resource.position },
        steps: [
          {
            tool: "mine_block",
            input: { name: resource.name, position: resource.position },
          },
        ],
        observed: true,
        purposeFit:
          input.requestedItems.includes(resource.name) ||
          goalMetadata.goalItem !== undefined
            ? "direct"
            : "unknown",
        permission,
        safety:
          permission === "allowed"
            ? "allowed"
            : permission === "denied"
              ? "blocked"
              : "unknown",
        reversible: false,
        impact: "medium",
        operationClass: "natural_resource",
        requestedCount: 1,
        resourceName: resource.name,
        ...goalMetadata,
        distance: 1,
        order: candidates.length,
      });
    }
    return candidates;
  }

  public async mineBlock(
    target: MineBlockInput,
    signal: AbortSignal,
  ): Promise<void> {
    const key = `${target.name}:${target.position.x}:${target.position.y}:${target.position.z}`;
    const decision = this.actionGuardDecisions.get(key) ?? "allowed";
    if (decision !== "allowed") {
      throw new AppError({
        category: "safety",
        code: `ACTION_${decision.toUpperCase()}`,
        message: "server guard denied the requested block mutation",
        retryable: false,
        failedAt: "action_guard",
        confirmedState: { decision },
      });
    }
    await this.dig(target, signal);
  }

  public async collectItem(
    target: CollectItemInput,
    signal: AbortSignal,
  ): Promise<void> {
    const held =
      this.snapshot.inventory.find((entry) => entry.name === target.name)
        ?.count ?? 0;
    await this.collectDropsNear(
      target.position,
      target.name,
      held + target.count,
      signal,
    );
  }

  public async craftItem(
    target: CraftItemInput,
    signal: AbortSignal,
  ): Promise<number> {
    signal.throwIfAborted();
    if (!this.craftableItems.has(target.name)) {
      throw new AppError({
        category: "resource",
        code: "CRAFT_RECIPE_UNAVAILABLE",
        message: "no observed recipe",
        retryable: false,
        failedAt: "craft_item",
      });
    }
    const inventory = this.snapshot.inventory.map((entry) =>
      entry.name === target.name
        ? { ...entry, count: entry.count + target.count }
        : { ...entry },
    );
    if (!inventory.some((entry) => entry.name === target.name))
      inventory.push({ name: target.name, count: target.count });
    this.snapshot = { ...this.snapshot, inventory };
    this.actions.push(`craft:${target.name}:${target.count}`);
    return target.count;
  }

  public async placeBlock(
    target: PlaceBlockInput,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const key = `${target.position.x}:${target.position.y}:${target.position.z}`;
    const decision =
      this.actionGuardDecisions.get(`${target.name}:${key}`) ?? "allowed";
    if (decision !== "allowed") {
      throw new AppError({
        category: "safety",
        code: `ACTION_${decision.toUpperCase()}`,
        message: "server guard denied the requested block mutation",
        retryable: false,
        failedAt: "action_guard",
        confirmedState: { decision },
      });
    }
    this.placedBlocks.set(key, target.name);
    this.actions.push(`place:${target.name}:${key}`);
  }

  public async smeltItem(
    target: SmeltItemInput,
    signal: AbortSignal,
  ): Promise<number> {
    signal.throwIfAborted();
    const input = this.snapshot.inventory.find(
      (entry) => entry.name === target.input,
    );
    if (input === undefined || input.count < target.count) {
      throw new AppError({
        category: "inventory",
        code: "SMELT_INPUT_INSUFFICIENT",
        message: "insufficient smelting input",
        retryable: false,
        failedAt: "smelt_item",
      });
    }
    const inventory = this.snapshot.inventory.map((entry) => {
      if (entry.name === target.input)
        return { ...entry, count: entry.count - target.count };
      if (entry.name === target.output)
        return { ...entry, count: entry.count + target.count };
      return { ...entry };
    });
    if (!inventory.some((entry) => entry.name === target.output))
      inventory.push({ name: target.output, count: target.count });
    this.snapshot = { ...this.snapshot, inventory };
    this.actions.push(`smelt:${target.input}:${target.output}:${target.count}`);
    return target.count;
  }

  public async collectDropsNear(
    _position: Position,
    itemName: string,
    expectedInventoryCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (this.pendingDrop?.name !== itemName) throw new Error("DROP_NOT_FOUND");
    this.pendingDrop = undefined;
    const inventory = [...this.snapshot.inventory];
    const index = inventory.findIndex((entry) => entry.name === itemName);
    if (index >= 0)
      inventory[index] = { name: itemName, count: expectedInventoryCount };
    else inventory.push({ name: itemName, count: expectedInventoryCount });
    this.snapshot = { ...this.snapshot, inventory };
    this.actions.push(`collect:${itemName}`);
  }

  public async eatBestFood(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw signal.reason;
    this.snapshot = { ...this.snapshot, food: 20 };
    this.actions.push("eat:bread");
    return "bread";
  }

  public async escapeDanger(
    mode: EscapeMode,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.snapshot = {
      ...this.snapshot,
      inLava: false,
      inWater: false,
      onFire: false,
      suffocating: false,
      oxygen: 20,
      nearbyEntities: [],
    };
    this.actions.push(`escape:${mode}`);
  }

  public async recoverFromStuck(
    _maxAttempts: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.snapshot = {
      ...this.snapshot,
      position: { ...this.snapshot.position, x: this.snapshot.position.x + 1 },
    };
    this.actions.push("recover:stuck");
  }

  public async stopCurrentAction(): Promise<void> {
    this.stopCount += 1;
    this.actions.push("stop");
  }
}
