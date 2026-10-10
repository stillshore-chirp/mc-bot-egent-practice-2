import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { z } from "zod";

import {
  companionMemoryKinds,
  companionMemorySources,
  companionMemoryStatuses,
  companionOutcomeStatuses,
  companionPlanStepLimit,
  type CompanionActiveOperation,
  type CompanionGoal,
  type CompanionMemory,
  type CompanionMemoryKind,
  type CompanionMemorySource,
  type CompanionMemoryStatus,
  type CompanionMessage,
  type CompanionOutcome,
  type CompanionOutcomeInput,
  type CompanionOutcomeStatus,
  type CompanionPlan,
  type CompanionSnapshot,
  type CompanionStatePatch,
  type CompanionStoreOptions,
  type JsonObject,
  type JsonValue,
  type MemoryUpdate,
} from "./contracts.js";
import { playerOperationSchema } from "../minecraft/player-body-schema.js";

const STORE_SCHEMA_VERSION = 1;
const DEFAULT_JOURNAL_LIMIT = 256;
const MAX_JOURNAL_LIMIT = 2_000;
const MAX_RECALL_LIMIT = 20;
const MAX_RECALL_TERMS = 32;
const MAX_RECALL_CANDIDATES = 256;
const MAX_RECALL_FALLBACKS = 128;
const MAX_OWNER_QUOTE_LENGTH = 400;
const MAX_TEXT_LENGTH = 2_000;
const MAX_MEMORY_UPDATE_LENGTH = 1_000;
const SECRET_LABEL =
  /(?:^|[\s_:=,."'`])(api[_ -]?key|authorization|bearer|password|private[_ -]?key|secret)(?:$|[\s_:=,."'`])/iu;
const SECRET_VALUE =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u;
const LEGACY_REDACTION_TEXT =
  "Legacy content quarantined for credential safety.";
const LEGACY_REDACTION_VALUE = "[redacted legacy value]";

type StoreErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "STOPPED"
  | "STOP_GENERATION_MISMATCH"
  | "OWNER_REQUIRED"
  | "OWNER_NOT_FOUND"
  | "LEGACY_STATE_INVALID"
  | "DATABASE_ERROR";

export class CompanionStoreError extends Error {
  public constructor(
    public readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompanionStoreError";
  }
}

export const companionStoreSchemaVersion = STORE_SCHEMA_VERSION;

interface StateRow {
  readonly payload_json: string;
}

interface MemoryRow {
  readonly memory_id: string;
  readonly kind: string;
  readonly content: string;
  readonly source: string;
  readonly status: string;
  readonly importance: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly metadata_json: string;
  readonly legacy_source_key: string | null;
}

type MemoryRecallRow = Pick<
  MemoryRow,
  | "memory_id"
  | "kind"
  | "content"
  | "source"
  | "status"
  | "importance"
  | "created_at"
  | "updated_at"
> & { readonly match_score: number };

interface JournalRow {
  readonly journal_id: number;
  readonly kind: "message" | "outcome";
  readonly role: string | null;
  readonly operation_id: string | null;
  readonly content: string;
  readonly payload_json: string;
  readonly recorded_at: string;
}

interface LegacyPlayerRow {
  readonly id: string;
  readonly external_name: string;
}

type LegacyRow = Record<string, unknown>;

const goalSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    successCondition: z.string().trim().min(1).max(400),
    source: z.enum(["owner", "persona", "self"]),
  })
  .strict();

const planStepSchema = z
  .object({
    operation: playerOperationSchema,
    expectedOutcome: z.string().trim().min(1).max(400),
  })
  .strict();

const planSchema = z
  .object({
    purpose: z.string().trim().min(1).max(400),
    steps: z.array(planStepSchema).min(1).max(companionPlanStepLimit),
  })
  .strict();

const activeOperationSchema = z
  .object({
    operationId: z.string().trim().min(1).max(120),
    operation: playerOperationSchema,
    expectedOutcome: z.string().trim().min(1).max(400),
  })
  .strict();

const outcomeSchema = z
  .object({
    operationId: z.string().trim().min(1).max(120),
    operation: playerOperationSchema,
    status: z.enum(companionOutcomeStatuses),
    summary: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
    expectedOutcome: z.string().trim().min(1).max(400).optional(),
    observedAt: z.iso.datetime(),
  })
  .strict();

const snapshotSchema = z
  .object({
    stopped: z.boolean(),
    stopGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    goal: goalSchema.nullable(),
    plan: planSchema.nullable(),
    waitUntil: z.iso.datetime().nullable(),
    activeOperation: activeOperationSchema.nullable(),
    lastOutcome: outcomeSchema.nullable(),
    relationshipSummary: z.string().max(MAX_TEXT_LENGTH),
    interests: z.array(z.string().trim().min(1).max(240)).max(40),
  })
  .strict();

const patchSchema = z
  .object({
    goal: goalSchema.nullable().optional(),
    plan: planSchema.nullable().optional(),
    waitUntil: z.iso.datetime().nullable().optional(),
    activeOperation: activeOperationSchema.nullable().optional(),
    relationshipSummary: z.string().max(MAX_TEXT_LENGTH).optional(),
    interests: z.array(z.string().trim().min(1).max(240)).max(40).optional(),
  })
  .strict();

const memoryUpdateSchema = z
  .object({
    kind: z.enum(["fact", "preference", "interest", "episode"]),
    content: z.string().trim().min(1).max(MAX_MEMORY_UPDATE_LENGTH),
    importance: z.number().int().min(1).max(5),
    ownerQuote: z.string().max(MAX_OWNER_QUOTE_LENGTH).nullable(),
  })
  .strict();

