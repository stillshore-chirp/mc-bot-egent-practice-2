import type { ChestTarget } from "../memory/delivery-targets.js";
import type {
  ArmorSlot,
  Position,
  SurroundingsObservation,
  WorldSnapshot,
} from "../domain/snapshot.js";
import type {
  CollectItemInput,
  CraftItemInput,
  GeneralActionCandidate,
  GeneralActionObservationInput,
  MineBlockInput,
  PlaceBlockInput,
  SmeltItemInput,
} from "./general-actions.js";

export interface ResourceTarget {
  readonly name: string;
  readonly position: Position;
}

export type EscapeMode = "environment" | "hostile";

export interface ArmorEquipResult {
  readonly equipped: readonly ArmorSlot[];
  readonly failed: boolean;
}

export interface SafeMoveResult {
  readonly usedDescent: boolean;
  readonly predictedMaxDamage: number;
  readonly healthBefore: number;
  readonly healthAfter: number;
}

export interface StorageObservation {
  readonly chestCount: number;
  readonly playerCount: number;
  readonly revision: number;
  readonly epoch: string;
  readonly uncontested: boolean;
}
export interface StorageIdentity {
  readonly position?: Position | undefined;
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
  isExpectedDescentDamage(
    previous: WorldSnapshot,
    current: WorldSnapshot,
  ): boolean;
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
  moveToWithSafeDescent(
    position: Position,
    range: number,
    signal: AbortSignal,
  ): Promise<SafeMoveResult>;
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
    signal: AbortSignal,
  ): Promise<readonly ResourceTarget[]>;
  dig(target: ResourceTarget, signal: AbortSignal): Promise<void>;
  observeActionCandidates(
    input: GeneralActionObservationInput,
    signal: AbortSignal,
  ): Promise<readonly GeneralActionCandidate[]>;
  mineBlock(target: MineBlockInput, signal: AbortSignal): Promise<void>;
  collectItem(target: CollectItemInput, signal: AbortSignal): Promise<void>;
  craftItem(target: CraftItemInput, signal: AbortSignal): Promise<number>;
  placeBlock(target: PlaceBlockInput, signal: AbortSignal): Promise<void>;
  smeltItem(target: SmeltItemInput, signal: AbortSignal): Promise<number>;
  collectDropsNear(
    position: Position,
    itemName: string,
    expectedInventoryCount: number,
    signal: AbortSignal,
  ): Promise<void>;
  eatBestFood(signal: AbortSignal): Promise<string>;
  /** Returns true only after the server reports the target entity's death. */
  attackHostile(entityId: number, signal: AbortSignal): Promise<boolean>;
  retreatFromHostiles(signal: AbortSignal): Promise<void>;
  equipAvailableArmor(signal: AbortSignal): Promise<ArmorEquipResult>;
  escapeDanger(mode: EscapeMode, signal: AbortSignal): Promise<void>;
  recoverFromStuck(maxAttempts: number, signal: AbortSignal): Promise<void>;
  stopCurrentAction(): Promise<void>;
}

export interface MinecraftLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}
