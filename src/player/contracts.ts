import type { PlayerOperation } from "../minecraft/player-body-schema.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const companionMemoryKinds = [
  "fact",
  "preference",
  "interest",
  "episode",
  "world",
  "relationship",
  "life",
  "behavior",
  "skill_lesson",
  "goal",
  "commitment",
  "task",
  "other",
] as const;
export type CompanionMemoryKind = (typeof companionMemoryKinds)[number];

export const companionMemorySources = [
  "player_stated",
  "minecraft_observed",
  "bot_inferred",
  "system",
] as const;
export type CompanionMemorySource = (typeof companionMemorySources)[number];

export const companionMemoryStatuses = [
  "active",
  "superseded",
  "retracted",
  "archived",
] as const;
export type CompanionMemoryStatus = (typeof companionMemoryStatuses)[number];

export type CompanionGoalSource = "owner" | "persona" | "self";
export interface CompanionGoal {
  readonly title: string;
  readonly successCondition: string;
  readonly source: CompanionGoalSource;
}

export interface CompanionPlanStep {
  readonly operation: PlayerOperation;
  readonly expectedOutcome: string;
}

export interface CompanionPlan {
  readonly purpose: string;
  readonly steps: readonly CompanionPlanStep[];
}

export const companionPlanStepLimit = 3;

export interface CompanionActiveOperation {
  readonly operationId: string;
  readonly operation: PlayerOperation;
  readonly expectedOutcome: string;
  /** Declared plan purpose captured before dispatch; absent legacy values are unknown. */
  readonly purpose?: string | null | undefined;
  /** Allowlisted Body observation captured before dispatch; legacy values are unknown. */
  readonly preActionObservation?: CompanionBodyObservationEvidence | undefined;
  /** Runtime timestamp persisted before Body dispatch for stop/restart recovery. */
  readonly bodyStartedAt?: string | undefined;
}

export const companionOutcomeEvidenceSources = [
  "body_result",
  "runtime_exception",
  "owner_stop",
  "process_restart",
  "unknown",
] as const;
export type CompanionOutcomeEvidenceSource =
  (typeof companionOutcomeEvidenceSources)[number];

export const companionOutcomeReasonCodes = [
  "operation_mismatch",
  "recovery_required",
  "body_result_unavailable",
  "owner_stop_before_verification",
  "process_restart_before_verification",
  "unknown_registry_item",
  "item_not_in_inventory",
  "no_recipe_for_current_inventory_and_surface",
  "no_path",
  "path_timeout",
  "goto_rejected",
  "collected",
  "entity_removed",
  "target_unobservable",
  "invalid_target",
  "path_failed",
  "pickup_out_of_range",
  "deadline_expired",
  "failed",
  "interrupted",
  "unverified",
  "cancelled",
  "unknown",
] as const;
export type CompanionOutcomeReasonCode =
  (typeof companionOutcomeReasonCodes)[number];

/** Compact private evidence; arbitrary observation fields are intentionally excluded. */
export interface CompanionBodyObservationEvidence {
  readonly source: "minecraft" | "unknown";
  readonly observedAt: string | null;
  readonly dimension: string | null;
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  } | null;
  readonly yaw: number | null;
  readonly pitch: number | null;
  readonly health: number | null;
  readonly food: number | null;
  readonly oxygen: number | null;
  readonly inWater: boolean | null;
  readonly inLava: boolean | null;
  readonly onFire: boolean | null;
  readonly suffocating: boolean | null;
  readonly sleeping: boolean | null;
}

export interface CompanionOutcomeBodyEvidence {
  readonly source: CompanionOutcomeEvidenceSource;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly sameLife: boolean | null;
  readonly recoveryRequired: boolean | null;
  readonly reasonCode: CompanionOutcomeReasonCode | null;
  readonly before: CompanionBodyObservationEvidence;
  readonly after: CompanionBodyObservationEvidence;
}

export const companionOutcomeStatuses = [
  "successful",
  "failed",
  "interrupted",
  "cancelled",
  "unverified",
] as const;
export type CompanionOutcomeStatus = (typeof companionOutcomeStatuses)[number];

export interface CompanionOutcome {
  readonly operationId: string;
  readonly operation: PlayerOperation;
  readonly status: CompanionOutcomeStatus;
  readonly summary: string;
  readonly expectedOutcome?: string | undefined;
  readonly observedAt: string;
  /** Missing on older records; readback converts it to explicit unknown. */
  readonly purpose?: string | null | undefined;
  /** Missing on older records; readback converts it to explicit unknown. */
  readonly bodyEvidence?: CompanionOutcomeBodyEvidence | undefined;
  /** Missing on older records; readback converts it to explicit unknown. */
  readonly preActionObservation?: CompanionBodyObservationEvidence | undefined;
}