const stateJsonSchema = `
  CREATE TABLE IF NOT EXISTS companion_runtime_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS companion_memories (
    memory_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    legacy_source_key TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS companion_memories_status_updated_idx
    ON companion_memories(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS companion_memories_kind_status_idx
    ON companion_memories(kind, status, importance DESC);
  CREATE INDEX IF NOT EXISTS companion_memories_fingerprint_idx
    ON companion_memories(kind, content_fingerprint, status);
  CREATE TABLE IF NOT EXISTS companion_journal (
    journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'outcome')),
    role TEXT,
    operation_id TEXT,
    event_key TEXT UNIQUE,
    content TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS companion_journal_recent_idx
    ON companion_journal(journal_id DESC);
  CREATE TABLE IF NOT EXISTS companion_store_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

const emptySnapshot: CompanionSnapshot = {
  stopped: false,
  stopGeneration: 0,
  goal: null,
  plan: null,
  waitUntil: null,
  activeOperation: null,
  lastOutcome: null,
  relationshipSummary: "",
  interests: [],
};

export class CompanionStore {
  readonly #database: Database.Database;
  readonly #now: () => string;
  readonly #journalLimit: number;
  readonly #ownerUsername: string | undefined;

  private constructor(
    database: Database.Database,
    options: CompanionStoreOptions,
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#journalLimit = options.maxJournalEntries ?? DEFAULT_JOURNAL_LIMIT;
    this.#ownerUsername = options.ownerUsername?.trim();
    if (
      !Number.isInteger(this.#journalLimit) ||
      this.#journalLimit < 1 ||
      this.#journalLimit > MAX_JOURNAL_LIMIT
    ) {
      throw invalidInput("maxJournalEntries must be between 1 and 2000.");
    }
    if (this.#ownerUsername !== undefined && this.#ownerUsername.length === 0) {
      throw invalidInput("ownerUsername must contain text.");
    }
  }

  public static open(
    databasePath: string,
    options: CompanionStoreOptions = {},
  ): CompanionStore {
    const database = new Database(databasePath, { timeout: 5_000 });
    try {
      database.pragma("foreign_keys = ON");
      database.exec(stateJsonSchema);
      const store = new CompanionStore(database, options);
      store.migrateAndImportLegacyState();
      store.recoverInterruptedOperation();
      store.readSnapshot();
      return store;
    } catch (error) {
      if (database.open) database.close();
      if (error instanceof CompanionStoreError) throw error;
      throw new CompanionStoreError(
        "DATABASE_ERROR",
        "The companion store could not be opened safely.",
      );
    }
  }

  public close(): void {
    if (this.#database.open) this.#database.close();
  }

  public snapshot(): CompanionSnapshot {
    return this.readSnapshot();
  }

  /** Atomically saves a new decision and its active operation marker. */
  public save(patch: CompanionStatePatch): CompanionSnapshot {
    const parsedPatch = patchSchema.safeParse(patch);
    if (!parsedPatch.success)
      throw invalidInput("Invalid companion state patch.");
    return this.#database
      .transaction(() => {
        const current = this.readSnapshot();
        if (current.stopped) {
          throw new CompanionStoreError(
            "STOPPED",
            "Owner stop is active; state changes are rejected.",
          );
        }
        const next = snapshotSchema.safeParse({
          ...current,
          ...parsedPatch.data,
        });
        if (!next.success) throw invalidInput("Invalid companion state.");
        validateOperationPlanPair(next.data);
        this.writeSnapshot(next.data, this.#now());
        return next.data;
      })
      .immediate();
  }

  /** A stop latch is synchronous, durable, and clears all runnable work. */
  public stop(): CompanionSnapshot {
    return this.#database
      .transaction(() => {
        const current = this.readSnapshot();
        const nextGeneration = nextStopGeneration(current.stopGeneration);
        let lastOutcome = current.lastOutcome;
        if (current.activeOperation !== null) {
          const interrupted: CompanionOutcome = {
            operationId: current.activeOperation.operationId,
            operation: current.activeOperation.operation,
            status: "interrupted",
            summary:
              "Owner stop requested before the operation result was verified.",
            expectedOutcome: current.activeOperation.expectedOutcome,
            observedAt: this.#now(),
          };
          this.insertJournalOutcome(
            interrupted,
            `owner-stop:${interrupted.operationId}`,
          );
          this.insertMemory({
            kind: "episode",
            content: outcomeMemoryText(interrupted),
            source: "bot_inferred",
            status: "active",
            importance: 3,
            metadata: { outcome: outcomeToJson(interrupted) },
            sourceKey: `owner-stop:${interrupted.operationId}`,
          });
          lastOutcome = interrupted;
        }
        const next: CompanionSnapshot = {
          ...current,
          stopped: true,
          stopGeneration: nextGeneration,
          plan: null,
          waitUntil: null,
          activeOperation: null,
          lastOutcome,
        };
        this.writeSnapshot(next, this.#now());
        this.trimJournal();
        return next;
      })
      .immediate();
  }

  /** Only an explicit owner path should call resume with the observed generation. */
  public resume(expectedStopGeneration: number): CompanionSnapshot {
    if (
      !Number.isSafeInteger(expectedStopGeneration) ||
      expectedStopGeneration < 0
    ) {
      throw invalidInput(
        "expectedStopGeneration must be a nonnegative integer.",
      );
    }
    return this.#database
      .transaction(() => {
        const current = this.readSnapshot();
        if (
          !current.stopped ||
          current.stopGeneration !== expectedStopGeneration
        ) {
          throw new CompanionStoreError(
            "STOP_GENERATION_MISMATCH",
            "Owner stop generation changed; resume was rejected.",
          );
        }
        const next: CompanionSnapshot = {
          ...current,
          stopped: false,
          stopGeneration: nextStopGeneration(current.stopGeneration),
          plan: null,
          waitUntil: null,
          activeOperation: null,
        };
        this.writeSnapshot(next, this.#now());
        return next;
      })
      .immediate();
  }

  /**
   * Upserts short model-proposed memories. Provenance is derived here: a
   * literal quote from the authenticated owner turn is owner-stated; otherwise
   * model text remains inferred. Models cannot label their own claims observed.
   */
  public remember(
    updates: readonly MemoryUpdate[],
    options: { readonly ownerMessage?: string | undefined } = {},
  ): CompanionMemory[] {
    if (!Array.isArray(updates) || updates.length > 20) {
      throw invalidInput("At most 20 memory updates can be saved at once.");
    }
    const parsed = updates.map((update) => {
      const result = memoryUpdateSchema.safeParse(update);
      if (!result.success) throw invalidInput("Invalid memory update.");
      assertNoCredentialLikeContent(result.data.content);
      if (result.data.ownerQuote !== null) {
        assertNoCredentialLikeContent(result.data.ownerQuote);
      }
      return result.data;
    });
    if (
      options.ownerMessage !== undefined &&
      options.ownerMessage.length > MAX_TEXT_LENGTH
    ) {
      throw invalidInput("Owner message is too long for memory verification.");
    }
    return this.#database
      .transaction(() => {
        const memories = parsed.map((update) => {
          const ownerQuoteVerified =
            update.ownerQuote !== null &&
            update.ownerQuote.length > 0 &&
            options.ownerMessage?.includes(update.ownerQuote) === true;
          return this.insertMemory({
            kind: update.kind,
            content: update.content,
            source: ownerQuoteVerified ? "player_stated" : "bot_inferred",
            status: "active",
            importance: update.importance,
            metadata: ownerQuoteVerified
              ? { ownerQuote: update.ownerQuote }
              : {},
          });
        });
        return memories;
      })
      .immediate();
  }

  /** Deterministic lexical recall with salience and recency fallback. */
  public recall(query: string, limit = 8): CompanionMemory[] {
    if (typeof query !== "string" || query.length > MAX_TEXT_LENGTH) {
      throw invalidInput(
        "Recall query must be text no longer than 2000 characters.",
      );
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_LIMIT) {
      throw invalidInput(
        `Recall limit must be between 1 and ${MAX_RECALL_LIMIT}.`,
      );
    }
    const queryTerms = new Set(selectRecallTerms(query));
    const matchedRows = this.readRecallCandidates([...queryTerms]);
    const fallbackRows = this.#database
      .prepare<[], MemoryRecallRow>(
        `
        SELECT memory_id, kind, content, source, status, importance, created_at, updated_at, 0 AS match_score
        FROM companion_memories
        WHERE status = 'active'
        ORDER BY importance DESC, updated_at DESC
        LIMIT ${MAX_RECALL_FALLBACKS}
      `,
      )
      .all();
    const rowById = new Map<string, MemoryRecallRow>();
    for (const row of [...matchedRows, ...fallbackRows]) {
      if (!rowById.has(row.memory_id)) rowById.set(row.memory_id, row);
    }
    const rows = [...rowById.values()];
    const documentFrequency = new Map<string, number>();
    for (const row of rows) {
      const terms = searchTerms(row.content);
      for (const term of terms) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    const now = Date.parse(this.#now());
    const ranked = rows.map((row) => {
      const terms = searchTerms(row.content);
      const termSet = new Set(terms);
      let lexical = 0;
      for (const term of queryTerms) {
        if (!termSet.has(term)) continue;
        const df = documentFrequency.get(term) ?? 0;
        lexical += Math.log(1 + rows.length / (1 + df));
      }
      const phrase =
        query.trim().length > 0 &&
        row.content
          .toLocaleLowerCase("ja-JP")
          .includes(query.trim().toLocaleLowerCase("ja-JP"));
      const ageDays = Math.max(
        0,
        (now - Date.parse(row.updated_at)) / 86_400_000,
      );
      const recency = Number.isFinite(ageDays) ? 1 / (1 + ageDays / 30) : 0;
      const salience = row.importance * 0.35 + recency;
      return {
        row,
        score: (phrase ? 10 : 0) + lexical + salience + row.match_score * 0.01,
        lexical,
      };
    });
    ranked.sort((left, right) => {
      if (queryTerms.size > 0 && left.lexical !== right.lexical) {
        return right.lexical - left.lexical;
      }
      return (
        right.score - left.score ||
        right.row.updated_at.localeCompare(left.row.updated_at)
      );
    });
    const selected = ranked.slice(0, limit).map(({ row }) => row.memory_id);
    if (selected.length === 0) return [];
    const selectedRows = this.#database
      .prepare<string[], MemoryRow>(
        `
        SELECT memory_id, kind, content, source, status, importance, created_at, updated_at, metadata_json, legacy_source_key
        FROM companion_memories
        WHERE memory_id IN (${selected.map(() => "?").join(", ")})
      `,
      )
      .all(...selected);
    const selectedById = new Map(
      selectedRows.map((row) => [row.memory_id, row]),
    );
    return selected.flatMap((id) => {
      const row = selectedById.get(id);
      return row === undefined ? [] : [memoryFromRow(row)];
    });
  }

  private readRecallCandidates(terms: readonly string[]): MemoryRecallRow[] {
    if (terms.length === 0) return [];
    const matchExpression = terms
      .map(() => "CASE WHEN content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END")
      .join(" + ");
    const conditions = terms
      .map(() => "content LIKE ? ESCAPE '\\'")
      .join(" OR ");
    return this.#database
      .prepare<string[], MemoryRecallRow>(
        `
        WITH candidates AS (
          SELECT memory_id, kind, content, source, status, importance, created_at, updated_at,
            (${matchExpression}) AS match_score
          FROM companion_memories
          WHERE status = 'active' AND (${conditions})
        )
        SELECT memory_id, kind, content, source, status, importance, created_at, updated_at, match_score
        FROM candidates
        WHERE match_score > 0
        ORDER BY match_score DESC, importance DESC, updated_at DESC
        LIMIT ${MAX_RECALL_CANDIDATES}
      `,
      )
      .all(
        ...terms.map((term) => `%${escapeLikePattern(term)}%`),
        ...terms.map((term) => `%${escapeLikePattern(term)}%`),
      );
  }

  public recordMessage(role: string, text: string): void {
    if (role !== "owner" && role !== "companion") {
      throw invalidInput("Message role must be owner or companion.");
    }
    const content = boundedText(text, "message", MAX_TEXT_LENGTH);
    assertNoCredentialLikeContent(content);
    this.#database
      .transaction(() => {
        const now = this.#now();
        this.#database
          .prepare(
            "INSERT INTO companion_journal(kind, role, operation_id, event_key, content, payload_json, recorded_at) VALUES('message', ?, NULL, NULL, ?, ?, ?)",
          )
          .run(role, content, JSON.stringify({ role, text: content }), now);
        this.trimJournal();
      })
      .immediate();
  }

  public recentMessages(limit = 24): CompanionMessage[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw invalidInput("Message history limit must be between 1 and 100.");
    }
    const rows = this.#database
      .prepare<[number], JournalRow>(
        "SELECT journal_id, kind, role, operation_id, content, payload_json, recorded_at FROM companion_journal WHERE kind = 'message' ORDER BY journal_id DESC LIMIT ?",
      )
      .all(limit);
    return rows.reverse().map((row) => ({
      sequence: row.journal_id,
      role: row.role === "companion" ? "companion" : "owner",
      text: row.content,
      recordedAt: row.recorded_at,
    }));
  }

  /**
   * Stores a Body result and settles only the matching active plan step. A
   * stale or mismatched result is retained as history but cannot advance or
   * clear a newer active operation.
   */
  public recordOutcome(input: CompanionOutcomeInput): CompanionSnapshot {
    const observedAt = input.observedAt ?? this.#now();
    const outcomeResult = outcomeSchema.safeParse({ ...input, observedAt });
    if (!outcomeResult.success)
      throw invalidInput("Invalid operation outcome.");
    assertNoCredentialLikeContent(outcomeResult.data.summary);
    const outcome = outcomeResult.data;
    return this.#database
      .transaction(() => {
        const current = this.readSnapshot();
        const inserted = this.insertJournalOutcome(
          outcome,
          `body-outcome:${outcome.operationId}`,
        );
        if (!inserted) return current;
        this.insertMemory({
          kind: "episode",
          content: outcomeMemoryText(outcome),
          source:
            outcome.status === "successful" || outcome.status === "failed"
              ? "minecraft_observed"
              : "bot_inferred",
          status: "active",
          importance: outcome.status === "failed" ? 4 : 3,
          metadata: { outcome: outcomeToJson(outcome) },
          sourceKey: `body-outcome:${outcome.operationId}`,
        });

        const active = current.activeOperation;
        const matchesActive =
          active !== null &&
          active.operationId === outcome.operationId &&
          sameOperation(active.operation, outcome.operation) &&
          (outcome.expectedOutcome === undefined ||
            active.expectedOutcome === outcome.expectedOutcome);
        const planHead = current.plan?.steps[0];
        const matchesPlanHead =
          matchesActive &&
          planHead !== undefined &&
          sameOperation(planHead.operation, outcome.operation) &&
          planHead.expectedOutcome === active.expectedOutcome;
        const next: CompanionSnapshot = {
          ...current,
          plan:
            matchesActive &&
            outcome.status === "successful" &&
            matchesPlanHead &&
            current.plan !== null
              ? current.plan.steps.length > 1
                ? {
                    ...current.plan,
                    steps: current.plan.steps.slice(1),
                  }
                : null
              : current.plan === null
                ? null
                : null,
          activeOperation: matchesActive ? null : current.activeOperation,
          lastOutcome:
            matchesActive && !current.stopped ? outcome : current.lastOutcome,
        };
        this.writeSnapshot(next, this.#now());
        this.trimJournal();
        return next;
      })
      .immediate();
  }

  private readSnapshot(): CompanionSnapshot {
    const row = this.#database
      .prepare<[], StateRow>(
        "SELECT payload_json FROM companion_runtime_state WHERE singleton_id = 1",
      )
      .get();
    if (row === undefined) {
      throw new CompanionStoreError(
        "INVALID_STATE",
        "Companion runtime state is missing.",
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new CompanionStoreError(
        "INVALID_STATE",
        "Companion runtime state is corrupt.",
      );
    }
    const parsed = snapshotSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CompanionStoreError(
        "INVALID_STATE",
        "Companion runtime state is invalid.",
      );
    }
    return parsed.data;
  }

  private writeSnapshot(snapshot: CompanionSnapshot, updatedAt: string): void {
    const validated = snapshotSchema.safeParse(snapshot);
    if (!validated.success) throw invalidInput("Invalid companion state.");
    this.#database
      .prepare(
        "UPDATE companion_runtime_state SET payload_json = ?, updated_at = ? WHERE singleton_id = 1",
      )
      .run(JSON.stringify(validated.data), updatedAt);
  }

  private insertMemory(input: {
    readonly kind: CompanionMemoryKind;
    readonly content: string;
    readonly source: CompanionMemorySource;
    readonly status: CompanionMemoryStatus;
    readonly importance: number;
    readonly metadata: JsonValue;
    readonly sourceKey?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly updatedAt?: string | undefined;
  }): CompanionMemory {
    const legacyImport = input.sourceKey?.startsWith("legacy") === true;
    const contentUnsafe =
      legacyImport && hasCredentialLikeContent(input.content);
    const content = contentUnsafe
      ? LEGACY_REDACTION_TEXT
      : boundedText(input.content, "memory content", 32_000);
    const sanitizedMetadata = legacyImport
      ? sanitizeLegacyJsonValue(input.metadata)
      : { value: input.metadata, changed: false };
    const safeMetadata =
      legacyImport && (contentUnsafe || sanitizedMetadata.changed)
        ? withLegacyRedactionFlag(sanitizedMetadata.value)
        : sanitizedMetadata.value;
    const status =
      contentUnsafe && input.status === "active" ? "archived" : input.status;
    const now = this.#now();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const fingerprint = contentFingerprint(input.kind, content);
    if (input.sourceKey !== undefined) {
      const existing = this.#database
        .prepare<[string], MemoryRow>(
          "SELECT memory_id, kind, content, source, status, importance, created_at, updated_at, metadata_json, legacy_source_key FROM companion_memories WHERE legacy_source_key = ?",
        )
        .get(input.sourceKey);
      if (existing !== undefined) return memoryFromRow(existing);
    }
    if (input.sourceKey === undefined) {
      const existing = this.#database
        .prepare<[string, string], MemoryRow>(
          "SELECT memory_id, kind, content, source, status, importance, created_at, updated_at, metadata_json, legacy_source_key FROM companion_memories WHERE kind = ? AND content_fingerprint = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(input.kind, fingerprint);
      if (existing !== undefined) {
        const nextSource = strongerSource(
          memorySource(existing.source),
          input.source,
        );
        const mergedMetadata = mergeJsonMetadata(
          parseJsonValue(existing.metadata_json),
          safeMetadata,
        );
        this.#database
          .prepare(
            "UPDATE companion_memories SET importance = MAX(importance, ?), source = ?, updated_at = ?, metadata_json = ? WHERE memory_id = ?",
          )
          .run(
            input.importance,
            nextSource,
            updatedAt,
            JSON.stringify(mergedMetadata),
            existing.memory_id,
          );
        const refreshed = this.#database
          .prepare<[string], MemoryRow>(
            "SELECT memory_id, kind, content, source, status, importance, created_at, updated_at, metadata_json, legacy_source_key FROM companion_memories WHERE memory_id = ?",
          )
          .get(existing.memory_id);
        if (refreshed === undefined) throw databaseInvariant();
        return memoryFromRow(refreshed);
      }
    }
    const id =
      input.sourceKey === undefined
        ? randomUUID()
        : stableLegacyId(input.sourceKey);
    this.#database
      .prepare(
        "INSERT INTO companion_memories(memory_id, kind, content, source, status, importance, created_at, updated_at, content_fingerprint, metadata_json, legacy_source_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.kind,
        content,
        input.source,
        status,
        input.importance,
        createdAt,
        updatedAt,
        fingerprint,
        JSON.stringify(safeMetadata),
        input.sourceKey ?? null,
      );
    const row = this.#database
      .prepare<[string], MemoryRow>(
        "SELECT memory_id, kind, content, source, status, importance, created_at, updated_at, metadata_json, legacy_source_key FROM companion_memories WHERE memory_id = ?",
      )
      .get(id);
    if (row === undefined) throw databaseInvariant();
    return memoryFromRow(row);
  }

  private insertJournalOutcome(
    outcome: CompanionOutcome,
    eventKey: string,
  ): boolean {
    const legacyImport = eventKey.startsWith("legacy-");
    const safePayload = legacyImport
      ? sanitizeLegacyJsonValue(outcomeToJson(outcome)).value
      : outcomeToJson(outcome);
    const safeOperationId =
      legacyImport && hasCredentialLikeContent(outcome.operationId)
        ? `redacted-${createHash("sha256")
            .update(outcome.operationId)
            .digest("hex")}`
        : outcome.operationId;
    const safeSummary =
      legacyImport && hasCredentialLikeContent(outcome.summary)
        ? LEGACY_REDACTION_TEXT
        : outcome.summary;
    const result = this.#database
      .prepare(
        "INSERT OR IGNORE INTO companion_journal(kind, role, operation_id, event_key, content, payload_json, recorded_at) VALUES('outcome', NULL, ?, ?, ?, ?, ?)",
      )
      .run(
        safeOperationId,
        eventKey,
        safeSummary,
        JSON.stringify(safePayload),
        outcome.observedAt,
      );
    return result.changes > 0;
  }

  private trimJournal(): void {
    this.#database
      .prepare(
        `DELETE FROM companion_journal WHERE journal_id NOT IN (
          SELECT journal_id FROM companion_journal ORDER BY journal_id DESC LIMIT ?
        )`,
      )
      .run(this.#journalLimit);
  }

  private migrateAndImportLegacyState(): void {
    this.#database
      .transaction(() => {
        this.#database
          .prepare(
            "INSERT OR IGNORE INTO companion_runtime_state(singleton_id, payload_json, updated_at) VALUES(1, ?, ?)",
          )
          .run(JSON.stringify(emptySnapshot), this.#now());
        const applied = this.#database
          .prepare<[number], { readonly version: number }>(
            "SELECT version FROM companion_store_migrations WHERE version = ?",
          )
          .get(STORE_SCHEMA_VERSION);
        if (applied !== undefined) return;

        const ownerPlayerId = this.resolveLegacyOwnerId();
        const legacyState = this.readLegacyRuntimeState();
        const initial =
          legacyState === null
            ? this.readLegacyMemorySnapshot(ownerPlayerId)
            : this.migrateLegacyRuntimeState(legacyState, ownerPlayerId);
        this.writeSnapshot(sanitizeLegacySnapshot(initial), this.#now());
        if (legacyState !== null) this.importLegacyRuntimeHistory(legacyState);
        this.importLegacyMemories(ownerPlayerId);
        this.#database
          .prepare(
            "INSERT INTO companion_store_migrations(version, applied_at) VALUES(?, ?)",
          )
          .run(STORE_SCHEMA_VERSION, this.#now());
        this.trimJournal();
      })
      .immediate();
  }

  /**
   * Converts any operation left active by an earlier process into an
   * unverified outcome before runtime starts. The world is never replayed.
   */
  private recoverInterruptedOperation(): void {
    this.#database
      .transaction(() => {
        const current = this.readSnapshot();
        const active = current.activeOperation;
        if (active === null) return;
        const outcome: CompanionOutcome = {
          operationId: active.operationId,
          operation: active.operation,
          status: "unverified",
          summary:
            "The process restarted before the operation result was verified; it was not replayed.",
          observedAt: this.#now(),
        };
        const eventKey = `restart-recovery:${createHash("sha256")
          .update(`${current.stopGeneration}:${active.operationId}`)
          .digest("hex")}`;
        this.insertJournalOutcome(outcome, eventKey);
        this.insertMemory({
          kind: "episode",
          content: outcomeMemoryText(outcome),
          source: "bot_inferred",
          status: "active",
          importance: 4,
          metadata: { outcome: outcomeToJson(outcome) },
          sourceKey: eventKey,
        });
        this.writeSnapshot(
          {
            ...current,
            plan: null,
            waitUntil: null,
            activeOperation: null,
            lastOutcome: outcome,
          },
          this.#now(),
        );
        this.trimJournal();
      })
      .immediate();
  }

  private resolveLegacyOwnerId(): string | null {
    if (!tableExists(this.#database, "players")) return null;
    const players = this.#database
      .prepare<[], LegacyPlayerRow>(
        "SELECT id, external_name FROM players ORDER BY external_name COLLATE NOCASE",
      )
      .all();
    if (players.length === 0) return null;
    if (this.#ownerUsername !== undefined) {
      const owner = players.find(
        ({ external_name }) =>
          external_name.toLocaleLowerCase("en-US") ===
          this.#ownerUsername?.toLocaleLowerCase("en-US"),
      );
      if (owner === undefined) {
        throw new CompanionStoreError(
          "OWNER_NOT_FOUND",
          "Configured owner was not found in legacy memory records.",
        );
      }
      return owner.id;
    }
    if (players.length === 1) return players[0]?.id ?? null;
    throw new CompanionStoreError(
      "OWNER_REQUIRED",
      "Owner username is required to migrate multi-owner memories safely.",
    );
  }

  private readLegacyRuntimeState(): LegacyRow | null {
    if (!tableExists(this.#database, "player_runtime_state")) return null;
    const columns = tableColumns(this.#database, "player_runtime_state");
    if (!columns.has("payload_json")) {
      throw new CompanionStoreError(
        "LEGACY_STATE_INVALID",
        "Legacy runtime state schema is unsupported.",
      );
    }
    const row = this.#database
      .prepare<[], { readonly payload_json: string }>(
        "SELECT payload_json FROM player_runtime_state WHERE singleton_id = 1",
      )
      .get();
    if (row === undefined) return null;
    let value: unknown;
    try {
      value = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new CompanionStoreError(
        "LEGACY_STATE_INVALID",
        "Legacy runtime state is corrupt; stop state was not migrated.",
      );
    }
    if (!isRecord(value) || typeof value.stopped !== "boolean") {
      throw new CompanionStoreError(
        "LEGACY_STATE_INVALID",
        "Legacy runtime state is invalid; stop state was not migrated.",
      );
    }
    return value;
  }

  private migrateLegacyRuntimeState(
    legacy: LegacyRow,
    ownerPlayerId: string | null,
  ): CompanionSnapshot {
    const stopGeneration = integerValue(legacy.stopGeneration, 0);
    if (stopGeneration < 0 || !Number.isSafeInteger(stopGeneration)) {
      throw new CompanionStoreError(
        "LEGACY_STATE_INVALID",
        "Legacy stop generation is invalid.",
      );
    }
    const interests = this.readLegacyInterests();
    const relationshipSummary =
      this.readLegacyRelationshipSummary(ownerPlayerId);
    const goal = migrateLegacyGoal(legacy.goals);
    const pendingPlan = migrateLegacyPlan(legacy.actionPlan);
    const activeOperation = isRecord(legacy.activeOperation)
      ? legacy.activeOperation
      : null;
    let plan = pendingPlan;
    let lastOutcome = migrateLegacyLastOutcome(
      legacy.lastOutcome,
      legacy.actionPlan,
    );
    if (activeOperation !== null) {
      const interrupted = legacyInterruptedOutcome(
        activeOperation,
        legacy.actionPlan,
      );
      if (interrupted !== null) {
        this.insertJournalOutcome(
          interrupted,
          legacyEventKey("active", interrupted.operationId),
        );
        this.insertMemory({
          kind: "episode",
          content: outcomeMemoryText(interrupted),
          source: "bot_inferred",
          status: "active",
          importance: 4,
          metadata: {
            legacyActiveOperation: recordToJson(activeOperation),
            outcome: outcomeToJson(interrupted),
          },
          sourceKey: legacyEventKey("active", interrupted.operationId),
          createdAt: interrupted.observedAt,
          updatedAt: interrupted.observedAt,
        });
        lastOutcome = interrupted;
      } else {
        const operationKind = stringValue(activeOperation.kind);
        this.insertMemory({
          kind: "episode",
          content: `Restart interrupted an unverified ${operationKind ?? "unknown"} operation. It was not replayed.`,
          source: "bot_inferred",
          status: "active",
          importance: 4,
          metadata: { legacyActiveOperation: recordToJson(activeOperation) },
          sourceKey: legacyEventKey(
            "active",
            stringValue(activeOperation.operationId) ??
              stableLegacyId(JSON.stringify(activeOperation)),
          ),
          createdAt: stringValue(activeOperation.startedAt) ?? this.#now(),
        });
      }
      plan = null;
    }
    if (lastOutcome !== null) {
      this.insertJournalOutcome(
        lastOutcome,
        legacyEventKey("last-outcome", lastOutcome.operationId),
      );
      this.insertMemory({
        kind: "episode",
        content: outcomeMemoryText(lastOutcome),
        source:
          lastOutcome.status === "successful" || lastOutcome.status === "failed"
            ? "minecraft_observed"
            : "bot_inferred",
        status: "active",
        importance: 4,
        metadata: { outcome: outcomeToJson(lastOutcome) },
        sourceKey: legacyEventKey("last-outcome", lastOutcome.operationId),
        createdAt: lastOutcome.observedAt,
        updatedAt: lastOutcome.observedAt,
      });
    }
    return {
      stopped: legacy.stopped === true,
      stopGeneration,
      goal,
      plan,
      waitUntil: null,
      activeOperation: null,
      lastOutcome,
      relationshipSummary,
      interests,
    };
  }

  private readLegacyMemorySnapshot(
    ownerPlayerId: string | null,
  ): CompanionSnapshot {
    return {
      ...emptySnapshot,
      relationshipSummary: this.readLegacyRelationshipSummary(ownerPlayerId),
      interests: this.readLegacyInterests(),
    };
  }

  private readLegacyRelationshipSummary(ownerPlayerId: string | null): string {
    if (
      !tableExists(this.#database, "relationships") ||
      ownerPlayerId === null
    ) {
      return "";
    }
    const row = this.#database
      .prepare<[string], LegacyRow>(
        "SELECT player_id, trust, intimacy, state_json, updated_at FROM relationships WHERE player_id = ?",
      )
      .get(ownerPlayerId);
    if (row === undefined) return "";
    const state = parseLegacyJson(row.state_json);
    const summary =
      isRecord(state) &&
      (stringValue(state.summary) ?? stringValue(state.relationshipSummary));
    if (summary)
      return boundedText(summary, "relationship summary", MAX_TEXT_LENGTH);
    const relationship = {
      trust: row.trust,
      intimacy: row.intimacy,
      state,
    };
    return `Relationship context: ${jsonText(relationship, MAX_TEXT_LENGTH)}`;
  }

  private readLegacyInterests(): string[] {
    if (!tableExists(this.#database, "life_states")) return [];
    const columns = tableColumns(this.#database, "life_states");
    if (!columns.has("current_interests_json")) return [];
    const row = this.#database
      .prepare<[], LegacyRow>(
        "SELECT current_interests_json FROM life_states WHERE singleton_id = 1",
      )
      .get();
    if (row === undefined) return [];
    const parsed = parseLegacyJson(row.current_interests_json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((interest) =>
        typeof interest === "string"
          ? interest.trim()
          : isRecord(interest)
            ? (stringValue(interest.name) ??
              stringValue(interest.summary) ??
              "")
            : "",
      )
      .filter((interest) => interest.length > 0)
      .slice(0, 40)
      .map((interest) => interest.slice(0, 240));
  }

  private importLegacyMemories(ownerPlayerId: string | null): void {
    const directTables: readonly [string, CompanionMemoryKind][] = [
      ["facts", "fact"],
      ["locations", "world"],
      ["commitments", "commitment"],
      ["episodes", "episode"],
      ["world_memories", "world"],
      ["behavior_memories", "behavior"],
    ];
    for (const [table, kind] of directTables) {
      for (const row of this.legacyRowsForOwner(table, ownerPlayerId)) {
        this.importLegacyRow(table, kind, row);
      }
    }
    if (
      tableExists(this.#database, "relationships") &&
      ownerPlayerId !== null
    ) {
      const row = this.#database
        .prepare<[string], LegacyRow>(
          "SELECT * FROM relationships WHERE player_id = ?",
        )
        .get(ownerPlayerId);
      if (row !== undefined) {
        this.importLegacyRow("relationships", "relationship", row);
      }
    }
    if (tableExists(this.#database, "life_states")) {
      for (const row of this.#database
        .prepare<[], LegacyRow>(
          "SELECT * FROM life_states ORDER BY singleton_id",
        )
        .all()) {
        this.importLegacyRow("life_states", "life", row);
      }
    }
    this.importLegacyTasks(ownerPlayerId);
    this.importLegacySkills();
    this.importLegacySkillOutcomes();
  }

  private importLegacyRuntimeHistory(legacy: LegacyRow): void {
    if (Array.isArray(legacy.goals)) {
      legacy.goals.filter(isRecord).forEach((goal, index) => {
        const status = stringValue(goal.status) ?? "unknown";
        const title = stringValue(goal.title) ?? "Legacy goal";
        const source =
          goal.source === "owner"
            ? "player_stated"
            : goal.source === "persona"
              ? "system"
              : "bot_inferred";
        this.insertMemory({
          kind: "goal",
          content: `Goal [${status}]: ${title}. ${stringValue(goal.changeReason) ?? ""}`,
          source,
          status: status === "active" ? "active" : "archived",
          importance: Math.max(1, Math.min(5, integerValue(goal.priority, 3))),
          metadata: {
            legacyTable: "player_runtime_state.goals",
            legacyRow: recordToJson(goal),
          },
          sourceKey: `legacy:player_runtime_goal:${stringValue(goal.id) ?? String(index)}`,
          createdAt: legacyTimestamp(goal.updatedAt),
          updatedAt: legacyTimestamp(goal.updatedAt),
        });
      });
    }
    if (isRecord(legacy.actionPlan)) {
      const content = legacySkillContent({
        title: "Legacy action plan",
        purpose: legacy.actionPlan.purpose,
        body: Array.isArray(legacy.actionPlan.steps)
          ? legacy.actionPlan.steps
              .filter(isRecord)
              .map((step) => {
                const operation = isRecord(step.operation)
                  ? step.operation.kind
                  : "unknown";
                return `${String(operation)}: ${stringValue(step.expectedOutcome) ?? ""}`;
              })
              .join("; ")
          : "",
      });
      this.insertMemory({
        kind: "task",
        content,
        source: "bot_inferred",
        status: "archived",
        importance: 2,
        metadata: {
          legacyTable: "player_runtime_state.actionPlan",
          legacyRow: recordToJson(legacy.actionPlan),
        },
        sourceKey: `legacy:player_action_plan:${stringValue(legacy.actionPlan.id) ?? stableLegacyId(JSON.stringify(recordToJson(legacy.actionPlan)))}`,
      });
    }
    if (Array.isArray(legacy.recentOutcomes)) {
      legacy.recentOutcomes.filter(isRecord).forEach((outcome, index) => {
        const operationId = stringValue(outcome.operationId) ?? String(index);
        const status = stringValue(outcome.status) ?? "unknown";
        const kind = stringValue(outcome.kind) ?? "unknown";
        this.insertMemory({
          kind: "episode",
          content: `${status} ${kind}: ${stringValue(outcome.summary) ?? "Legacy operation outcome"}`,
          source:
            status === "successful" || status === "failed"
              ? "minecraft_observed"
              : "bot_inferred",
          status: "active",
          importance: status === "failed" ? 4 : 3,
          metadata: {
            legacyTable: "player_runtime_state.recentOutcomes",
            legacyRow: recordToJson(outcome),
          },
          sourceKey: `legacy:player_recent_outcome:${operationId}`,
          createdAt: legacyTimestamp(outcome.observedAt),
          updatedAt: legacyTimestamp(outcome.observedAt),
        });
      });
    }
    for (const field of ["stateFacts", "uncertainties"] as const) {
      if (!Array.isArray(legacy[field])) continue;
      legacy[field].filter(isRecord).forEach((note, index) => {
        const summary = stringValue(note.summary);
        if (summary === undefined) return;
        const source =
          note.source === "owner"
            ? "player_stated"
            : note.source === "observed"
              ? "minecraft_observed"
              : "bot_inferred";
        const id = stringValue(note.id) ?? String(index);
        this.insertMemory({
          kind: field === "uncertainties" ? "other" : "fact",
          content: `${field === "uncertainties" ? "Uncertainty" : "State fact"}: ${summary}`,
          source,
          status: "active",
          importance: field === "uncertainties" ? 2 : 4,
          metadata: {
            legacyTable: `player_runtime_state.${field}`,
            legacyRow: recordToJson(note),
          },
          sourceKey: `legacy:player_${field}:${id}`,
          createdAt: legacyTimestamp(note.updatedAt),
          updatedAt: legacyTimestamp(note.updatedAt),
        });
      });
    }
    if (isRecord(legacy.latestDeath)) {
      const cause = stringValue(legacy.latestDeath.cause) ?? "unknown";
      this.insertMemory({
        kind: "episode",
        content: `Latest recorded death: ${cause}. ${jsonText(legacy.latestDeath, 1_200)}`,
        source: "minecraft_observed",
        status: "active",
        importance: 5,
        metadata: {
          legacyTable: "player_runtime_state.latestDeath",
          legacyRow: recordToJson(legacy.latestDeath),
        },
        sourceKey: `legacy:player_latest_death:${stringValue(legacy.latestDeath.id) ?? stableLegacyId(JSON.stringify(recordToJson(legacy.latestDeath)))}`,
        createdAt: legacyTimestamp(legacy.latestDeath.observedAt),
        updatedAt: legacyTimestamp(legacy.latestDeath.observedAt),
      });
    }
    if (Array.isArray(legacy.proposals)) {
      legacy.proposals.filter(isRecord).forEach((proposal, index) => {
        const id = stringValue(proposal.id) ?? String(index);
        this.insertMemory({
          kind: "goal",
          content: `Owner goal proposal [${textPart(proposal.status)}]: ${textPart(proposal.title)}. ${textPart(proposal.reason)}`,
          source: "player_stated",
          status: proposal.status === "pending" ? "active" : "archived",
          importance: Math.max(
            1,
            Math.min(5, integerValue(proposal.priorityPreference, 3)),
          ),
          metadata: {
            legacyTable: "player_runtime_state.proposals",
            legacyRow: recordToJson(proposal),
          },
          sourceKey: `legacy:player_goal_proposal:${id}`,
          createdAt: legacyTimestamp(proposal.createdAt),
          updatedAt: legacyTimestamp(proposal.createdAt),
        });
      });
    }
  }

  private legacyRowsForOwner(
    table: string,
    ownerPlayerId: string | null,
  ): LegacyRow[] {
    if (!tableExists(this.#database, table)) return [];
    const columns = tableColumns(this.#database, table);
    if (columns.has("player_id")) {
      if (ownerPlayerId === null) return [];
      return this.#database
        .prepare<[string], LegacyRow>(
          `SELECT * FROM ${quoteIdentifier(table)} WHERE player_id = ? ORDER BY rowid`,
        )
        .all(ownerPlayerId);
    }
    return this.#database
      .prepare<[], LegacyRow>(
        `SELECT * FROM ${quoteIdentifier(table)} ORDER BY rowid`,
      )
      .all();
  }

  private importLegacyRow(
    table: string,
    kind: CompanionMemoryKind,
    row: LegacyRow,
  ): void {
    const status = legacyStatus(row.status, table);
    const source = legacySource(row.source, table);
    const sourceKey = `legacy:${table}:${legacyRowIdentity(row)}`;
    this.insertMemory({
      kind,
      content: legacyContent(table, row),
      source,
      status,
      importance: legacyImportance(row, table),
      metadata: { legacyTable: table, legacyRow: recordToJson(row) },
      sourceKey,
      createdAt: legacyTimestamp(row.created_at, row.observed_at),
      updatedAt: legacyTimestamp(
        row.updated_at,
        row.observed_at,
        row.created_at,
      ),
    });
  }

  private importLegacyTasks(ownerPlayerId: string | null): void {
    if (!tableExists(this.#database, "task_runs")) return;
    const taskColumns = tableColumns(this.#database, "task_runs");
    const tasks = taskColumns.has("player_id")
      ? this.#database
          .prepare<[string | null], LegacyRow>(
            "SELECT * FROM task_runs WHERE player_id = ? OR player_id IS NULL ORDER BY rowid",
          )
          .all(ownerPlayerId)
      : this.#database
          .prepare<[], LegacyRow>("SELECT * FROM task_runs ORDER BY rowid")
          .all();
    const taskIds = new Set<string>();
    for (const row of tasks) {
      const id = stringValue(row.id);
      if (id !== undefined) taskIds.add(id);
      this.importLegacyRow("task_runs", "task", row);
    }
    if (!tableExists(this.#database, "task_checkpoints")) return;
    const checkpoints = this.#database
      .prepare<[], LegacyRow>("SELECT * FROM task_checkpoints ORDER BY rowid")
      .all();
    for (const row of checkpoints) {
      const taskRunId = stringValue(row.task_run_id);
      if (taskRunId !== undefined && taskIds.has(taskRunId)) {
        this.importLegacyRow("task_checkpoints", "task", row);
      }
    }
  }

  private importLegacySkills(): void {
    if (!tableExists(this.#database, "mc_bot_skills")) return;
    const skills = this.#database
      .prepare<[], LegacyRow>("SELECT * FROM mc_bot_skills ORDER BY id")
      .all();
    const skillById = new Map<string, LegacyRow>();
    for (const skill of skills) {
      const id = stringValue(skill.id);
      if (id !== undefined) skillById.set(id, skill);
    }
    const importedCurrent = new Set<string>();
    if (tableExists(this.#database, "mc_bot_skill_revisions")) {
      const revisions = this.#database
        .prepare<[], LegacyRow>(
          "SELECT * FROM mc_bot_skill_revisions ORDER BY skill_id, version",
        )
        .all();
      for (const revision of revisions) {
        const skillId = stringValue(revision.skill_id) ?? "unknown";
        const current = skillById.get(skillId);
        const version = integerValue(revision.version, 0);
        const currentVersion = integerValue(current?.version, -1);
        const status: CompanionMemoryStatus =
          current !== undefined && version === currentVersion
            ? "active"
            : "archived";
        if (status === "active") importedCurrent.add(skillId);
        this.insertMemory({
          kind: "skill_lesson",
          content: legacySkillContent(revision),
          source: "system",
          status,
          importance: status === "active" ? 4 : 2,
          metadata: {
            legacyTable: "mc_bot_skill_revisions",
            legacyRow: recordToJson(revision),
            currentVersion,
          },
          sourceKey: `legacy:mc_bot_skill_revisions:${skillId}:${version}`,
          createdAt: legacyTimestamp(revision.created_at),
          updatedAt: legacyTimestamp(revision.created_at),
        });
      }
    }
    for (const [skillId, skill] of skillById) {
      if (importedCurrent.has(skillId)) continue;
      const version = integerValue(skill.version, 1);
      this.insertMemory({
        kind: "skill_lesson",
        content: legacySkillContent(skill),
        source: "system",
        status: "active",
        importance: 4,
        metadata: {
          legacyTable: "mc_bot_skills",
          legacyRow: recordToJson(skill),
        },
        sourceKey: `legacy:mc_bot_skills:${skillId}:${version}`,
        createdAt: legacyTimestamp(skill.created_at),
        updatedAt: legacyTimestamp(skill.updated_at, skill.created_at),
      });
    }
  }

  private importLegacySkillOutcomes(): void {
    if (!tableExists(this.#database, "mc_bot_skill_outcomes")) return;
    for (const row of this.#database
      .prepare<[], LegacyRow>(
        "SELECT * FROM mc_bot_skill_outcomes ORDER BY recorded_at, run_id",
      )
      .all()) {
      const outcomeStatus = stringValue(row.status) ?? "unknown";
      const observed =
        row.evidence_receipt_id !== null &&
        (outcomeStatus === "successful" || outcomeStatus === "failed");
      const summary = stringValue(row.summary) ?? "Legacy skill outcome";
      this.insertMemory({
        kind: "episode",
        content: `${stringValue(row.proposed_outcome) ?? outcomeStatus}: ${summary}`,
        source: observed ? "minecraft_observed" : "bot_inferred",
        status: "active",
        importance: outcomeStatus === "failed" ? 4 : 3,
        metadata: {
          legacyTable: "mc_bot_skill_outcomes",
          legacyRow: recordToJson(row),
        },
        sourceKey: `legacy:mc_bot_skill_outcomes:${stringValue(row.run_id) ?? legacyRowIdentity(row)}`,
        createdAt: legacyTimestamp(row.recorded_at),
        updatedAt: legacyTimestamp(row.recorded_at),
      });
    }
  }
}

function validateOperationPlanPair(snapshot: CompanionSnapshot): void {
  const active = snapshot.activeOperation;
  if (active === null || snapshot.plan === null) return;
  const head = snapshot.plan.steps[0];
  if (
    head === undefined ||
    !sameOperation(head.operation, active.operation) ||
    head.expectedOutcome !== active.expectedOutcome
  ) {
    throw invalidInput("Active operation must match the plan head.");
  }
}

function migrateLegacyGoal(value: unknown): CompanionGoal | null {
  if (!Array.isArray(value)) return null;
  const goals = value.filter(isRecord);
  const selected = goals.find((goal) => goal.status === "active");
  if (selected === undefined) return null;
  const title = stringValue(selected.title);
  if (title === undefined) return null;
  const source =
    selected.source === "owner" || selected.source === "persona"
      ? selected.source
      : "self";
  return {
    title: title.slice(0, 240),
    successCondition: (
      stringValue(selected.successCondition) ??
      stringValue(selected.changeReason) ??
      title
    ).slice(0, 400),
    source,
  };
}

function migrateLegacyPlan(value: unknown): CompanionPlan | null {
  if (!isRecord(value)) return null;
  const purpose = stringValue(value.purpose);
  if (purpose === undefined || !Array.isArray(value.steps)) return null;
  const steps = value.steps
    .filter(isRecord)
    .filter((step) => step.status === "pending" || step.status === "superseded")
    .flatMap((step) => {
      const operation = playerOperationSchema.safeParse(step.operation);
      const expectedOutcome = stringValue(step.expectedOutcome);
      if (!operation.success || expectedOutcome === undefined) return [];
      return [
        {
          operation: operation.data,
          expectedOutcome: expectedOutcome.slice(0, 400),
        },
      ];
    })
    .slice(0, companionPlanStepLimit);
  return steps.length === 0 ? null : { purpose: purpose.slice(0, 400), steps };
}

function migrateLegacyLastOutcome(
  value: unknown,
  legacyPlan: unknown,
): CompanionOutcome | null {
  if (!isRecord(value)) return null;
  const operationId = stringValue(value.operationId);
  const status = companionOutcomeStatuses.includes(
    stringValue(value.status) as CompanionOutcomeStatus,
  )
    ? (value.status as CompanionOutcomeStatus)
    : null;
  const kind = stringValue(value.kind);
  if (operationId === undefined || status === null || kind === undefined)
    return null;
  const operation = findLegacyOperationByKind(legacyPlan, kind);
  if (operation === null) return null;
  const summary = stringValue(value.summary);
  const observedAt = stringValue(value.observedAt);
  if (summary === undefined || !validDate(observedAt)) return null;
  const outcome: CompanionOutcome = {
    operationId,
    operation,
    status,
    summary: summary.slice(0, MAX_TEXT_LENGTH),
    observedAt,
  };
  const expectedOutcome = stringValue(value.expectedOutcome);
  return expectedOutcome === undefined
    ? outcome
    : { ...outcome, expectedOutcome: expectedOutcome.slice(0, 400) };
}

function legacyInterruptedOutcome(
  active: LegacyRow,
  legacyPlan: unknown,
): CompanionOutcome | null {
  const operationId = stringValue(active.operationId);
  const kind = stringValue(active.kind);
  const operation =
    kind === undefined ? null : findLegacyOperationByKind(legacyPlan, kind);
  if (operationId === undefined || operation === null) return null;
  const expectedOutcome = stringValue(active.expectedOutcome);
  const startedAt =
    stringValue(active.bodyStartedAt) ?? stringValue(active.startedAt);
  const outcome: CompanionOutcome = {
    operationId,
    operation,
    status: "unverified",
    summary:
      "Interrupted by restart; the world result was not verified and the operation was not replayed.",
    observedAt: validDate(startedAt) ? startedAt : new Date(0).toISOString(),
  };
  return expectedOutcome === undefined
    ? outcome
    : { ...outcome, expectedOutcome: expectedOutcome.slice(0, 400) };
}

function findLegacyOperationByKind(value: unknown, kind: string) {
  if (!isRecord(value) || !Array.isArray(value.steps)) return null;
  for (const step of value.steps) {
    if (!isRecord(step)) continue;
    const parsed = playerOperationSchema.safeParse(step.operation);
    if (parsed.success && parsed.data.kind === kind) return parsed.data;
  }
  return null;
}

function legacyContent(table: string, row: LegacyRow): string {
  switch (table) {
    case "facts":
      return `${textPart(row.subject)} ${textPart(row.predicate)}: ${jsonText(parseLegacyJson(row.value_json), 1_200)}`;
    case "locations":
      return `${textPart(row.name)}: ${textPart(row.purpose)} (${textPart(row.dimension)} ${coordinateText(row)})`;
    case "commitments":
      return `${textPart(row.description)}${row.status === undefined ? "" : ` [${textPart(row.status)}]`} ${jsonText(parseLegacyJson(row.outcome_json), 600)}`;
    case "episodes":
      return `${textPart(row.summary)} ${jsonText(parseLegacyJson(row.details_json), 1_200)}`;
    case "world_memories":
      return `${textPart(row.kind)} ${textPart(row.name)}: ${textPart(row.description)} (${textPart(row.dimension)} ${coordinateText(row)})`;
    case "behavior_memories":
      return `${textPart(row.category)} ${textPart(row.slot)}: ${textPart(row.value)}. ${textPart(row.summary)}`;
    case "relationships":
      return `Relationship summary: trust ${textPart(row.trust)}, intimacy ${textPart(row.intimacy)}. ${jsonText(parseLegacyJson(row.state_json), 1_200)}`;
    case "life_states":
      return `Interests: ${jsonText(parseLegacyJson(row.current_interests_json), 600)}. Goals: ${jsonText(parseLegacyJson(row.long_term_goals_json), 600)}. Home: ${jsonText(parseLegacyJson(row.home_base_json), 500)}. Possessions: ${jsonText(parseLegacyJson(row.possessions_json), 500)}`;
    case "task_runs":
      return `${textPart(row.kind)} ${textPart(row.status)}: ${jsonText(parseLegacyJson(row.input_json), 600)} ${jsonText(parseLegacyJson(row.output_json), 600)} ${jsonText(parseLegacyJson(row.failure_json), 400)}`;
    case "task_checkpoints":
      return `${textPart(row.phase)}: ${jsonText(parseLegacyJson(row.data_json), 1_200)}`;
    default:
      return textPart(row.summary) || legacySkillContent(row);
  }
}

function legacySkillContent(row: LegacyRow): string {
  return [
    stringValue(row.category),
    stringValue(row.title),
    stringValue(row.purpose),
    `Conditions: ${jsonText(parseLegacyJson(row.conditions_json), 800)}`,
    stringValue(row.body),
    `Expected: ${stringValue(row.expected_outcome) ?? stringValue(row.expectedOutcome) ?? ""}`,
    `Change: ${stringValue(row.change_kind)} ${stringValue(row.change_note)}`,
  ]
    .filter((part) => part !== undefined && part.length > 0)
    .join("\n");
}

function legacyStatus(value: unknown, table: string): CompanionMemoryStatus {
  if (value === "superseded" || value === "retracted") return value;
  if (value === "active") return "active";
  if (table === "commitments")
    return value === "active" ? "active" : "archived";
  if (table === "task_runs" || table === "task_checkpoints") return "archived";
  return "active";
}

function legacySource(value: unknown, table: string): CompanionMemorySource {
  if (
    value === "player_stated" ||
    value === "minecraft_observed" ||
    value === "bot_inferred" ||
    value === "system"
  ) {
    return value;
  }
  if (
    table === "behavior_memories" &&
    (value === "owner_explicit" ||
      value === "owner_correction" ||
      value === "owner_feedback")
  ) {
    return "player_stated";
  }
  if (table.startsWith("mc_bot_skill_")) return "system";
  return "bot_inferred";
}

function legacyImportance(row: LegacyRow, table: string): number {
  const value = integerValue(
    row.importance,
    table === "behavior_memories" ? 4 : 3,
  );
  return Math.max(1, Math.min(5, value));
}

function legacyRowIdentity(row: LegacyRow): string {
  for (const key of [
    "id",
    "memory_id",
    "skill_id",
    "run_id",
    "receipt_id",
    "player_id",
    "singleton_id",
  ]) {
    const value = row[key];
    if (typeof value === "string" || typeof value === "number") {
      const version = row.version;
      const suffix =
        key === "skill_id" &&
        (typeof version === "string" || typeof version === "number")
          ? `:${version}`
          : "";
      return `${key}:${String(value)}${suffix}`;
    }
  }
  return createHash("sha256")
    .update(JSON.stringify(recordToJson(row)))
    .digest("hex");
}

function legacyTimestamp(...values: unknown[]): string {
  for (const value of values) {
    if (validDate(value)) return value;
  }
  return new Date(0).toISOString();
}

function memoryFromRow(row: MemoryRow): CompanionMemory {
  return {
    id: row.memory_id,
    kind: memoryKind(row.kind),
    content: row.content,
    source: memorySource(row.source),
    status: memoryStatus(row.status),
    importance: Math.max(1, Math.min(5, row.importance)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJsonValue(row.metadata_json),
  };
}

function memoryKind(value: string): CompanionMemoryKind {
  if (companionMemoryKinds.includes(value as CompanionMemoryKind)) {
    return value as CompanionMemoryKind;
  }
  return "other";
}

function memorySource(value: string): CompanionMemorySource {
  if (companionMemorySources.includes(value as CompanionMemorySource)) {
    return value as CompanionMemorySource;
  }
  return "bot_inferred";
}

function memoryStatus(value: string): CompanionMemoryStatus {
  if (companionMemoryStatuses.includes(value as CompanionMemoryStatus)) {
    return value as CompanionMemoryStatus;
  }
  return "archived";
}

function strongerSource(
  existing: CompanionMemorySource,
  candidate: CompanionMemorySource,
): CompanionMemorySource {
  if (existing === "system" || existing === "player_stated") return existing;
  if (candidate === "system" || candidate === "player_stated") return candidate;
  if (candidate === "minecraft_observed") return candidate;
  return existing;
}

function contentFingerprint(kind: string, content: string): string {
  const normalized = content
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s\u3000]+/gu, " ")
    .trim();
  return createHash("sha256").update(`${kind}\0${normalized}`).digest("hex");
}

function searchTerms(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("ja-JP");
  const terms = new Set<string>();
  for (const word of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (word.length > 1 || /[0-9]/u.test(word)) terms.add(word);
  }
  for (const run of normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu,
  ) ?? []) {
    const characters = graphemeSegments(run);
    if (characters.length === 1) terms.add(characters[0] ?? "");
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return terms;
}

function selectRecallTerms(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("ja-JP");
  const fullRuns =
    normalized.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{3,64}/gu,
    ) ?? [];
  const terms = [...new Set([...fullRuns, ...searchTerms(value)])];
  if (terms.length <= MAX_RECALL_TERMS) return terms;

  const specific = terms.filter((term) => graphemeSegments(term).length > 2);
  const selected = specific.slice(0, MAX_RECALL_TERMS);
  if (selected.length === MAX_RECALL_TERMS) return selected;
  const bigrams = terms.filter((term) => graphemeSegments(term).length <= 2);
  const remaining = MAX_RECALL_TERMS - selected.length;
  for (let index = 0; index < remaining && bigrams.length > 0; index += 1) {
    const candidateIndex = Math.floor((index * bigrams.length) / remaining);
    const candidate = bigrams[candidateIndex];
    if (candidate !== undefined && !selected.includes(candidate))
      selected.push(candidate);
  }
  return selected;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

const japaneseGraphemeSegmenter = new Intl.Segmenter("ja-JP", {
  granularity: "grapheme",
});

function graphemeSegments(value: string): string[] {
  return Array.from(
    japaneseGraphemeSegmenter.segment(value),
    ({ segment }) => segment,
  );
}

function sameOperation(
  left: CompanionActiveOperation["operation"],
  right: CompanionActiveOperation["operation"],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function outcomeMemoryText(outcome: CompanionOutcome): string {
  return `${outcome.status} ${outcome.operation.kind}: ${outcome.summary}${outcome.expectedOutcome === undefined ? "" : ` Expected: ${outcome.expectedOutcome}`}`;
}

function outcomeToJson(outcome: CompanionOutcome): JsonObject {
  return {
    operationId: outcome.operationId,
    operation: recordToJson(outcome.operation),
    status: outcome.status,
    summary: outcome.summary,
    ...(outcome.expectedOutcome === undefined
      ? {}
      : { expectedOutcome: outcome.expectedOutcome }),
    observedAt: outcome.observedAt,
  };
}

function tableExists(database: Database.Database, name: string): boolean {
  return (
    database
      .prepare<[string], { readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

function tableColumns(database: Database.Database, table: string): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => stringValue((row as LegacyRow).name) ?? ""),
  );
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) {
    throw new CompanionStoreError("DATABASE_ERROR", "Unsupported table name.");
  }
  return `"${value}"`;
}

function parseLegacyJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseJsonValue(value: string): JsonValue {
  try {
    return jsonValue(JSON.parse(value) as unknown);
  } catch {
    throw new CompanionStoreError(
      "INVALID_STATE",
      "Stored memory metadata is corrupt.",
    );
  }
}

function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isRecord(value)) return recordToJson(value);
  return null;
}

function recordToJson(value: Record<string, unknown>): JsonObject {
  const entries: [string, JsonValue][] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    entries.push([key, jsonValue(child)]);
  }
  return Object.fromEntries(entries);
}

function mergeJsonMetadata(left: JsonValue, right: JsonValue): JsonValue {
  if (!isRecord(left) || !isRecord(right)) return right;
  return { ...recordToJson(left), ...recordToJson(right) };
}

function jsonText(value: unknown, limit: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, limit);
  try {
    return JSON.stringify(jsonValue(value)).slice(0, limit);
  } catch {
    return "";
  }
}

function textPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null || value === undefined) return "";
  return jsonText(value, 400);
}

function coordinateText(row: LegacyRow): string {
  if (
    typeof row.x !== "number" ||
    typeof row.y !== "number" ||
    typeof row.z !== "number"
  ) {
    return "";
  }
  return `(${row.x}, ${row.y}, ${row.z})`;
}

function stableLegacyId(sourceKey: string): string {
  return `legacy-${createHash("sha256").update(sourceKey).digest("hex").slice(0, 32)}`;
}

function legacyEventKey(kind: string, value: string): string {
  return `legacy-${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextStopGeneration(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new CompanionStoreError(
      "INVALID_STATE",
      "Owner stop generation cannot be incremented safely.",
    );
  }
  return value + 1;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw invalidInput(`${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw invalidInput(`${label} length is invalid.`);
  }
  return normalized;
}

function assertNoCredentialLikeContent(value: string): void {
  if (hasCredentialLikeContent(value)) {
    throw invalidInput("Memory content contains a credential-like value.");
  }
}

function hasCredentialLikeContent(value: unknown): boolean {
  if (typeof value === "string") {
    return SECRET_LABEL.test(value) || SECRET_VALUE.test(value);
  }
  if (Array.isArray(value)) return value.some(hasCredentialLikeContent);
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, child]) =>
        SECRET_LABEL.test(key) ||
        SECRET_VALUE.test(key) ||
        hasCredentialLikeContent(child),
    );
  }
  return false;
}

function sanitizeLegacyJsonValue(value: unknown): {
  readonly value: JsonValue;
  readonly changed: boolean;
} {
  if (typeof value === "string") {
    return hasCredentialLikeContent(value)
      ? { value: LEGACY_REDACTION_VALUE, changed: true }
      : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const children = value.map((child) => {
      const result = sanitizeLegacyJsonValue(child);
      changed ||= result.changed;
      return result.value;
    });
    return { value: children, changed };
  }
  if (isRecord(value)) {
    let changed = false;
    const entries = Object.entries(value).map(([key, child], index) => {
      if (hasCredentialLikeContent(key)) {
        changed = true;
        return [`redactedLegacyField${index}`, LEGACY_REDACTION_VALUE] as const;
      }
      const result = sanitizeLegacyJsonValue(child);
      changed ||= result.changed;
      return [key, result.value] as const;
    });
    return { value: Object.fromEntries(entries), changed };
  }
  return { value: jsonValue(value), changed: false };
}

function withLegacyRedactionFlag(value: JsonValue): JsonObject {
  const safe = isRecord(value)
    ? recordToJson(value)
    : { legacyMetadata: value };
  return { ...safe, legacyCredentialRedacted: true };
}

function sanitizeLegacySnapshot(
  snapshot: CompanionSnapshot,
): CompanionSnapshot {
  const unsafeGoal = hasCredentialLikeContent(snapshot.goal);
  const unsafePlan = hasCredentialLikeContent(snapshot.plan);
  const unsafeLastOutcome = hasCredentialLikeContent(snapshot.lastOutcome);
  const relationshipSummary = hasCredentialLikeContent(
    snapshot.relationshipSummary,
  )
    ? ""
    : snapshot.relationshipSummary;
  const interests = snapshot.interests.filter(
    (interest) => !hasCredentialLikeContent(interest),
  );
  return {
    ...snapshot,
    goal: unsafeGoal ? null : snapshot.goal,
    plan: unsafePlan ? null : snapshot.plan,
    lastOutcome: unsafeLastOutcome ? null : snapshot.lastOutcome,
    relationshipSummary,
    interests,
  };
}

function invalidInput(message: string): CompanionStoreError {
  return new CompanionStoreError("INVALID_INPUT", message);
}

function databaseInvariant(): CompanionStoreError {
  return new CompanionStoreError(
    "DATABASE_ERROR",
    "A companion store row disappeared during a transaction.",
  );
}
