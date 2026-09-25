import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { z } from "zod";

import type { McSkillOutcomeStatus } from "../mc-skills/index.js";
import { playerOperationNames } from "../minecraft/player-body-schema.js";
import {
  playerActionDecisionValidationCodes,
  playerAgentRequestErrorCauses,
  playerAgentToolNames,
  playerSkillLearningRejectionCodes,
  type PlayerAgentRoundActivity,
} from "./responses.js";
import type {
  OwnerProposal,
  PlayerGoal,
  PlayerGoalChange,
  PlayerProposalResolution,
  PlayerObservationEvidence,
  PlayerObservedDisplacement,
  PlayerRuntimeEvent,
  PlayerRuntimeSnapshot,
  PlayerStateNote,
  PlayerThoughtDecision,
  PlayerWakeKind,
} from "./contracts.js";
import {
  playerThoughtCommitRejectionCodes,
  playerThoughtStaleChangeComponents,
  type PlayerThoughtCommitRejectionCode,
} from "./contracts.js";

const wakeKinds = [
  "startup",
  "owner_proposal",
  "body_outcome",
  "state_changed",
  "operation_stalled",
  "bot_death",
  "reconnected",
  "deadline",
  "manual",
] as const satisfies readonly PlayerWakeKind[];

const purposeCompletionWakeSummary = "目的完了後の自律目的を再評価";

const goalSchema = z
  .object({
    id: z.string().min(1).max(80),
    ownerProposalId: z.string().min(1).max(80).optional(),
    title: z.string().min(1).max(240),
    status: z.enum(["active", "paused", "completed", "abandoned"]),
    priority: z.number().int().min(1).max(5),
    changeReason: z.string().min(1).max(400),
    source: z.enum(["owner", "persona", "self"]),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const proposalSchema = z
  .object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(240),
    reason: z.string().min(1).max(400),
    createdAt: z.iso.datetime(),
    priorityPreference: z.number().int().min(1).max(5),
    status: z.enum(["pending", "adopted", "compromised", "declined"]),
    resolution: z.string().max(400).optional(),
  })
  .strict();

const judgmentSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    decidedAt: z.iso.datetime(),
    kind: z.enum(["act", "wait", "continue", "complete"]),
    summary: z.string().min(1).max(500),
    operationKind: z.enum(playerOperationNames).optional(),
    proposalId: z.string().min(1).max(80).optional(),
    proposalDisposition: z
      .enum(["adopted", "compromised", "declined"])
      .optional(),
    skillId: z.string().min(1).max(80).optional(),
    skillVersion: z.number().int().positive().optional(),
  })
  .strict();

const learningSchema = z
  .object({
    runId: z.string().min(1).max(80),
    skillId: z.string().min(1).max(80),
    version: z.number().int().positive(),
    changeKind: z.enum(["create", "revise", "merge", "weaken"]),
    observedOutcome: z.enum([
      "successful",
      "failed",
      "interrupted",
      "cancelled",
      "unverified",
    ]),
    summary: z.string().min(1).max(500),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const movementDeltaSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  })
  .strict();

const outcomeHistorySchema = z
  .object({
    runId: z.string().min(1).max(80),
    operationId: z.string().min(1).max(80),
    kind: z.enum(playerOperationNames),
    status: z.enum([
      "successful",
      "failed",
      "interrupted",
      "cancelled",
      "unverified",
    ]),
    summary: z.string().min(1).max(700),
    observedAt: z.iso.datetime(),
    movementDelta: movementDeltaSchema.optional(),
    expectedOutcome: z.string().min(1).max(400).optional(),
    skillId: z.string().min(1).max(80).optional(),
    skillVersion: z.number().int().positive().optional(),
  })
  .strict();

const skillActivitySchema = z
  .object({
    kind: z.enum(["consulted", "created", "revised", "imported", "exported"]),
    skillId: z.string().min(1).max(80),
    version: z.number().int().positive(),
    summary: z.string().min(1).max(300),
    at: z.iso.datetime(),
    filePath: z.string().min(1).max(1_024).optional(),
  })
  .strict();