export type CompanionOutcomeInput = Omit<CompanionOutcome, "observedAt"> & {
  readonly observedAt?: string | undefined;
};

export const companionReplyLifecycleStates = [
  "received",
  "generation_started",
  "generated",
  "generation_failed",
  "interrupted",
  "send_started",
  "send_call_resolved",
  "send_unknown",
  "durable_stop",
] as const;
export type CompanionReplyLifecycleState =
  (typeof companionReplyLifecycleStates)[number];

export const companionReplyLifecycleReasonCodes = [
  "judgment_failed",
  "damage_response",
  "newer_owner_input",
  "owner_stop",
  "process_restart_with_generation_unresolved",
  "process_restart_during_send",
  "say_call_rejected",
  "owner_message_unavailable",
] as const;
export type CompanionReplyLifecycleReasonCode =
  (typeof companionReplyLifecycleReasonCodes)[number];

export interface CompanionReplyLifecycleEvent {
  readonly state: CompanionReplyLifecycleState;
  readonly at: string;
  readonly reasonCode?: CompanionReplyLifecycleReasonCode | undefined;
}

/** Bounded reply evidence points back to the owner journal row; it stores no chat copy. */
export interface CompanionReplyLifecycle {
  readonly ownerMessageSequence: number;
  readonly events: readonly CompanionReplyLifecycleEvent[];
}

export interface CompanionSnapshot {
  readonly stopped: boolean;
  readonly stopGeneration: number;
  readonly goal: CompanionGoal | null;
  readonly plan: CompanionPlan | null;
  readonly waitUntil: string | null;
  readonly activeOperation: CompanionActiveOperation | null;
  readonly lastOutcome: CompanionOutcome | null;
  readonly replyLifecycle: readonly CompanionReplyLifecycle[];
  readonly outcomeRetention?: CompanionOutcomeRetention | undefined;
  readonly relationshipSummary: string;
  readonly interests: readonly string[];
}

export interface CompanionOutcomeRetention {
  /** Earlier history predates the current guaranteed-retention policy. */
  readonly coverageFrom: string;
  readonly evictedCount: number;
  readonly evictedThrough: string | null;
}

export interface CompanionOutcomeHistoryRequest {
  readonly from: string;
  readonly to: string;
  readonly limit: number;
}

export interface CompanionOutcomeHistoryEntry extends CompanionOutcome {
  readonly purpose: string | null;
  readonly bodyEvidence: CompanionOutcomeBodyEvidence;
  readonly preActionObservation: CompanionBodyObservationEvidence;
  readonly recordedAt: string;
}

export interface CompanionOutcomeHistory {
  readonly from: string;
  readonly to: string;
  readonly limit: number;
  readonly records: readonly CompanionOutcomeHistoryEntry[];
  readonly matchedCount: number;
  readonly retained: {
    readonly coverageFrom: string;
    readonly oldestAt: string | null;
    readonly newestAt: string | null;
    readonly count: number;
    readonly evictedCount: number;
    readonly evictedThrough: string | null;
  };
  readonly unavailableBefore: boolean;
  readonly truncatedByLimit: boolean;
  readonly complete: boolean;
}

export interface CompanionStatePatch {
  readonly goal?: CompanionGoal | null | undefined;
  readonly plan?: CompanionPlan | null | undefined;
  readonly waitUntil?: string | null | undefined;
  readonly activeOperation?: CompanionActiveOperation | null | undefined;
  readonly relationshipSummary?: string | undefined;
  readonly interests?: readonly string[] | undefined;
}

/** Model-proposed memories carry no provenance authority. The store verifies ownerQuote. */
export interface MemoryUpdate {
  readonly kind: "fact" | "preference" | "interest" | "episode";
  readonly content: string;
  readonly importance: number;
  readonly ownerQuote: string | null;
}

export interface CompanionMemory {
  readonly id: string;
  readonly kind: CompanionMemoryKind;
  readonly content: string;
  readonly source: CompanionMemorySource;
  readonly status: CompanionMemoryStatus;
  readonly importance: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: JsonValue;
}

export interface CompanionRememberOptions {
  /** Authenticated owner message used only to verify literal ownerQuote evidence. */
  readonly ownerMessage?: string | undefined;
}

export type CompanionMessageRole = "owner" | "companion";
export interface CompanionMessage {
  readonly sequence: number;
  readonly role: CompanionMessageRole;
  readonly text: string;
  readonly recordedAt: string;
}

export interface CompanionStoreOptions {
  readonly ownerUsername?: string | undefined;
  readonly now?: (() => string) | undefined;
  /** Entry cap applied independently to message and outcome journal rows. */
  readonly maxJournalEntries?: number | undefined;
}
