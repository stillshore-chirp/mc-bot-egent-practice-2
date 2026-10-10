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
}

export type CompanionOutcomeInput = Omit<CompanionOutcome, "observedAt"> & {
  readonly observedAt?: string | undefined;
};

export interface CompanionSnapshot {
  readonly stopped: boolean;
  readonly stopGeneration: number;
  readonly goal: CompanionGoal | null;
  readonly plan: CompanionPlan | null;
  readonly waitUntil: string | null;
  readonly activeOperation: CompanionActiveOperation | null;
  readonly lastOutcome: CompanionOutcome | null;
  readonly relationshipSummary: string;
  readonly interests: readonly string[];
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
  readonly maxJournalEntries?: number | undefined;
}
