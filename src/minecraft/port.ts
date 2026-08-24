import type {
  Position,
  SurroundingsObservation,
  WorldSnapshot,
} from "../domain/snapshot.js";

export interface ResourceTarget {
  readonly name: string;
  readonly position: Position;
}

export interface MinecraftPort {
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  onChat(listener: (username: string, message: string) => void): () => void;
  onDisconnected(listener: (reason: string) => void): () => void;
  observe(): Promise<WorldSnapshot>;
  observeSurroundings(
    radius: number,
    includeEntities: boolean,
  ): Promise<SurroundingsObservation>;
  say(message: string): Promise<void>;
  moveTo(position: Position, range: number, signal: AbortSignal): Promise<void>;
  followPlayer(
    username: string,
    range: number,
    maxPathAttempts: number,
    signal: AbortSignal,
  ): Promise<void>;
  findResources(
    names: readonly string[],
    maxDistance: number,
    count: number,
  ): Promise<readonly ResourceTarget[]>;
  dig(target: ResourceTarget, signal: AbortSignal): Promise<void>;
  collectDropsNear(
    position: Position,
    itemName: string,
    expectedInventoryCount: number,
    signal: AbortSignal,
  ): Promise<void>;
  eatBestFood(signal: AbortSignal): Promise<string>;
  escapeDanger(signal: AbortSignal): Promise<void>;
  recoverFromStuck(maxAttempts: number, signal: AbortSignal): Promise<void>;
  stopCurrentAction(): Promise<void>;
}

export interface MinecraftLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}