const agentActivitySchema = z
  .object({
    runSequence: z.number().int().positive(),
    role: z.enum(["purpose", "conversation"]),
    round: z.number().int().positive(),
    responseStatus: z.enum([
      "completed",
      "incomplete",
      "failed",
      "unknown",
      "request_error",
    ]),
    processingStatus: z.enum(["complete", "interrupted"]),
    requestErrorCause: z.enum(playerAgentRequestErrorCauses).optional(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    requestInputChars: z.number().int().nonnegative(),
    initialInputChars: z.number().int().nonnegative(),
    instructionsChars: z.number().int().nonnegative(),
    toolSchemaChars: z.number().int().nonnegative(),
    initialObservationChars: z.number().int().nonnegative(),
    responseOutputChars: z.number().int().nonnegative(),
    functionCallCount: z.number().int().nonnegative(),
    compactionItemPresent: z.boolean(),
    toolCalls: z
      .array(
        z
          .object({
            name: z.union([z.enum(playerAgentToolNames), z.literal("unknown")]),
            resultClass: z.enum(["ok", "rejected", "error", "unknown"]),
            resultCode: z
              .union([
                z.enum(playerThoughtCommitRejectionCodes),
                z.enum(playerSkillLearningRejectionCodes),
                z.enum(playerActionDecisionValidationCodes),
              ])
              .optional(),
            staleChangedComponents: z
              .array(z.enum(playerThoughtStaleChangeComponents))
              .max(playerThoughtStaleChangeComponents.length)
              .optional(),
            outputChars: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

const stateNoteSchema = z
  .object({
    id: z.string().min(1).max(80),
    kind: z.enum(["fact", "uncertainty"]),
    summary: z.string().min(1).max(400),
    source: z.enum(["owner", "observed", "inferred"]),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const positionSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    dimension: z.string().min(1).max(80),
  })
  .strict();

const observationSchema = z
  .object({
    observedAt: z.iso.datetime(),
    dimension: z.string().min(1).max(80),
    day: z.number().int().nonnegative().nullable(),
    timeOfDay: z.number().int().min(0).max(24_000).nullable(),
    isDay: z.boolean().nullable(),
    health: z.number().nullable(),
    food: z.number().nullable(),
    oxygen: z.number().nullable(),
    inWater: z.boolean().nullable(),
    inLava: z.boolean().nullable(),
    onFire: z.boolean().nullable(),
    inventoryTotal: z.number().int().nonnegative(),
    inventoryNames: z.array(z.string().min(1).max(80)).max(48),
    visibleBlockNames: z.array(z.string().min(1).max(80)).max(48),
    visibleContainers: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            position: positionSchema,
            distance: z.number().nonnegative(),
          })
          .strict(),
      )
      .max(24),
    visibleEntityKinds: z.array(z.string().min(1).max(80)).max(32),
    candidateSearchMayBeTruncated: z.boolean(),
    ownerPositionExceptionUsed: z.boolean(),
  })
  .strict();

const stateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    actionRevision: z.number().int().nonnegative(),
    purposeProgressRevision: z.number().int().nonnegative().default(0),
    lastCompletionProgressRevision: z.number().int().nonnegative().optional(),
    purposeCompletionWakeSequence: z.number().int().nonnegative().default(0),
    stopped: z.boolean(),
    stopGeneration: z.number().int().nonnegative(),
    purpose: z.string().max(400),
    goals: z.array(goalSchema).max(60),
    stateFacts: z.array(stateNoteSchema).max(40),
    uncertainties: z.array(stateNoteSchema).max(40),
    lastObservation: observationSchema.optional(),
    proposals: z.array(proposalSchema).max(60),
    recentJudgments: z.array(judgmentSchema).max(24),
    recentOutcomes: z.array(outcomeHistorySchema).max(24),
    learningReferences: z.array(learningSchema).max(24),
    skillActivity: z.array(skillActivitySchema).max(32),
    recentAgentActivity: z.array(agentActivitySchema).max(64).default([]),
    activeOperation: z
      .object({
        operationId: z.string().min(1).max(80),
        kind: z.enum(playerOperationNames),
        actionRevision: z.number().int().nonnegative(),
        startedAt: z.iso.datetime(),
        bodyStartedAt: z.iso.datetime().optional(),
        expectedOutcome: z.string().min(1).max(400).optional(),
        skillId: z.string().min(1).max(80).optional(),
        skillVersion: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    wait: z
      .object({
        reason: z.string().min(1).max(400),
        wakeOn: z.array(z.enum(wakeKinds)).min(1).max(wakeKinds.length),
        wakeAt: z.iso.datetime().optional(),
      })
      .strict()
      .optional(),
    lastOutcome: z
      .object({
        operationId: z.string().min(1).max(80),
        kind: z.enum(playerOperationNames),
        status: z.enum([
          "successful",
          "failed",
          "interrupted",
          "cancelled",
          "unverified",
        ]),
        summary: z.string().min(1).max(700),
        observedAt: z.iso.datetime(),
        movementDelta: movementDeltaSchema.optional(),
        expectedOutcome: z.string().min(1).max(400).optional(),
        skillId: z.string().min(1).max(80).optional(),
        skillVersion: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    counters: z
      .object({
        llmCalls: z.number().int().nonnegative(),
        usageUnknownCalls: z.number().int().nonnegative().default(0),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        latencyMs: z.number().int().nonnegative(),
        thoughts: z.number().int().nonnegative(),
        learningUpdates: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

type StoredState = z.infer<typeof stateSchema>;

type CommitThoughtResult =
  | { readonly accepted: true; readonly snapshot: PlayerRuntimeSnapshot }
  | {
      readonly accepted: false;
      readonly snapshot: PlayerRuntimeSnapshot;
      readonly rejectionCode: PlayerThoughtCommitRejectionCode;
    };

interface PlayerUnderstandingUpdate {
  readonly facts: readonly {
    readonly summary: string;
    readonly source: "owner" | "observed" | "inferred";
  }[];
  readonly uncertainties: readonly {
    readonly summary: string;
    readonly source: "owner" | "observed" | "inferred";
  }[];
}

function appendPlayerUnderstanding(
  current: Pick<StoredState, "stateFacts" | "uncertainties">,
  update: PlayerUnderstandingUpdate,
  now: string,
): {
  readonly stateFacts: PlayerStateNote[];
  readonly uncertainties: PlayerStateNote[];
  readonly changed: boolean;
} {
  const makeNotes = (
    kind: "fact" | "uncertainty",
    values: PlayerUnderstandingUpdate["facts"],
  ): PlayerStateNote[] =>
    values.slice(0, 8).map((note) => ({
      id: randomUUID(),
      kind,
      summary: bounded(note.summary, 400, "state note"),
      source: note.source,
      updatedAt: now,
    }));
  const factNotes = makeNotes("fact", update.facts);
  const uncertaintyNotes = makeNotes("uncertainty", update.uncertainties);
  return {
    stateFacts: [...current.stateFacts, ...factNotes].slice(-40),
    uncertainties: [...current.uncertainties, ...uncertaintyNotes].slice(-40),
    changed: factNotes.length > 0 || uncertaintyNotes.length > 0,
  };
}

const initialState: StoredState = {
  revision: 0,
  actionRevision: 0,
  purposeProgressRevision: 0,
  purposeCompletionWakeSequence: 0,
  stopped: false,
  stopGeneration: 0,
  purpose: "",
  goals: [],
  stateFacts: [],
  uncertainties: [],
  proposals: [],
  recentJudgments: [],
  recentOutcomes: [],
  learningReferences: [],
  skillActivity: [],
  recentAgentActivity: [],
  counters: {
    llmCalls: 0,
    usageUnknownCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    thoughts: 0,
    learningUpdates: 0,
  },
};

interface EventRow {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly created_at: string;
}

export class PlayerMindStore {
  private constructor(private readonly database: Database.Database) {}

  public static open(databasePath: string): PlayerMindStore {
    const database = new Database(databasePath, { timeout: 5_000 });
    try {
      database.pragma("journal_mode = WAL");
      database.pragma("foreign_keys = ON");
      database.exec(`
        CREATE TABLE IF NOT EXISTS player_runtime_state (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS player_runtime_events (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS player_runtime_events_pending_idx
          ON player_runtime_events(consumed_at, created_at);
      `);
      database
        .prepare(
          "INSERT OR IGNORE INTO player_runtime_state(singleton_id, payload_json, updated_at) VALUES(1, ?, ?)",
        )
        .run(JSON.stringify(initialState), new Date().toISOString());
      const store = new PlayerMindStore(database);
      store.readStored();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  public close(): void {
    if (this.database.open) this.database.close();
  }

  public snapshot(): PlayerRuntimeSnapshot {
    const state = this.readStored();
    const pendingKinds = this.database
      .prepare<[], { readonly kind: string }>(
        "SELECT DISTINCT kind FROM player_runtime_events WHERE consumed_at IS NULL ORDER BY kind",
      )
      .all()
      .map(({ kind }) => parseWakeKind(kind));
    const {
      purposeProgressRevision: _purposeProgressRevision,
      lastCompletionProgressRevision: _lastCompletionProgressRevision,
      purposeCompletionWakeSequence: _purposeCompletionWakeSequence,
      ...publicState
    } = state;
    return {
      ...publicState,
      pendingEventKinds: pendingKinds,
    };
  }

  public purposeCompletionWakeState(): {
    readonly sequence: number;
    readonly pendingEvent: PlayerRuntimeEvent | undefined;
  } {
    const state = this.readStored();
    const row = this.database
      .prepare<[string], EventRow>(
        "SELECT id, kind, summary, created_at FROM player_runtime_events WHERE kind = 'manual' AND summary = ? AND consumed_at IS NULL ORDER BY created_at, rowid LIMIT 1",
      )
      .get(purposeCompletionWakeSummary);
    return {
      sequence: state.purposeCompletionWakeSequence,
      pendingEvent:
        row === undefined
          ? undefined
          : {
              id: row.id,
              kind: parseWakeKind(row.kind),
              summary: row.summary,
              createdAt: row.created_at,
            },
    };
  }

  public pendingEvents(limit = 32): PlayerRuntimeEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new TypeError("event limit must be from 1 to 64");
    }
    return this.database
      .prepare<[number], EventRow>(
        "SELECT id, kind, summary, created_at FROM player_runtime_events WHERE consumed_at IS NULL ORDER BY created_at, rowid LIMIT ?",
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        kind: parseWakeKind(row.kind),
        summary: row.summary,
        createdAt: row.created_at,
      }));
  }

  public consumeEvents(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const mark = this.database.prepare(
      "UPDATE player_runtime_events SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
    );
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      for (const id of ids.slice(0, 64)) mark.run(now, id);
      this.database
        .prepare(
          "DELETE FROM player_runtime_events WHERE consumed_at IS NOT NULL AND consumed_at < ?",
        )
        .run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString());
    });
    transaction.immediate();
  }

  public enqueueEvent(
    kind: PlayerWakeKind,
    summary: string,
    options: { readonly invalidateDecision?: boolean } = {},
  ): PlayerRuntimeEvent {
    const safeSummary = bounded(summary, 400, "event summary");
    const now = new Date().toISOString();
    const id = randomUUID();
    const transaction = this.database.transaction(() => {
      // Only ordinary observations may be queued behind an in-flight thought.
      if (
        kind !== "state_changed" ||
        safeSummary.includes("vitals") ||
        options.invalidateDecision !== false
      ) {
        const current = this.readStored();
        this.writeStored({ ...current, revision: current.revision + 1 }, now);
      }
      if (kind === "state_changed" && safeSummary.includes("vitals")) {
        // Keep the latest urgent-damage signal while coalescing packet bursts.
        this.database
          .prepare(
            "DELETE FROM player_runtime_events WHERE kind = 'state_changed' AND summary LIKE '%vitals%' AND consumed_at IS NULL",
          )
          .run();
      }
      this.database
        .prepare(
          "INSERT INTO player_runtime_events(id, kind, summary, created_at, consumed_at) VALUES(?, ?, ?, ?, NULL)",
        )
        .run(id, kind, safeSummary, now);
      // The queue is bounded even if a host floods repeated observations.
      this.database
        .prepare(
          `
        DELETE FROM player_runtime_events
        WHERE id IN (
          SELECT id FROM player_runtime_events
          WHERE consumed_at IS NULL AND kind NOT IN ('bot_death','owner_proposal','operation_stalled')
            AND NOT (kind = 'manual' AND summary = '目的完了後の自律目的を再評価')
            AND NOT (kind = 'state_changed' AND summary LIKE '%vitals%')
          ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 48
        )
      `,
        )
        .run();
    });
    transaction.immediate();
    return { id, kind, summary: safeSummary, createdAt: now };
  }

  public addProposal(input: {
    title: string;
    reason: string;
    priority?: number;
  }): OwnerProposal {
    const now = new Date().toISOString();
    const proposal: OwnerProposal = {
      id: randomUUID(),
      title: bounded(input.title, 240, "proposal title"),
      reason: bounded(input.reason, 400, "proposal reason"),
      createdAt: now,
      priorityPreference: Math.max(
        1,
        Math.min(5, Math.round(input.priority ?? 3)),
      ),
      status: "pending",
    };
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      const proposals = [...current.proposals];
      if (proposals.length >= 60) {
        const protectedProposalIds = new Set(
          current.goals
            .filter(
              (goal) =>
                goal.ownerProposalId !== undefined &&
                (goal.status === "active" || goal.status === "paused"),
            )
            .map((goal) => goal.ownerProposalId),
        );
        const evictionIndex = proposals.findIndex(
          (entry) => !protectedProposalIds.has(entry.id),
        );
        if (evictionIndex < 0) throw new Error("PLAYER_PROPOSAL_CAPACITY");
        proposals.splice(evictionIndex, 1);
      }
      proposals.push(proposal);
      this.writeStored(
        { ...current, revision: current.revision + 1, proposals },
        now,
      );
      this.database
        .prepare(
          "INSERT INTO player_runtime_events(id, kind, summary, created_at, consumed_at) VALUES(?, 'owner_proposal', ?, ?, NULL)",
        )
        .run(randomUUID(), `提案を受信: ${proposal.title}`, now);
    });
    transaction.immediate();
    return proposal;
  }

  public stop(
    expectedStopGeneration?: number,
  ): PlayerRuntimeSnapshot | undefined {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      if (
        expectedStopGeneration !== undefined &&
        current.stopGeneration !== expectedStopGeneration
      )
        return undefined;
      const next: StoredState = {
        ...current,
        revision: current.revision + 1,
        actionRevision: current.actionRevision + 1,
        stopped: true,
        stopGeneration: current.stopGeneration + 1,
        activeOperation: undefined,
        wait: undefined,
      };
      this.writeStored(next, now);
      this.database
        .prepare(
          "INSERT INTO player_runtime_events(id, kind, summary, created_at, consumed_at) VALUES(?, 'manual', '停止ラッチが有効', ?, NULL)",
        )
        .run(randomUUID(), now);
      return this.snapshot();
    });
    return transaction.immediate();
  }

  public resume(
    expectedStopGeneration: number,
  ): PlayerRuntimeSnapshot | undefined {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      if (!current.stopped || current.stopGeneration !== expectedStopGeneration)
        return undefined;
      this.writeStored(
        {
          ...current,
          revision: current.revision + 1,
          actionRevision: current.actionRevision + 1,
          stopped: false,
          stopGeneration: current.stopGeneration + 1,
          activeOperation: undefined,
          wait: undefined,
        },
        now,
      );
      this.database
        .prepare(
          "INSERT INTO player_runtime_events(id, kind, summary, created_at, consumed_at) VALUES(?, 'manual', '所有者が自律行動を再開', ?, NULL)",
        )
        .run(randomUUID(), now);
      return this.snapshot();
    });
    return transaction.immediate();
  }

  public commitThought(input: {
    expectedRevision: number;
    decision: PlayerThoughtDecision;
    goal?: PlayerGoalChange;
    proposalResolution?: PlayerProposalResolution;
    understanding?: PlayerUnderstandingUpdate;
  }): CommitThoughtResult {
    const now = new Date().toISOString();
    const transaction = this.database.transaction((): CommitThoughtResult => {
      const current = this.readStored();
      if (current.stopped) {
        return {
          accepted: false,
          snapshot: this.snapshot(),
          rejectionCode: "STOPPED",
        };
      }
      if (current.revision !== input.expectedRevision) {
        return {
          accepted: false,
          snapshot: this.snapshot(),
          rejectionCode: "CAS_STALE",
        };
      }
      if (
        input.decision.kind === "continue" &&
        current.activeOperation === undefined
      ) {
        return {
          accepted: false,
          snapshot: this.snapshot(),
          rejectionCode: "NO_ACTIVE_OPERATION",
        };
      }
      let proposals = current.proposals;
      let proposalBeingResolved: OwnerProposal | undefined;
      if (input.proposalResolution !== undefined) {
        const { proposalId, disposition, resolution } =
          input.proposalResolution;
        const proposalIndex = proposals.findIndex(
          (entry) => entry.id === proposalId && entry.status === "pending",
        );
        if (proposalIndex < 0)
          return {
            accepted: false,
            snapshot: this.snapshot(),
            rejectionCode: "PROPOSAL_NOT_PENDING",
          };
        proposalBeingResolved = proposals[proposalIndex];
        proposals = proposals.map((entry, index) =>
          index === proposalIndex
            ? {
                ...entry,
                status: disposition,
                resolution: bounded(resolution, 400, "resolution"),
              }
            : entry,
        );
      }
      const goalUpdate = applyGoalAndProposalResolution(
        current.goals,
        input.goal,
        proposalBeingResolved,
        input.proposalResolution,
        now,
      );
      if (!goalUpdate.accepted)
        return {
          accepted: false,
          snapshot: this.snapshot(),
          rejectionCode: "GOAL_CAPACITY" as const,
        };
      const goals = goalUpdate.goals;
      const goalProgress =
        input.goal !== undefined &&
        goalChangeIsMeaningful(current.goals, input.goal);
      const proposalProgress = input.proposalResolution !== undefined;
      const understanding = appendPlayerUnderstanding(
        current,
        input.understanding ?? { facts: [], uncertainties: [] },
        now,
      );
      let purpose = current.purpose;
      let activeOperation = current.activeOperation;
      let wait = current.wait;
      let actionChanged = false;
      switch (input.decision.kind) {
        case "act":
          purpose = bounded(input.decision.purpose, 400, "purpose");
          activeOperation = {
            operationId: bounded(
              input.decision.operationId,
              80,
              "operation id",
            ),
            kind: input.decision.operation.kind,
            actionRevision: current.actionRevision + 1,
            startedAt: now,
            expectedOutcome: bounded(
              input.decision.expectedOutcome,
              400,
              "expected outcome",
            ),
            ...(input.decision.skillId === undefined
              ? {}
              : { skillId: bounded(input.decision.skillId, 80, "skill id") }),
            ...(input.decision.skillVersion === undefined
              ? {}
              : { skillVersion: input.decision.skillVersion }),
          };
          wait = undefined;
          actionChanged = true;
          break;
        case "wait":
          purpose = bounded(input.decision.purpose, 400, "purpose");
          activeOperation = undefined;
          wait = {
            reason: bounded(input.decision.reason, 400, "wait reason"),
            wakeOn: uniqueWakeKinds(
              input.decision.wakeAt === undefined
                ? input.decision.wakeOn
                : [...input.decision.wakeOn, "deadline"],
            ),
            ...(input.decision.wakeAt === undefined
              ? {}
              : { wakeAt: boundedFutureDate(input.decision.wakeAt) }),
          };
          actionChanged = true;
          break;
        case "continue":
          if (input.decision.reason.trim().length === 0)
            throw new TypeError("continue reason is required");
          break;
        case "complete":
          purpose = bounded(input.decision.purpose, 400, "purpose");
          activeOperation = undefined;
          wait = {
            reason: bounded(input.decision.reason, 400, "completion reason"),
            wakeOn: uniqueWakeKinds(input.decision.wakeOn),
          };
          actionChanged = true;
          break;
      }
      const purposeProgressRevision =
        current.purposeProgressRevision +
        (input.decision.kind === "act" || goalProgress || proposalProgress
          ? 1
          : 0);
      const shouldWakeAfterCompletion =
        input.decision.kind === "complete" &&
        (current.lastCompletionProgressRevision === undefined ||
          purposeProgressRevision > current.lastCompletionProgressRevision);
      const purposeCompletionWakeSequence =
        current.purposeCompletionWakeSequence +
        (shouldWakeAfterCompletion ? 1 : 0);
      const resolutionChanged = input.proposalResolution !== undefined;
      const stateChanged =
        resolutionChanged || input.goal !== undefined || understanding.changed;
      const nextRevision =
        current.revision + (stateChanged || actionChanged ? 1 : 0);
      const judgment = {
        revision: nextRevision,
        decidedAt: now,
        kind: input.decision.kind,
        summary: summarizeDecision(input.decision),
        ...(input.decision.kind === "act"
          ? {
              operationKind: input.decision.operation.kind,
              ...(input.decision.skillId === undefined
                ? {}
                : { skillId: input.decision.skillId }),
              ...(input.decision.skillVersion === undefined
                ? {}
                : { skillVersion: input.decision.skillVersion }),
            }
          : {}),
        ...(input.proposalResolution === undefined
          ? {}
          : {
              proposalId: input.proposalResolution.proposalId,
              proposalDisposition: input.proposalResolution.disposition,
            }),
      };
      const next: StoredState = {
        ...current,
        revision: nextRevision,
        actionRevision: current.actionRevision + (actionChanged ? 1 : 0),
        purposeProgressRevision,
        ...(input.decision.kind === "complete" && shouldWakeAfterCompletion
          ? { lastCompletionProgressRevision: purposeProgressRevision }
          : {}),
        purposeCompletionWakeSequence,
        purpose,
        goals,
        proposals,
        stateFacts: understanding.stateFacts,
        uncertainties: understanding.uncertainties,
        ...(activeOperation === undefined
          ? { activeOperation: undefined }
          : { activeOperation }),
        ...(wait === undefined ? { wait: undefined } : { wait }),
        counters: {
          ...current.counters,
          thoughts: current.counters.thoughts + 1,
        },
        recentJudgments: [...current.recentJudgments, judgment].slice(-24),
      };
      this.writeStored(next, now);
      if (shouldWakeAfterCompletion) {
        this.database
          .prepare(
            "INSERT INTO player_runtime_events(id, kind, summary, created_at, consumed_at) VALUES(?, 'manual', ?, ?, NULL)",
          )
          .run(randomUUID(), purposeCompletionWakeSummary, now);
      }
      return { accepted: true, snapshot: this.snapshot() };
    });
    return transaction.immediate();
  }

  public commitGoalState(input: {
    readonly expectedRevision: number;
    readonly goal?: PlayerGoalChange;
    readonly proposalResolution?: PlayerProposalResolution;
  }): {
    readonly accepted: boolean;
    readonly snapshot: PlayerRuntimeSnapshot;
    readonly rejectionCode?: PlayerThoughtCommitRejectionCode | undefined;
  } {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      if (current.revision !== input.expectedRevision || current.stopped) {
        return { accepted: false, snapshot: this.snapshot() };
      }
      let proposals = current.proposals;
      let proposalBeingResolved: OwnerProposal | undefined;
      if (input.proposalResolution !== undefined) {
        const { proposalId, disposition, resolution } =
          input.proposalResolution;
        const proposalIndex = proposals.findIndex(
          (entry) => entry.id === proposalId && entry.status === "pending",
        );
        if (proposalIndex < 0)
          return { accepted: false, snapshot: this.snapshot() };
        proposalBeingResolved = proposals[proposalIndex];
        proposals = proposals.map((entry, index) =>
          index === proposalIndex
            ? {
                ...entry,
                status: disposition,
                resolution: bounded(resolution, 400, "resolution"),
              }
            : entry,
        );
      }
      const goalProgress =
        input.goal !== undefined &&
        goalChangeIsMeaningful(current.goals, input.goal);
      const proposalProgress = input.proposalResolution !== undefined;
      if (input.goal === undefined && input.proposalResolution === undefined) {
        return { accepted: false, snapshot: this.snapshot() };
      }
      const goalUpdate = applyGoalAndProposalResolution(
        current.goals,
        input.goal,
        proposalBeingResolved,
        input.proposalResolution,
        now,
      );
      if (!goalUpdate.accepted)
        return {
          accepted: false,
          snapshot: this.snapshot(),
          rejectionCode: "GOAL_CAPACITY" as const,
        };
      this.writeStored(
        {
          ...current,
          revision: current.revision + 1,
          purposeProgressRevision:
            current.purposeProgressRevision +
            (goalProgress || proposalProgress ? 1 : 0),
          goals: goalUpdate.goals,
          proposals,
        },
        now,
      );
      return { accepted: true, snapshot: this.snapshot() };
    });
    return transaction.immediate();
  }

  public commitUnderstanding(input: {
    readonly expectedRevision: number;
    readonly facts: PlayerUnderstandingUpdate["facts"];
    readonly uncertainties: PlayerUnderstandingUpdate["uncertainties"];
  }): { readonly accepted: boolean; readonly snapshot: PlayerRuntimeSnapshot } {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      if (current.revision !== input.expectedRevision || current.stopped) {
        return { accepted: false, snapshot: this.snapshot() };
      }
      const understanding = appendPlayerUnderstanding(current, input, now);
      if (!understanding.changed) {
        return { accepted: false, snapshot: this.snapshot() };
      }
      this.writeStored(
        {
          ...current,
          revision: current.revision + 1,
          stateFacts: understanding.stateFacts,
          uncertainties: understanding.uncertainties,
        },
        now,
      );
      return { accepted: true, snapshot: this.snapshot() };
    });
    return transaction.immediate();
  }

  public recordOutcome(input: {
    readonly recoveryRequired?: boolean;
    readonly evidence: {
      readonly operationId: string;
      readonly kind: (typeof playerOperationNames)[number];
      readonly status: McSkillOutcomeStatus;
      readonly summary: string;
      readonly observedAt: string;
      readonly movementDelta?: PlayerObservedDisplacement;
      readonly expectedOutcome?: string;
      readonly skillId?: string;
      readonly skillVersion?: number;
    };
  }): PlayerRuntimeSnapshot {
    const now = isoDate(input.evidence.observedAt);
    const evidence = {
      operationId: bounded(input.evidence.operationId, 80, "operation id"),
      kind: z.enum(playerOperationNames).parse(input.evidence.kind),
      status: input.evidence.status,
      summary: bounded(input.evidence.summary, 700, "outcome summary"),
      observedAt: now,
      ...(input.evidence.movementDelta === undefined
        ? {}
        : {
            movementDelta: movementDeltaSchema.parse(
              input.evidence.movementDelta,
            ),
          }),
      ...(input.evidence.expectedOutcome === undefined
        ? {}
        : {
            expectedOutcome: bounded(
              input.evidence.expectedOutcome,
              400,
              "expected outcome",
            ),
          }),
      ...(input.evidence.skillId === undefined
        ? {}
        : { skillId: bounded(input.evidence.skillId, 80, "skill id") }),
      ...(input.evidence.skillVersion === undefined
        ? {}
        : { skillVersion: input.evidence.skillVersion }),
    };
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      const stillActive =
        current.activeOperation?.operationId === evidence.operationId;
      const waitForReconnect = stillActive && input.recoveryRequired === true;
      const outcomeRunId = evidence.operationId;
      const outcomeHistory = {
        runId: outcomeRunId,
        operationId: evidence.operationId,
        kind: evidence.kind,
        status: evidence.status,
        summary: evidence.summary,
        observedAt: now,
        ...(evidence.movementDelta === undefined
          ? {}
          : { movementDelta: evidence.movementDelta }),
        ...(evidence.expectedOutcome === undefined
          ? {}
          : { expectedOutcome: evidence.expectedOutcome }),
        ...(evidence.skillId === undefined
          ? {}
          : { skillId: evidence.skillId }),
        ...(evidence.skillVersion === undefined
          ? {}
          : { skillVersion: evidence.skillVersion }),
      };
      const outcomeAlreadyCounted =
        current.lastOutcome?.operationId === evidence.operationId ||
        current.recentOutcomes.some(
          (outcome) => outcome.operationId === evidence.operationId,
        );
      this.writeStored(
        {
          ...current,
          revision: current.revision + 1,
          actionRevision: current.actionRevision + (waitForReconnect ? 1 : 0),
          purposeProgressRevision:
            current.purposeProgressRevision + (outcomeAlreadyCounted ? 0 : 1),
          ...(stillActive ? { activeOperation: undefined } : {}),
          ...(waitForReconnect
            ? {
                wait: {
                  reason:
                    "Minecraft body operation requires a new connection before actions can resume",
                  wakeOn: ["reconnected" as const],
                },
              }
            : {}),
          lastOutcome: evidence,
          recentOutcomes: [...current.recentOutcomes, outcomeHistory].slice(
            -24,
          ),
        },
        now,
      );
      if (stillActive && !waitForReconnect) {
        this.database
          .prepare(
            "INSERT INTO player_runtime_events(id, kind, summary, created_at, consumed_at) VALUES(?, 'body_outcome', ?, ?, NULL)",
          )
          .run(
            randomUUID(),
            `操作 ${evidence.kind} は ${evidence.status}: ${evidence.summary}`,
            now,
          );
      }
      return this.snapshot();
    });
    return transaction.immediate();
  }

  public deferOperationUntilReconnect(
    operationId: string,
  ): PlayerRuntimeSnapshot {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      if (
        current.activeOperation?.operationId !== operationId ||
        current.stopped
      )
        return this.snapshot();
      this.writeStored(
        {
          ...current,
          revision: current.revision + 1,
          actionRevision: current.actionRevision + 1,
          activeOperation: undefined,
          wait: {
            reason:
              "Minecraft body operation requires a new connection before actions can resume",
            wakeOn: ["reconnected"],
          },
        },
        now,
      );
      return this.snapshot();
    });
    return transaction.immediate();
  }

  public markOperationStarted(
    operationId: string,
    startedAt = new Date().toISOString(),
  ): void {
    const at = isoDate(startedAt);
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      if (current.activeOperation?.operationId !== operationId) return;
      this.writeStored(
        {
          ...current,
          activeOperation: {
            ...current.activeOperation,
            startedAt: at,
            bodyStartedAt: at,
          },
        },
        at,
      );
    });
    transaction.immediate();
  }

  public recoverInterruptedOperation(trustedResult?: {
    readonly status: McSkillOutcomeStatus;
    readonly summary: string;
    readonly observedAt: string;
  }):
    | {
        readonly operationId: string;
        readonly kind: (typeof playerOperationNames)[number];
        readonly status: McSkillOutcomeStatus;
        readonly summary: string;
        readonly observedAt: string;
        readonly expectedOutcome?: string;
        readonly skillId?: string;
        readonly skillVersion?: number;
      }
    | undefined {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      const active = current.activeOperation;
      if (active === undefined) return undefined;
      const status = trustedResult?.status ?? "unverified";
      const summary =
        trustedResult?.summary ??
        "プロセス再起動後に実行継続を確認できず、結果は未検証";
      const observedAt = trustedResult?.observedAt ?? now;
      this.writeStored(
        {
          ...current,
          revision: current.revision + 1,
          purposeProgressRevision: current.purposeProgressRevision + 1,
          activeOperation: undefined,
          lastOutcome: {
            operationId: active.operationId,
            kind: active.kind,
            status,
            summary,
            observedAt,
            ...(active.expectedOutcome === undefined
              ? {}
              : { expectedOutcome: active.expectedOutcome }),
            ...(active.skillId === undefined
              ? {}
              : { skillId: active.skillId }),
            ...(active.skillVersion === undefined
              ? {}
              : { skillVersion: active.skillVersion }),
          },
          recentOutcomes: [
            ...current.recentOutcomes,
            {
              runId: active.operationId,
              operationId: active.operationId,
              kind: active.kind,
              status,
              summary,
              observedAt,
              ...(active.expectedOutcome === undefined
                ? {}
                : { expectedOutcome: active.expectedOutcome }),
              ...(active.skillId === undefined
                ? {}
                : { skillId: active.skillId }),
              ...(active.skillVersion === undefined
                ? {}
                : { skillVersion: active.skillVersion }),
            },
          ].slice(-24),
        },
        now,
      );
      this.database
        .prepare(
          "INSERT INTO player_runtime_events(id, kind, summary, created_at, consumed_at) VALUES(?, 'body_outcome', ?, ?, NULL)",
        )
        .run(
          randomUUID(),
          `再起動後に復旧した操作結果: ${active.kind} ${status}`,
          now,
        );
      return {
        operationId: active.operationId,
        kind: active.kind,
        status,
        summary,
        observedAt,
        ...(active.expectedOutcome === undefined
          ? {}
          : { expectedOutcome: active.expectedOutcome }),
        ...(active.skillId === undefined ? {} : { skillId: active.skillId }),
        ...(active.skillVersion === undefined
          ? {}
          : { skillVersion: active.skillVersion }),
      };
    });
    return transaction.immediate();
  }

  public recordLearning(input: {
    readonly runId: string;
    readonly skillId: string;
    readonly version: number;
    readonly changeKind: "create" | "revise" | "merge" | "weaken";
    readonly observedOutcome: McSkillOutcomeStatus;
    readonly summary: string;
  }): void {
    const updatedAt = new Date().toISOString();
    const reference = {
      runId: bounded(input.runId, 80, "run id"),
      skillId: bounded(input.skillId, 80, "skill id"),
      version: input.version,
      changeKind: input.changeKind,
      observedOutcome: input.observedOutcome,
      summary: bounded(input.summary, 500, "learning summary"),
      updatedAt,
    };
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      const existingForRun = current.learningReferences.find(
        (item) => item.runId === reference.runId,
      );
      if (existingForRun !== undefined) {
        if (
          existingForRun.skillId !== reference.skillId ||
          existingForRun.version !== reference.version
        ) {
          throw new Error("LEARNING_RUN_CONFLICT");
        }
        return;
      }
      this.writeStored(
        {
          ...current,
          learningReferences: [...current.learningReferences, reference].slice(
            -24,
          ),
          counters: {
            ...current.counters,
            learningUpdates: current.counters.learningUpdates + 1,
          },
        },
        updatedAt,
      );
    });
    transaction.immediate();
  }

  public recordSkillActivity(input: {
    readonly kind:
      "consulted" | "created" | "revised" | "imported" | "exported";
    readonly skillId: string;
    readonly version: number;
    readonly summary: string;
    readonly filePath?: string;
  }): void {
    const at = new Date().toISOString();
    const activity = {
      kind: input.kind,
      skillId: bounded(input.skillId, 80, "skill id"),
      version: input.version,
      summary: bounded(input.summary, 300, "skill activity summary"),
      at,
      ...(input.filePath === undefined
        ? {}
        : { filePath: bounded(input.filePath, 1_024, "exchange path") }),
    };
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      this.writeStored(
        {
          ...current,
          skillActivity: [...current.skillActivity, activity].slice(-32),
        },
        at,
      );
    });
    transaction.immediate();
  }

  public recordObservation(
    observation: PlayerObservationEvidence,
  ): PlayerRuntimeSnapshot {
    const validated = observationSchema.parse(observation);
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      this.writeStored(
        { ...current, lastObservation: validated },
        validated.observedAt,
      );
      return this.snapshot();
    });
    return transaction.immediate();
  }

  public recordCall(metrics: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly latencyMs: number;
    readonly learningUpdate?: boolean;
    readonly usageUnknown?: boolean;
  }): void {
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      this.writeStored(
        {
          ...current,
          counters: {
            ...current.counters,
            llmCalls: current.counters.llmCalls + 1,
            usageUnknownCalls:
              current.counters.usageUnknownCalls +
              (metrics.usageUnknown === true ? 1 : 0),
            inputTokens:
              current.counters.inputTokens + nonnegative(metrics.inputTokens),
            outputTokens:
              current.counters.outputTokens + nonnegative(metrics.outputTokens),
            latencyMs:
              current.counters.latencyMs + nonnegative(metrics.latencyMs),
            learningUpdates:
              current.counters.learningUpdates +
              (metrics.learningUpdate === true ? 1 : 0),
          },
        },
        new Date().toISOString(),
      );
    });
    transaction.immediate();
  }

  public recordAgentActivity(
    activity: PlayerAgentRoundActivity,
  ): PlayerRuntimeSnapshot {
    const validated = agentActivitySchema.parse(activity);
    const transaction = this.database.transaction(() => {
      const current = this.readStored();
      this.writeStored(
        {
          ...current,
          recentAgentActivity: [
            ...current.recentAgentActivity,
            validated,
          ].slice(-64),
        },
        new Date().toISOString(),
      );
      return this.snapshot();
    });
    return transaction.immediate();
  }

  private readStored(): StoredState {
    const row = this.database
      .prepare<[], { readonly payload_json: string }>(
        "SELECT payload_json FROM player_runtime_state WHERE singleton_id = 1",
      )
      .get();
    if (row === undefined) throw new Error("player runtime state is missing");
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new Error("player runtime state is corrupt");
    }
    const parsed = stateSchema.safeParse(payload);
    if (!parsed.success) throw new Error("player runtime state is invalid");
    return parsed.data;
  }

  private writeStored(
    state: StoredState,
    updatedAt = new Date().toISOString(),
  ): void {
    const validated = stateSchema.parse(state);
    this.database
      .prepare(
        "UPDATE player_runtime_state SET payload_json = ?, updated_at = ? WHERE singleton_id = 1",
      )
      .run(JSON.stringify(validated), updatedAt);
  }
}

