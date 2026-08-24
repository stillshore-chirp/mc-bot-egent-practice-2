import type {
  Position,
  SurroundingsObservation,
  WorldSnapshot,
} from "../../src/domain/snapshot.js";
import type {
  MinecraftPort,
  ResourceTarget,
} from "../../src/minecraft/port.js";

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
  private pendingDrop: ResourceTarget | undefined;
  private readonly chatListeners = new Set<
    (username: string, message: string) => void
  >();
  private readonly disconnectListeners = new Set<(reason: string) => void>();

  public constructor(snapshot = createSnapshot()) {
    this.snapshot = snapshot;
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
    this.pendingDrop = target;
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

  public async escapeDanger(signal: AbortSignal): Promise<void> {
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
    this.actions.push("escape");
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
