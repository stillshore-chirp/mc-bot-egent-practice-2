import type { ChestTarget } from "../memory/delivery-targets.js";
import type {
  Position,
  SurroundingsObservation,
  WorldSnapshot,
} from "../domain/snapshot.js";

export interface ResourceTarget {
  readonly name: string;
  readonly position: Position;
}

export type EscapeMode = "environment" | "hostile";

export interface StorageObservation {
  readonly chestCount: number;
  readonly playerCount: number;
  readonly revision: number;
  readonly epoch: string;
  readonly uncontested: boolean;
}
export interface StorageIdentity {
  readonly worldId: string;
  readonly identity: string | null;
  readonly observation?: StorageObservation | null;
}
export interface DepositResult {
  readonly requested: number;
  readonly deposited: number | null;
  readonly remaining: number | null;
  readonly heldCount: number | null;
  readonly verified: boolean;
  readonly reason:
    "completed" | "full" | "cancelled" | "changed" | "unverified" | "failed";
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
  storageIdentity(
    position: Position | null,
    register: boolean,
    signal: AbortSignal,
    resource?: string,
  ): Promise<StorageIdentity>;
  depositLogs(
    target: ChestTarget,
    resource: string,
    count: number,
    signal: AbortSignal,
  ): Promise<DepositResult>;
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
  escapeDanger(mode: EscapeMode, signal: AbortSignal): Promise<void>;
  recoverFromStuck(maxAttempts: number, signal: AbortSignal): Promise<void>;
  stopCurrentAction(): Promise<void>;
}

export interface MinecraftLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}