function applyGoalAndProposalResolution(
  currentGoals: readonly PlayerGoal[],
  goalChange: PlayerGoalChange | undefined,
  proposal: OwnerProposal | undefined,
  resolution: PlayerProposalResolution | undefined,
  now: string,
): { readonly accepted: boolean; readonly goals: PlayerGoal[] } {
  let goals = [...currentGoals];
  const goalById =
    goalChange?.id === undefined
      ? undefined
      : currentGoals.find((goal) => goal.id === goalChange.id);
  const mismatchedProposalLink =
    proposal !== undefined &&
    resolution?.disposition !== "declined" &&
    goalById?.ownerProposalId !== undefined &&
    goalById.ownerProposalId !== proposal.id;
  const goalChangeForLink = mismatchedProposalLink ? undefined : goalChange;
  const shouldLinkExplicitGoal =
    proposal !== undefined &&
    resolution !== undefined &&
    resolution.disposition !== "declined" &&
    goalChangeForLink?.source === "owner";
  if (goalChange !== undefined) {
    const merged = mergeGoal(
      goals,
      goalChange,
      now,
      shouldLinkExplicitGoal ? proposal.id : undefined,
    );
    if (merged === undefined)
      return { accepted: false, goals: [...currentGoals] };
    goals = merged;
  }
  if (
    proposal === undefined ||
    resolution === undefined ||
    resolution.disposition === "declined"
  )
    return { accepted: true, goals };

  const proposalTitle = bounded(proposal.title, 240, "goal title");
  const linkedGoal = goals.find((goal) => goal.ownerProposalId === proposal.id);
  const explicitOwnerGoal = shouldLinkExplicitGoal;
  const explicitlySelectedGoal =
    goalChangeForLink?.id === undefined
      ? undefined
      : goals.find(
          (goal) =>
            goal.id === goalChangeForLink.id &&
            goal.source === "owner" &&
            (goal.ownerProposalId === undefined ||
              goal.ownerProposalId === proposal.id),
        );
  const titleMatchedOwnerGoal = goals.find(
    (goal) =>
      goal.source === "owner" &&
      (goal.ownerProposalId === undefined ||
        goal.ownerProposalId === proposal.id) &&
      normalizeGoalTitle(goal.title) === normalizeGoalTitle(proposalTitle),
  );
  const reusableGoal =
    linkedGoal ??
    (explicitOwnerGoal
      ? (explicitlySelectedGoal ?? titleMatchedOwnerGoal)
      : undefined) ??
    titleMatchedOwnerGoal;
  const change: PlayerGoalChange =
    explicitOwnerGoal && reusableGoal !== undefined
      ? { ...goalChangeForLink, id: reusableGoal.id, source: "owner" }
      : {
          ...(reusableGoal === undefined ? {} : { id: reusableGoal.id }),
          title: proposalTitle,
          status: "active",
          priority: proposal.priorityPreference,
          changeReason: proposal.reason,
          source: "owner",
        };
  const merged = mergeGoal(goals, change, now, proposal.id);
  if (merged === undefined)
    return { accepted: false, goals: [...currentGoals] };
  return { accepted: true, goals: merged };
}

