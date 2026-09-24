import type {
  PlayerBodyEvent,
  PlayerBodyObservation,
  PlayerKnowledge,
  PlayerOperation,
  PlayerOperationResult,
} from "../minecraft/player-body.js";
import type {
  McSkillOutcomeStatus,
  McSkillRecord,
} from "../mc-skills/index.js";

export type PlayerWakeKind =
  | "startup"
  | "owner_proposal"
  | "body_outcome"
  | "state_changed"
  | "operation_stalled"
  | "bot_death"
  | "reconnected"
  | "deadline"
  | "manual";

export interface PlayerGoal {
  readonly id: string;
  readonly title: string;
  readonly status: "active" | "paused" | "completed" | "abandoned";
  readonly priority: number;
  readonly changeReason: string;
  readonly source: "owner" | "persona" | "self";
  readonly updatedAt: string;
}

export interface OwnerProposal {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly priorityPreference: number;
  readonly status: "pending" | "adopted" | "compromised" | "declined";
  readonly resolution?: string;
}

export interface PlayerWaitState {
  readonly reason: string;
  readonly wakeOn: readonly PlayerWakeKind[];
  readonly wakeAt?: string;
}

export interface ActivePlayerOperation {
  readonly operationId: string;
  readonly kind: PlayerOperation["kind"];
  readonly actionRevision: number;
  readonly startedAt: string;
  readonly skillId?: string;
  readonly skillVersion?: number;
}

export interface PlayerOutcomeEvidence {
  readonly operationId: string;
  readonly kind: PlayerOperation["kind"];
  readonly status: McSkillOutcomeStatus;
  readonly summary: string;
  readonly observedAt: string;
  readonly skillId?: string;
  readonly skillVersion?: number;
}

export interface PlayerProposalResolution {
  readonly proposalId: string;
  readonly disposition: "adopted" | "compromised" | "declined";
  readonly resolution: string;
}

export interface PlayerJudgmentEvidence {
  readonly revision: number;
  readonly decidedAt: string;
  readonly kind: PlayerThoughtDecision["kind"];
  readonly summary: string;
  readonly operationKind?: PlayerOperation["kind"];
  readonly proposalId?: string;
  readonly proposalDisposition?: PlayerProposalResolution["disposition"];
  readonly skillId?: string;
  readonly skillVersion?: number;
}

export interface PlayerLearningEvidence {
  readonly runId: string;
  readonly skillId: string;
  readonly version: number;
  readonly changeKind: "create" | "revise" | "merge" | "weaken";
  readonly observedOutcome: McSkillOutcomeStatus;
  readonly summary: string;
  readonly updatedAt: string;
}

export interface PlayerTrustedOutcomeEvidence {
  readonly runId: string;
  readonly operationId: string;
  readonly kind: PlayerOperation["kind"];
  readonly status: McSkillOutcomeStatus;
  readonly summary: string;
  readonly observedAt: string;
  readonly skillId?: string;
  readonly skillVersion?: number;
}

export interface PlayerSkillActivityEvidence {
  readonly kind: "consulted" | "created" | "revised" | "imported" | "exported";
  readonly skillId: string;
  readonly version: number;
  readonly summary: string;
  readonly at: string;
  /** Local-only exchange path; never included in model context or public logs. */
  readonly filePath?: string;
}

export interface PlayerStateNote {
  readonly id: string;
  readonly kind: "fact" | "uncertainty";
  readonly summary: string;
  readonly source: "owner" | "observed" | "inferred";
  readonly updatedAt: string;
}

