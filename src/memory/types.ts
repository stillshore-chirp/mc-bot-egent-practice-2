/**
 * The memory boundary only accepts JSON-shaped, structured values.  This keeps
 * persistence independent from chat transcripts and makes records portable
 * across application restarts.
 */
export type JsonPrimitive = boolean | number | string | null;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export const factSources = [
  "player_stated",
  "minecraft_observed",
  "bot_inferred",
  "system",
] as const;
export type FactSource = (typeof factSources)[number];

export const factStatuses = ["active", "superseded", "retracted"] as const;
export type FactStatus = (typeof factStatuses)[number];

export const commitmentStatuses = ["active", "completed", "cancelled"] as const;
export type CommitmentStatus = (typeof commitmentStatuses)[number];

export const taskRunStatuses = [
  "queued",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskRunStatus = (typeof taskRunStatuses)[number];

export const memoryKinds = [
  "fact",
  "location",
  "commitment",
  "episode",
  "task",
  "life_state",
  "world_memory",
] as const;
export type MemoryKind = (typeof memoryKinds)[number];

export const worldMemoryKinds = ["resource", "hazard", "structure"] as const;
export type WorldMemoryKind = (typeof worldMemoryKinds)[number];

export const worldMemoryStatuses = [
  "active",
  "superseded",
  "retracted",
] as const;
export type WorldMemoryStatus = (typeof worldMemoryStatuses)[number];

export interface PlayerRecord {
  readonly id: string;
  readonly externalName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelationshipRecord {
  readonly playerId: string;
  readonly trust: number;
  readonly intimacy: number;
  readonly state: Readonly<Record<string, JsonValue>>;
  readonly updatedAt: string;
}

export interface FactRecord {
  readonly id: string;
  readonly playerId: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: JsonValue;
  readonly source: FactSource;
  readonly status: FactStatus;
  readonly dedupeKey: string;
  readonly supersededById?: string;
  readonly retractionReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocationRecord {
  readonly id: string;
  readonly playerId: string;
  readonly name: string;
  readonly purpose: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommitmentRecord {
  readonly id: string;
  readonly playerId: string;
  readonly description: string;
  readonly status: CommitmentStatus;
  readonly progress: readonly string[];
  readonly blockers: readonly string[];
  readonly outcome?: JsonValue;
  readonly completionVerification?: {
    readonly source: "owner_confirmation" | "verified_tool_result";
    readonly evidence: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface EpisodeRecord {
  readonly id: string;
  readonly playerId: string;
  readonly summary: string;
  readonly importance: number;
  readonly source: FactSource;
  readonly details: Readonly<Record<string, JsonValue>>;
  readonly observedAt: string;
  readonly createdAt: string;
}

export interface LifeHomeBase {
  readonly name: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface LifePossession {
  readonly name: string;
  readonly quantity: number;
}

export interface LifeStateRecord {
  readonly currentInterests: readonly string[];
  readonly longTermGoals: readonly string[];
  readonly homeBase?: LifeHomeBase;
  readonly possessions: readonly LifePossession[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorldMemoryRecord {
  readonly id: string;
  readonly kind: WorldMemoryKind;
  readonly name: string;
  readonly description: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly source: FactSource;
  readonly status: WorldMemoryStatus;
  readonly dedupeKey: string;
  readonly supersededById?: string;
  readonly retractionReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskCheckpoint {
  readonly id: string;
  readonly taskRunId: string;
  readonly sequence: number;
  readonly phase: string;
  readonly data: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
}

export interface StoredFailure {
  readonly category: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly confirmedState?: Readonly<Record<string, JsonValue>>;
}

export interface TaskRunRecord {
  readonly id: string;
  readonly playerId?: string;
  readonly kind: string;
  readonly status: TaskRunStatus;
  readonly phase: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly output?: JsonValue;
  readonly failure?: StoredFailure;
  readonly checkpoint?: TaskCheckpoint;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecallItem {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly recordedAt: string;
}

export interface RememberPlayerFactInput {
  readonly playerId: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: JsonValue;
  readonly source: FactSource;
}

export interface RememberLocationInput {
  readonly playerId: string;
  readonly name: string;
  readonly purpose: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SetCommitmentInput {
  readonly playerId: string;
  readonly description: string;
  readonly progress?: readonly string[];
  readonly blockers?: readonly string[];
}

export interface UpdateCommitmentProgressInput {
  readonly commitmentId: string;
  readonly progress: readonly string[];
  readonly blockers: readonly string[];
}

export interface CompleteCommitmentInput {
  readonly playerId: string;
  readonly commitmentId: string;
  readonly outcome: JsonValue;
  readonly verificationSource: "owner_confirmation" | "verified_tool_result";
  readonly verificationEvidence: string;
}

export interface RecordEpisodeInput {
  readonly playerId: string;
  readonly summary: string;
  readonly importance?: number;
  readonly source?: FactSource;
  readonly details?: Readonly<Record<string, JsonValue>>;
  readonly observedAt?: string;
}

export interface RecallInput {
  readonly playerId: string;
  readonly query: string;
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
}

export interface SaveLifeStateInput {
  readonly currentInterests: readonly string[];
  readonly longTermGoals: readonly string[];
  readonly homeBase?: LifeHomeBase;
  readonly possessions: readonly LifePossession[];
}

export interface RememberWorldMemoryInput {
  readonly kind: WorldMemoryKind;
  readonly name: string;
  readonly description: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly source: FactSource;
}

export interface CorrectWorldMemoryInput {
  readonly worldMemoryId: string;
  readonly replacement: RememberWorldMemoryInput;
}

export interface SearchWorldMemoriesInput {
  readonly query: string;
  readonly kinds?: readonly WorldMemoryKind[];
  readonly limit?: number;
}

export interface CreateTaskRunInput {
  readonly playerId?: string;
  readonly kind: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly status?: TaskRunStatus;
  readonly phase?: string;
}

export interface RecordTaskCheckpointInput {
  readonly taskRunId: string;
  readonly phase: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface UpdateTaskRunInput {
  readonly taskRunId: string;
  readonly status: TaskRunStatus;
  readonly phase: string;
  readonly output?: JsonValue;
  readonly failure?: StoredFailure;
  readonly checkpoint?: Readonly<Record<string, JsonValue>>;
}