function mergeGoal(
  goals: readonly PlayerGoal[],
  change: PlayerGoalChange,
  now: string,
  ownerProposalId?: string,
): PlayerGoal[] | undefined {
  const title = bounded(change.title, 240, "goal title");
  const reason = bounded(change.changeReason, 400, "goal change reason");
  const priority = Math.max(1, Math.min(5, Math.round(change.priority)));
  const existing =
    ownerProposalId === undefined
      ? findGoalForChange(goals, change, title)
      : ((change.id === undefined
          ? undefined
          : goals.find(
              (goal) =>
                goal.id === change.id &&
                (goal.ownerProposalId === undefined ||
                  goal.ownerProposalId === ownerProposalId),
            )) ??
        goals.find((goal) => goal.ownerProposalId === ownerProposalId) ??
        goals.find(
          (goal) =>
            goal.source === "owner" &&
            goal.ownerProposalId === undefined &&
            normalizeGoalTitle(goal.title) === normalizeGoalTitle(title),
        ));
  if (existing !== undefined) {
    return goals.map((goal) =>
      goal.id === existing.id
        ? {
            ...goal,
            title,
            status: change.status,
            priority,
            changeReason: reason,
            source:
              ownerProposalId !== undefined ||
              goal.ownerProposalId !== undefined
                ? "owner"
                : change.source,
            ...(ownerProposalId === undefined &&
            goal.ownerProposalId === undefined
              ? {}
              : {
                  ownerProposalId: ownerProposalId ?? goal.ownerProposalId,
                }),
            updatedAt: now,
          }
        : goal,
    );
  }
  const goal: PlayerGoal = {
    id:
      change.id === undefined
        ? randomUUID()
        : bounded(change.id, 80, "goal id"),
    ...(ownerProposalId === undefined ? {} : { ownerProposalId }),
    title,
    status: change.status,
    priority,
    changeReason: reason,
    source: change.source,
    updatedAt: now,
  };
  const expanded = [...goals, goal];
  if (expanded.length <= 60) return expanded;
  const removableIndex = expanded.findIndex(
    (candidate, index) =>
      index < expanded.length - 1 &&
      (candidate.ownerProposalId === undefined ||
        candidate.status === "completed" ||
        candidate.status === "abandoned"),
  );
  if (removableIndex < 0) return undefined;
  expanded.splice(removableIndex, 1);
  return expanded;
}