/** Small, visibility-bounded receipt used to correlate a judgment with what was seen. */
export interface PlayerObservationEvidence {
  readonly observedAt: string;
  readonly dimension: string;
  readonly day: number | null;
  readonly timeOfDay: number | null;
  readonly isDay: boolean | null;
  readonly health: number | null;
  readonly food: number | null;
  readonly oxygen: number | null;
  readonly inWater: boolean | null;
  readonly inLava: boolean | null;
  readonly onFire: boolean | null;
  readonly inventoryTotal: number;
  readonly inventoryNames: readonly string[];
  readonly visibleBlockNames: readonly string[];
  readonly visibleContainers: readonly {
    readonly name: string;
    readonly position: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly dimension: string;
    };
    readonly distance: number;
  }[];
  readonly visibleEntityKinds: readonly string[];
  readonly candidateSearchMayBeTruncated: boolean;
  readonly ownerPositionExceptionUsed: boolean;
}

export interface PlayerGoalChange {
  readonly id?: string;
  readonly title: string;
  readonly status: PlayerGoal["status"];
  readonly priority: number;
  readonly changeReason: string;
  readonly source: PlayerGoal["source"];
}

export type PlayerThoughtDecision =
  | {
      readonly kind: "act";
      readonly purpose: string;
      readonly operation: PlayerOperation;
      readonly operationId: string;
      readonly expectedOutcome: string;
      readonly skillId?: string;
      readonly skillVersion?: number;
      readonly wakeOn: readonly PlayerWakeKind[];
    }
  | {
      readonly kind: "wait";
      readonly purpose: string;
      readonly reason: string;
      readonly wakeOn: readonly PlayerWakeKind[];
      readonly wakeAt?: string;
    }
  | { readonly kind: "continue"; readonly reason: string }
  | {
      readonly kind: "complete";
      readonly purpose: string;
      readonly reason: string;
      readonly wakeOn: readonly PlayerWakeKind[];
    };

export interface PlayerRuntimeEvent {
  readonly id: string;
  readonly kind: PlayerWakeKind;
  readonly summary: string;
  readonly createdAt: string;
}

export interface PlayerRuntimeSnapshot {
  readonly revision: number;
  readonly actionRevision: number;
  readonly stopped: boolean;
  readonly stopGeneration: number;
  readonly purpose: string;
  readonly goals: readonly PlayerGoal[];
  readonly stateFacts: readonly PlayerStateNote[];
  readonly uncertainties: readonly PlayerStateNote[];
  readonly proposals: readonly OwnerProposal[];
  readonly activeOperation?: ActivePlayerOperation;
  readonly wait?: PlayerWaitState;
  readonly lastOutcome?: PlayerOutcomeEvidence;
  readonly pendingEventKinds: readonly PlayerWakeKind[];
  readonly recentJudgments: readonly PlayerJudgmentEvidence[];
  readonly recentOutcomes: readonly PlayerTrustedOutcomeEvidence[];
  readonly learningReferences: readonly PlayerLearningEvidence[];
  readonly skillActivity: readonly PlayerSkillActivityEvidence[];
  readonly lastObservation?: PlayerObservationEvidence;
  readonly counters: {
    readonly llmCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly latencyMs: number;
    readonly thoughts: number;
    readonly learningUpdates: number;
  };
}

export interface PlayerBodyPort {
  observe(options?: {
    ownerPositionException?: boolean;
  }): Promise<PlayerBodyObservation>;
  execute(
    operation: PlayerOperation,
    signal?: AbortSignal,
  ): Promise<PlayerOperationResult>;
  stop(): Promise<void>;
  knowledge(query: string): PlayerKnowledge;
  onEvent(listener: (event: PlayerBodyEvent) => void): () => void;
}

export interface PlayerMemoryContext {
  readonly persona: string;
  readonly ownerUsername: string;
  readonly relationship: unknown;
  readonly lifeState: unknown;
  readonly recalled: readonly unknown[];
}

export interface PlayerMemoryPort {
  context(): PlayerMemoryContext;
  recall(query: string): readonly unknown[];
  persistGoals(goals: readonly PlayerGoal[]): void;
  recordEpisode(input: {
    readonly summary: string;
    readonly status: string;
    readonly operationKind?: string;
  }): void;
}

export interface PlayerSkillReference {
  readonly skillId: string;
  readonly version: number;
  readonly skill: McSkillRecord;
}