function goalChangeIsMeaningful(
  goals: readonly PlayerGoal[],
  change: PlayerGoalChange,
): boolean {
  const title = bounded(change.title, 240, "goal title");
  const existing = findGoalForChange(goals, change, title);
  if (existing === undefined) return true;
  return (
    normalizeGoalTitle(existing.title) !== normalizeGoalTitle(title) ||
    existing.status !== change.status ||
    existing.priority !==
      Math.max(1, Math.min(5, Math.round(change.priority))) ||
    existing.source !== change.source
  );
}

function findGoalForChange(
  goals: readonly PlayerGoal[],
  change: PlayerGoalChange,
  title: string,
): PlayerGoal | undefined {
  if (change.id !== undefined)
    return goals.find((goal) => goal.id === change.id);
  const normalizedTitle = normalizeGoalTitle(title);
  return goals.find(
    (goal) =>
      goal.source === change.source &&
      normalizeGoalTitle(goal.title) === normalizedTitle,
  );
}

function normalizeGoalTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function parseWakeKind(value: string): PlayerWakeKind {
  if ((wakeKinds as readonly string[]).includes(value))
    return value as PlayerWakeKind;
  throw new Error("unknown player runtime event kind");
}

function uniqueWakeKinds(values: readonly PlayerWakeKind[]): PlayerWakeKind[] {
  const result = [
    ...new Set(
      values.filter((value) =>
        (wakeKinds as readonly string[]).includes(value),
      ),
    ),
  ];
  if (result.length === 0)
    throw new TypeError("at least one wake event is required");
  return result.slice(0, wakeKinds.length);
}

function bounded(value: string, max: number, label: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > max)
    throw new TypeError(`${label} must contain 1-${max} characters`);
  return normalized;
}

function isoDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("timestamp is invalid");
  return date.toISOString();
}

function boundedFutureDate(value: string): string {
  const result = isoDate(value);
  const deadline = Date.parse(result);
  if (
    deadline <= Date.now() ||
    deadline > Date.now() + 7 * 24 * 60 * 60 * 1_000
  ) {
    throw new TypeError("wait deadline must be in the next seven days");
  }
  return result;
}

function nonnegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function summarizeDecision(decision: PlayerThoughtDecision): string {
  switch (decision.kind) {
    case "act": {
      const summary = `目的に沿って ${decision.operation.kind} を開始`;
      if (decision.reason === undefined || decision.reason.trim().length === 0)
        return summary;
      return `${summary}: ${bounded(decision.reason, 400, "act reason")}`;
    }
    case "wait":
      return `待機: ${bounded(decision.reason, 300, "wait reason")}`;
    case "continue":
      return `実行中の操作を継続: ${bounded(decision.reason, 300, "continue reason")}`;
    case "complete":
      return `目的を完了: ${bounded(decision.reason, 300, "completion reason")}`;
  }
}
