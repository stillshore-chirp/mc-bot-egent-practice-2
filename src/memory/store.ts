import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  commitmentStatuses,
  factSources,
  factStatuses,
  memoryKinds,
  taskRunStatuses,
  worldMemoryKinds,
  worldMemoryStatuses,
} from "./types.js";
import type {
  CommitmentRecord,
  CommitmentStatus,
  CompleteCommitmentInput,
  CorrectWorldMemoryInput,
  CreateTaskRunInput,
  EpisodeRecord,
  FactRecord,
  FactSource,
  FactStatus,
  JsonObject,
  JsonValue,
  LifeHomeBase,
  LifePossession,
  LifeStateRecord,
  LocationRecord,
  MemoryKind,
  PlayerRecord,
  RecallInput,
  RecallItem,
  RecordEpisodeInput,
  RecordTaskCheckpointInput,
  RelationshipRecord,
  RememberWorldMemoryInput,
  RememberLocationInput,
  RememberPlayerFactInput,
  SaveLifeStateInput,
  SearchWorldMemoriesInput,
  SetCommitmentInput,
  StoredFailure,
  TaskCheckpoint,
  TaskRunRecord,
  TaskRunStatus,
  UpdateTaskRunInput,
  UpdateCommitmentProgressInput,
  WorldMemoryKind,
  WorldMemoryRecord,
  WorldMemoryStatus,
} from "./types.js";

const SCHEMA_VERSION = 2;
const DEFAULT_RECALL_LIMIT = 8;
const MAX_RECALL_LIMIT = 30;
const MAX_TEXT_LENGTH = 1_000;
const MAX_JSON_BYTES = 16_384;
const GLOBAL_MEMORY_OWNER = "companion";
const LIFE_STATE_ID = "life-state";
const SECRET_LABEL =
  /(?:^|[\s_:=,-])(api[\s_-]?key|authorization|bearer|password|private[\s_-]?key|secret)(?:$|[\s_:=,-])/iu;
const SECRET_VALUE =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u;

export class MemoryStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

interface VersionRow {
  readonly version: number;
}

interface PlayerRow {
  readonly id: string;
  readonly external_name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RelationshipRow {
  readonly player_id: string;
  readonly trust: number;
  readonly intimacy: number;
  readonly state_json: string;
  readonly updated_at: string;
}

interface FactRow {
  readonly id: string;
  readonly player_id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value_json: string;
  readonly source: string;
  readonly status: string;
  readonly dedupe_key: string;
  readonly superseded_by_id: string | null;
  readonly retraction_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface LocationRow {
  readonly id: string;
  readonly player_id: string;
  readonly name: string;
  readonly purpose: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface LifeStateRow {
  readonly current_interests_json: string;
  readonly long_term_goals_json: string;
  readonly home_base_json: string | null;
  readonly possessions_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface WorldMemoryRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly source: string;
  readonly status: string;
  readonly dedupe_key: string;
  readonly superseded_by_id: string | null;
  readonly retraction_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CommitmentRow {
  readonly id: string;
  readonly player_id: string;
  readonly description: string;
  readonly status: string;
  readonly outcome_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface TaskRunRow {
  readonly id: string;
  readonly player_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly phase: string;
  readonly input_json: string;
  readonly output_json: string | null;
  readonly failure_json: string | null;
  readonly checkpoint_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SearchRow {
  readonly memory_id: string;
  readonly memory_kind: string;
  readonly content: string;
  readonly recorded_at: string;
}

interface IdRow {
  readonly id: string;
}

interface SequenceRow {
  readonly next_sequence: number;
}

const migrationV1 = [
  "CREATE TABLE players (id TEXT PRIMARY KEY, external_name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE relationships (player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE, trust INTEGER NOT NULL DEFAULT 0 CHECK (trust BETWEEN 0 AND 100), intimacy INTEGER NOT NULL DEFAULT 0 CHECK (intimacy BETWEEN 0 AND 100), state_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE facts (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, subject TEXT NOT NULL, predicate TEXT NOT NULL, value_json TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('player_stated', 'minecraft_observed', 'bot_inferred', 'system')), status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted')), dedupe_key TEXT NOT NULL, superseded_by_id TEXT, retraction_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX facts_player_subject_idx ON facts(player_id, subject, predicate, status)",
  "CREATE UNIQUE INDEX facts_active_dedupe_idx ON facts(player_id, dedupe_key) WHERE status = 'active'",
  "CREATE TABLE locations (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, name TEXT NOT NULL, purpose TEXT NOT NULL, dimension TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(player_id, name))",
  "CREATE INDEX locations_player_updated_idx ON locations(player_id, updated_at DESC)",
  "CREATE TABLE commitments (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, description TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')), outcome_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)",
  "CREATE INDEX commitments_player_status_idx ON commitments(player_id, status, updated_at DESC)",
  "CREATE TABLE episodes (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, summary TEXT NOT NULL, importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), source TEXT NOT NULL CHECK (source IN ('player_stated', 'minecraft_observed', 'bot_inferred', 'system')), details_json TEXT NOT NULL, observed_at TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX episodes_player_observed_idx ON episodes(player_id, observed_at DESC)",
  "CREATE TABLE task_runs (id TEXT PRIMARY KEY, player_id TEXT REFERENCES players(id) ON DELETE SET NULL, kind TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'suspended', 'completed', 'failed', 'cancelled')), phase TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, failure_json TEXT, checkpoint_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX task_runs_status_idx ON task_runs(status, updated_at DESC)",
  "CREATE TABLE task_checkpoints (id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, phase TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_run_id, sequence))",
  "CREATE INDEX task_checkpoints_run_idx ON task_checkpoints(task_run_id, sequence DESC)",
  "CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, memory_kind UNINDEXED, player_id UNINDEXED, content, recorded_at UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')",
].join(";\n");

const migrationV2 = [
  "CREATE TABLE life_states (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), current_interests_json TEXT NOT NULL, long_term_goals_json TEXT NOT NULL, home_base_json TEXT, possessions_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE world_memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('resource', 'hazard', 'structure')), name TEXT NOT NULL, description TEXT NOT NULL, dimension TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, source TEXT NOT NULL CHECK (source IN ('player_stated', 'minecraft_observed', 'bot_inferred', 'system')), status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted')), dedupe_key TEXT NOT NULL, superseded_by_id TEXT, retraction_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX world_memories_active_lookup_idx ON world_memories(kind, name, dimension, status)",
  "CREATE INDEX world_memories_status_updated_idx ON world_memories(status, updated_at DESC)",
  "CREATE UNIQUE INDEX world_memories_active_dedupe_idx ON world_memories(dedupe_key) WHERE status = 'active'",
].join(";\n");

/**
 * Structured long-term memory. There is deliberately no method or column for
 * raw chat transcripts; callers must provide small, typed facts and outcomes.
 */
export class MemoryStore {
  private constructor(private readonly database: Database.Database) {}

  public static open(path: string): MemoryStore {
    const database = new Database(path, { timeout: 5_000 });
    const store = new MemoryStore(database);
    try {
      store.configure();
      store.migrate();
      store.suspendInterruptedTasks();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  public close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }

  public getOrCreatePlayer(externalName: string): PlayerRecord {
    const name = text(externalName, "externalName", 80);
    const now = timestamp();
    return this.database.transaction(() => {
      const existing = this.database
        .prepare<[string], PlayerRow>(
          "SELECT id, external_name, created_at, updated_at FROM players WHERE external_name = ?",
        )
        .get(name);
      if (existing !== undefined) {
        this.database
          .prepare<[string, string]>(
            "UPDATE players SET updated_at = ? WHERE id = ?",
          )
          .run(now, existing.id);
        return player({ ...existing, updated_at: now });
      }

      const id = randomUUID();
      this.database
        .prepare<[string, string, string, string]>(
          "INSERT INTO players (id, external_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(id, name, now, now);
      this.database
        .prepare<[string, string, string]>(
          "INSERT INTO relationships (player_id, state_json, updated_at) VALUES (?, ?, ?)",
        )
        .run(id, "{}", now);
      return { id, externalName: name, createdAt: now, updatedAt: now };
    })();
  }

  public getRelationship(playerId: string): RelationshipRecord {
    this.requirePlayer(playerId);
    const row = this.database
      .prepare<[string], RelationshipRow>(
        "SELECT player_id, trust, intimacy, state_json, updated_at FROM relationships WHERE player_id = ?",
      )
      .get(playerId);
    if (row === undefined) {
      throw new MemoryStoreError(
        "Relationship is missing for player " + playerId + ".",
      );
    }
    return relationship(row);
  }

  public updateRelationship(input: {
    readonly playerId: string;
    readonly trust: number;
    readonly intimacy: number;
    readonly state: Readonly<Record<string, JsonValue>>;
  }): RelationshipRecord {
    this.requirePlayer(input.playerId);
    const trust = score(input.trust, "trust");
    const intimacy = score(input.intimacy, "intimacy");
    const stateJson = json(input.state, "relationship state");
    const now = timestamp();
    this.database
      .prepare<[number, number, string, string, string]>(
        "UPDATE relationships SET trust = ?, intimacy = ?, state_json = ?, updated_at = ? WHERE player_id = ?",
      )
      .run(trust, intimacy, stateJson, now, input.playerId);
    return {
      playerId: input.playerId,
      trust,
      intimacy,
      state: record(
        parseJson(stateJson, "relationship state"),
        "relationship state",
      ),
      updatedAt: now,
    };
  }

  public rememberPlayerFact(input: RememberPlayerFactInput): FactRecord {
    this.requirePlayer(input.playerId);
    const subject = text(input.subject, "fact subject", 240);
    const predicate = text(input.predicate, "fact predicate", 160);
    const source = factSource(input.source);
    const valueJson = json(input.value, "fact value");
    const value = parseJson(valueJson, "fact value");
    const dedupeKey = factDedupe(input.playerId, subject, predicate, valueJson);
    const now = timestamp();

    return this.database.transaction(() => {
      const duplicate = this.database
        .prepare<[string, string], FactRow>(
          "SELECT id, player_id, subject, predicate, value_json, source, status, dedupe_key, superseded_by_id, retraction_reason, created_at, updated_at FROM facts WHERE player_id = ? AND dedupe_key = ? AND status = 'active'",
        )
        .get(input.playerId, dedupeKey);
      if (duplicate !== undefined) {
        return fact(duplicate);
      }

      const old = this.database
        .prepare<[string, string, string], IdRow>(
          "SELECT id FROM facts WHERE player_id = ? AND subject = ? AND predicate = ? AND status = 'active'",
        )
        .all(input.playerId, subject, predicate);
      const id = randomUUID();
      this.database
        .prepare<
          [
            string,
            string,
            string,
            string,
            string,
            FactSource,
            string,
            string,
            string,
          ]
        >(
          "INSERT INTO facts (id, player_id, subject, predicate, value_json, source, status, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
        )
        .run(
          id,
          input.playerId,
          subject,
          predicate,
          valueJson,
          source,
          dedupeKey,
          now,
          now,
        );
      for (const prior of old) {
        this.database
          .prepare<[string, string, string]>(
            "UPDATE facts SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(id, now, prior.id);
        this.removeSearch(prior.id, "fact");
      }
      const saved: FactRecord = {
        id,
        playerId: input.playerId,
        subject,
        predicate,
        value,
        source,
        status: "active",
        dedupeKey,
        createdAt: now,
        updatedAt: now,
      };
      this.index(
        saved.id,
        "fact",
        saved.playerId,
        [subject, predicate, jsonText(value), source].join(" "),
        now,
      );
      return saved;
    })();
  }

  public supersedeFact(factId: string, supersededById?: string): FactRecord {
    const now = timestamp();
    return this.database.transaction(() => {
      const row = this.requireFact(factId);
      if (row.status !== "active") {
        return fact(row);
      }
      this.database
        .prepare<[string | null, string, string]>(
          "UPDATE facts SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(supersededById ?? null, now, factId);
      this.removeSearch(factId, "fact");
      return fact({
        ...row,
        status: "superseded",
        superseded_by_id: supersededById ?? null,
        updated_at: now,
      });
    })();
  }

  public retractFact(
    factId: string,
    reason = "retracted by an authorized update",
  ): FactRecord {
    const retractionReason = text(reason, "retraction reason", 300);
    const now = timestamp();
    return this.database.transaction(() => {
      const row = this.requireFact(factId);
      if (row.status === "retracted") {
        return fact(row);
      }
      this.database
        .prepare<[string, string, string]>(
          "UPDATE facts SET status = 'retracted', retraction_reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(retractionReason, now, factId);
      this.removeSearch(factId, "fact");
      return fact({
        ...row,
        status: "retracted",
        retraction_reason: retractionReason,
        updated_at: now,
      });
    })();
  }

  public rememberLocation(input: RememberLocationInput): LocationRecord {
    this.requirePlayer(input.playerId);
    const name = text(input.name, "location name", 160);
    const purpose = text(input.purpose, "location purpose", 500);
    const dimension = text(input.dimension, "location dimension", 120);
    const x = coordinate(input.x, "x");
    const y = coordinate(input.y, "y");
    const z = coordinate(input.z, "z");
    const now = timestamp();
    return this.database.transaction(() => {
      const existing = this.database
        .prepare<[string, string], LocationRow>(
          "SELECT id, player_id, name, purpose, dimension, x, y, z, created_at, updated_at FROM locations WHERE player_id = ? AND name = ?",
        )
        .get(input.playerId, name);
      const id = existing?.id ?? randomUUID();
      const createdAt = existing?.created_at ?? now;
      if (existing === undefined) {
        this.database
          .prepare<
            [
              string,
              string,
              string,
              string,
              string,
              number,
              number,
              number,
              string,
              string,
            ]
          >(
            "INSERT INTO locations (id, player_id, name, purpose, dimension, x, y, z, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(id, input.playerId, name, purpose, dimension, x, y, z, now, now);
      } else {
        this.database
          .prepare<[string, string, number, number, number, string, string]>(
            "UPDATE locations SET purpose = ?, dimension = ?, x = ?, y = ?, z = ?, updated_at = ? WHERE id = ?",
          )
          .run(purpose, dimension, x, y, z, now, id);
      }
      const saved: LocationRecord = {
        id,
        playerId: input.playerId,
        name,
        purpose,
        dimension,
        x,
        y,
        z,
        createdAt,
        updatedAt: now,
      };
      this.index(
        id,
        "location",
        input.playerId,
        [name, purpose, dimension, String(x), String(y), String(z)].join(" "),
        now,
      );
      return saved;
    })();
  }

  public setCommitment(input: SetCommitmentInput): CommitmentRecord {
    this.requirePlayer(input.playerId);
    const description = text(input.description, "commitment description", 800);
    const progress = stringList(
      input.progress ?? [],
      "commitment progress",
      30,
    );
    const blockers = stringList(
      input.blockers ?? [],
      "commitment blockers",
      30,
    );
    const stateJson = commitmentEnvelopeJson(progress, blockers);
    const now = timestamp();
    return this.database.transaction(() => {
      const duplicate = this.database
        .prepare<[string, string], CommitmentRow>(
          "SELECT id, player_id, description, status, outcome_json, created_at, updated_at, completed_at FROM commitments WHERE player_id = ? AND description = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
        )
        .get(input.playerId, description);
      if (duplicate !== undefined) {
        return commitment(duplicate);
      }
      const id = randomUUID();
      this.database
        .prepare<[string, string, string, string, string, string]>(
          "INSERT INTO commitments (id, player_id, description, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
        )
        .run(id, input.playerId, description, stateJson, now, now);
      const saved: CommitmentRecord = {
        id,
        playerId: input.playerId,
        description,
        status: "active",
        progress,
        blockers,
        createdAt: now,
        updatedAt: now,
      };
      this.index(
        id,
        "commitment",
        input.playerId,
        [description, "active", ...progress, ...blockers].join(" "),
        now,
      );
      return saved;
    })();
  }

  public completeCommitment(input: CompleteCommitmentInput): CommitmentRecord {
    const result = cleanJson(input.outcome, "commitment outcome");
    const verificationSource = commitmentVerificationSource(
      input.verificationSource,
    );
    const verificationEvidence = text(
      input.verificationEvidence,
      "commitment verification evidence",
      500,
    );
    const now = timestamp();
    return this.database.transaction(() => {
      const row = this.requireCommitment(input.commitmentId);
      if (row.player_id !== input.playerId) {
        throw new MemoryStoreError(
          "Commitment does not belong to the authorized player.",
        );
      }
      if (row.status === "completed") {
        return commitment(row);
      }
      const state = commitmentState(row);
      const outcomeJson = json(
        {
          progress: state.progress,
          blockers: [],
          result,
          verificationSource,
          verificationEvidence,
        },
        "commitment outcome",
      );
      this.database
        .prepare<[string, string, string, string]>(
          "UPDATE commitments SET status = 'completed', outcome_json = ?, completed_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(outcomeJson, now, now, input.commitmentId);
      const saved = commitment({
        ...row,
        status: "completed",
        outcome_json: outcomeJson,
        completed_at: now,
        updated_at: now,
      });
      this.index(
        saved.id,
        "commitment",
        saved.playerId,
        saved.description + " completed " + jsonText(saved.outcome ?? null),
        now,
      );
      return saved;
    })();
  }

  public updateCommitmentProgress(
    input: UpdateCommitmentProgressInput,
  ): CommitmentRecord {
    const progress = stringList(input.progress, "commitment progress", 30);
    const blockers = stringList(input.blockers, "commitment blockers", 30);
    const now = timestamp();
    return this.database.transaction(() => {
      const row = this.requireCommitment(input.commitmentId);
      if (row.status !== "active") {
        throw new MemoryStoreError(
          "Only an active commitment can update progress.",
        );
      }
      const stateJson = commitmentEnvelopeJson(progress, blockers);
      this.database
        .prepare<[string, string, string]>(
          "UPDATE commitments SET outcome_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(stateJson, now, input.commitmentId);
      const saved = commitment({
        ...row,
        outcome_json: stateJson,
        updated_at: now,
      });
      this.index(
        saved.id,
        "commitment",
        saved.playerId,
        [saved.description, "active", ...progress, ...blockers].join(" "),
        now,
      );
      return saved;
    })();
  }

  public listActiveCommitments(playerId: string): CommitmentRecord[] {
    this.requirePlayer(playerId);
    return this.database
      .prepare<[string], CommitmentRow>(
        "SELECT id, player_id, description, status, outcome_json, created_at, updated_at, completed_at FROM commitments WHERE player_id = ? AND status = 'active' ORDER BY updated_at DESC",
      )
      .all(playerId)
      .map(commitment);
  }

  public recordEpisode(input: RecordEpisodeInput): EpisodeRecord {
    this.requirePlayer(input.playerId);
    const summary = text(input.summary, "episode summary", 1_000);
    const importance = input.importance ?? 3;
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
      throw new MemoryStoreError(
        "Episode importance must be an integer from 1 through 5.",
      );
    }
    const source = factSource(input.source ?? "minecraft_observed");
    const detailsJson = json(input.details ?? {}, "episode details");
    const observedAt =
      input.observedAt === undefined
        ? timestamp()
        : isoTimestamp(input.observedAt);
    const createdAt = timestamp();
    const id = randomUUID();
    this.database
      .prepare<
        [string, string, string, number, FactSource, string, string, string]
      >(
        "INSERT INTO episodes (id, player_id, summary, importance, source, details_json, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.playerId,
        summary,
        importance,
        source,
        detailsJson,
        observedAt,
        createdAt,
      );
    const saved: EpisodeRecord = {
      id,
      playerId: input.playerId,
      summary,
      importance,
      source,
      details: record(
        parseJson(detailsJson, "episode details"),
        "episode details",
      ),
      observedAt,
      createdAt,
    };
    this.index(
      id,
      "episode",
      input.playerId,
      summary + " " + jsonText(saved.details),
      observedAt,
    );
    return saved;
  }

  public createTaskRun(input: CreateTaskRunInput): TaskRunRecord {
    if (input.playerId !== undefined) {
      this.requirePlayer(input.playerId);
    }
    const kind = text(input.kind, "task kind", 120);
    const status = taskStatus(input.status ?? "queued");
    const phase = text(input.phase ?? status, "task phase", 120);
    const inputJson = json(input.input, "task input");
    const now = timestamp();
    const id = randomUUID();
    this.database
      .prepare<
        [
          string,
          string | null,
          string,
          TaskRunStatus,
          string,
          string,
          string,
          string,
        ]
      >(
        "INSERT INTO task_runs (id, player_id, kind, status, phase, input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.playerId ?? null,
        kind,
        status,
        phase,
        inputJson,
        now,
        now,
      );
    return {
      id,
      ...(input.playerId === undefined ? {} : { playerId: input.playerId }),
      kind,
      status,
      phase,
      input: record(parseJson(inputJson, "task input"), "task input"),
      createdAt: now,
      updatedAt: now,
    };
  }

  public recordTaskCheckpoint(
    input: RecordTaskCheckpointInput,
  ): TaskCheckpoint {
    const phase = text(input.phase, "task checkpoint phase", 120);
    const data = record(
      parseJson(json(input.data, "task checkpoint"), "task checkpoint"),
      "task checkpoint",
    );
    return this.database.transaction(() => {
      this.requireTaskRun(input.taskRunId);
      const createdAt = timestamp();
      const checkpoint = this.insertCheckpoint(
        input.taskRunId,
        phase,
        data,
        createdAt,
      );
      this.database
        .prepare<[string, string, string]>(
          "UPDATE task_runs SET checkpoint_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(checkpointJsonValue(checkpoint), createdAt, input.taskRunId);
      return checkpoint;
    })();
  }

  public updateTaskRun(input: UpdateTaskRunInput): TaskRunRecord {
    const status = taskStatus(input.status);
    const phase = text(input.phase, "task phase", 120);
    const now = timestamp();
    return this.database.transaction(() => {
      const row = this.requireTaskRun(input.taskRunId);
      const outputJson =
        input.output === undefined
          ? row.output_json
          : json(input.output, "task output");
      const failureJson =
        input.failure === undefined ? row.failure_json : failure(input.failure);
      const checkpoint =
        input.checkpoint === undefined
          ? storedCheckpoint(row.checkpoint_json, input.taskRunId)
          : this.insertCheckpoint(
              input.taskRunId,
              phase,
              input.checkpoint,
              now,
            );
      const checkpointJson =
        checkpoint === undefined ? null : checkpointJsonValue(checkpoint);
      this.database
        .prepare<
          [
            TaskRunStatus,
            string,
            string | null,
            string | null,
            string | null,
            string,
            string,
          ]
        >(
          "UPDATE task_runs SET status = ?, phase = ?, output_json = ?, failure_json = ?, checkpoint_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          status,
          phase,
          outputJson,
          failureJson,
          checkpointJson,
          now,
          input.taskRunId,
        );
      return taskRun({
        ...row,
        status,
        phase,
        output_json: outputJson,
        failure_json: failureJson,
        checkpoint_json: checkpointJson,
        updated_at: now,
      });
    })();
  }

  public getTaskRun(taskRunId: string): TaskRunRecord {
    return taskRun(this.requireTaskRun(taskRunId));
  }

  public listRecentTaskRuns(
    playerId: string,
    limit = DEFAULT_RECALL_LIMIT,
  ): TaskRunRecord[] {
    this.requirePlayer(playerId);
    return this.database
      .prepare<[string, number], TaskRunRow>(
        "SELECT id, player_id, kind, status, phase, input_json, output_json, failure_json, checkpoint_json, created_at, updated_at FROM task_runs WHERE player_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(playerId, recallLimit(limit))
      .map(taskRun);
  }

  public suspendInterruptedTasks(): number {
    return this.database
      .prepare<[string]>(
        "UPDATE task_runs SET status = 'suspended', updated_at = ? WHERE status = 'running'",
      )
      .run(timestamp()).changes;
  }

  public recall(input: RecallInput): RecallItem[] {
    this.requirePlayer(input.playerId);
    const limit = recallLimit(input.limit);
    const acceptedKinds = kinds(input.kinds);
    const query = searchQuery(input.query, "Recall query");
    const candidates = Math.min(
      MAX_RECALL_LIMIT * 4,
      Math.max(DEFAULT_RECALL_LIMIT, limit * 4),
    );
    const rows =
      query.length === 0
        ? this.database
            .prepare<[string, number], SearchRow>(
              "SELECT memory_id, memory_kind, content, recorded_at FROM memory_fts WHERE player_id = ? ORDER BY recorded_at DESC LIMIT ?",
            )
            .all(input.playerId, candidates)
        : this.search(input.playerId, query, candidates);
    return rows
      .filter(
        (row) =>
          acceptedKinds === undefined ||
          acceptedKinds.has(memoryKind(row.memory_kind)),
      )
      .slice(0, limit)
      .map((row) => ({
        id: row.memory_id,
        kind: memoryKind(row.memory_kind),
        summary: row.content,
        recordedAt: row.recorded_at,
      }));
  }

  /**
   * Life state is companion-scoped rather than player-scoped.  Updating it
   * replaces the current state so callers always restore one coherent view.
   */
  public saveLifeState(input: SaveLifeStateInput): LifeStateRecord {
    const currentInterests = stringList(
      input.currentInterests,
      "life state current interests",
      24,
    );
    const longTermGoals = stringList(
      input.longTermGoals,
      "life state long-term goals",
      24,
    );
    const homeBase = lifeHomeBase(input.homeBase);
    const possessions = lifePossessions(input.possessions);
    const currentInterestsJson = json(
      currentInterests,
      "life state current interests",
    );
    const longTermGoalsJson = json(longTermGoals, "life state long-term goals");
    const homeBaseJson =
      homeBase === undefined
        ? null
        : json(
            {
              name: homeBase.name,
              dimension: homeBase.dimension,
              x: homeBase.x,
              y: homeBase.y,
              z: homeBase.z,
            },
            "life state home base",
          );
    const possessionsJson = json(
      possessions.map((possession) => ({
        name: possession.name,
        quantity: possession.quantity,
      })),
      "life state possessions",
    );
    const now = timestamp();

    return this.database.transaction(() => {
      const existing = this.database
        .prepare<[], LifeStateRow>(
          "SELECT current_interests_json, long_term_goals_json, home_base_json, possessions_json, created_at, updated_at FROM life_states WHERE singleton_id = 1",
        )
        .get();
      const createdAt = existing?.created_at ?? now;
      if (existing === undefined) {
        this.database
          .prepare<[string, string, string | null, string, string, string]>(
            "INSERT INTO life_states (singleton_id, current_interests_json, long_term_goals_json, home_base_json, possessions_json, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            currentInterestsJson,
            longTermGoalsJson,
            homeBaseJson,
            possessionsJson,
            now,
            now,
          );
      } else {
        this.database
          .prepare<[string, string, string | null, string, string]>(
            "UPDATE life_states SET current_interests_json = ?, long_term_goals_json = ?, home_base_json = ?, possessions_json = ?, updated_at = ? WHERE singleton_id = 1",
          )
          .run(
            currentInterestsJson,
            longTermGoalsJson,
            homeBaseJson,
            possessionsJson,
            now,
          );
      }
      const saved: LifeStateRecord = {
        currentInterests,
        longTermGoals,
        ...(homeBase === undefined ? {} : { homeBase }),
        possessions,
        createdAt,
        updatedAt: now,
      };
      this.index(
        LIFE_STATE_ID,
        "life_state",
        GLOBAL_MEMORY_OWNER,
        lifeStateSearchText(saved),
        now,
      );
      return saved;
    })();
  }

  public correctLifeState(input: SaveLifeStateInput): LifeStateRecord {
    return this.saveLifeState(input);
  }

  public getLifeState(): LifeStateRecord | undefined {
    const row = this.database
      .prepare<[], LifeStateRow>(
        "SELECT current_interests_json, long_term_goals_json, home_base_json, possessions_json, created_at, updated_at FROM life_states WHERE singleton_id = 1",
      )
      .get();
    return row === undefined ? undefined : lifeState(row);
  }

  public searchLifeState(query: string): LifeStateRecord | undefined {
    const life = this.getLifeState();
    if (life === undefined) {
      return undefined;
    }
    const normalized = searchQuery(query, "Life state search query");
    if (normalized.length === 0) {
      return life;
    }
    const rows = this.searchByKind(
      GLOBAL_MEMORY_OWNER,
      "life_state",
      normalized,
      1,
    );
    return rows.some(
      (row) =>
        row.memory_id === LIFE_STATE_ID && row.memory_kind === "life_state",
    )
      ? life
      : undefined;
  }

  public rememberWorldMemory(
    input: RememberWorldMemoryInput,
  ): WorldMemoryRecord {
    return this.database.transaction(() => this.persistWorldMemory(input))();
  }

  public correctWorldMemory(input: CorrectWorldMemoryInput): WorldMemoryRecord {
    return this.database.transaction(() => {
      const original = this.requireWorldMemory(input.worldMemoryId);
      if (original.status !== "active") {
        throw new MemoryStoreError(
          "Only an active world memory can be corrected.",
        );
      }
      return this.persistWorldMemory(input.replacement, original.id);
    })();
  }

  public getWorldMemory(worldMemoryId: string): WorldMemoryRecord {
    return worldMemory(this.requireWorldMemory(worldMemoryId));
  }

  public retractWorldMemory(
    worldMemoryId: string,
    reason = "retracted by an authorized update",
  ): WorldMemoryRecord {
    const retractionReason = text(
      reason,
      "world memory retraction reason",
      300,
    );
    const now = timestamp();
    return this.database.transaction(() => {
      const row = this.requireWorldMemory(worldMemoryId);
      if (row.status === "retracted") {
        return worldMemory(row);
      }
      this.database
        .prepare<[string, string, string]>(
          "UPDATE world_memories SET status = 'retracted', retraction_reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(retractionReason, now, worldMemoryId);
      this.removeSearch(worldMemoryId, "world_memory");
      return worldMemory({
        ...row,
        status: "retracted",
        retraction_reason: retractionReason,
        updated_at: now,
      });
    })();
  }

  public searchWorldMemories(
    input: SearchWorldMemoriesInput,
  ): WorldMemoryRecord[] {
    const query = searchQuery(input.query, "World memory search query");
    const limit = recallLimit(input.limit);
    const acceptedKinds = worldKinds(input.kinds);
    const candidates = Math.min(
      MAX_RECALL_LIMIT * 4,
      Math.max(DEFAULT_RECALL_LIMIT, limit * 4),
    );
    const rows =
      query.length === 0
        ? this.database
            .prepare<[number], WorldMemoryRow>(
              "SELECT id, kind, name, description, dimension, x, y, z, source, status, dedupe_key, superseded_by_id, retraction_reason, created_at, updated_at FROM world_memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?",
            )
            .all(candidates)
        : this.searchByKind(
            GLOBAL_MEMORY_OWNER,
            "world_memory",
            query,
            candidates,
          ).map((row) => this.requireWorldMemory(row.memory_id));
    return rows
      .filter((row) => row.status === "active")
      .filter(
        (row) =>
          acceptedKinds === undefined ||
          acceptedKinds.has(worldMemoryKind(row.kind)),
      )
      .slice(0, limit)
      .map(worldMemory);
  }

  private persistWorldMemory(
    input: RememberWorldMemoryInput,
    correctionOfId?: string,
  ): WorldMemoryRecord {
    const kind = worldMemoryKind(input.kind);
    const name = text(input.name, "world memory name", 160);
    const description = text(
      input.description,
      "world memory description",
      800,
    );
    const dimension = text(input.dimension, "world memory dimension", 120);
    const x = coordinate(input.x, "world memory x");
    const y = coordinate(input.y, "world memory y");
    const z = coordinate(input.z, "world memory z");
    const source = factSource(input.source);
    const dedupeKey = worldMemoryDedupe(
      kind,
      name,
      description,
      dimension,
      x,
      y,
      z,
      source,
    );
    const now = timestamp();
    const duplicate = this.database
      .prepare<[string], WorldMemoryRow>(
        "SELECT id, kind, name, description, dimension, x, y, z, source, status, dedupe_key, superseded_by_id, retraction_reason, created_at, updated_at FROM world_memories WHERE dedupe_key = ? AND status = 'active'",
      )
      .get(dedupeKey);
    if (duplicate !== undefined) {
      if (correctionOfId !== undefined && duplicate.id !== correctionOfId) {
        this.markWorldMemorySuperseded(correctionOfId, duplicate.id, now);
      }
      return worldMemory(duplicate);
    }

    const previous = this.database
      .prepare<[WorldMemoryKind, string, string], IdRow>(
        "SELECT id FROM world_memories WHERE kind = ? AND name = ? AND dimension = ? AND status = 'active'",
      )
      .all(kind, name, dimension);
    const previousIds = new Set(previous.map((row) => row.id));
    if (correctionOfId !== undefined) {
      previousIds.add(correctionOfId);
    }
    const id = randomUUID();
    this.database
      .prepare<
        [
          string,
          WorldMemoryKind,
          string,
          string,
          string,
          number,
          number,
          number,
          FactSource,
          string,
          string,
          string,
        ]
      >(
        "INSERT INTO world_memories (id, kind, name, description, dimension, x, y, z, source, status, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
      )
      .run(
        id,
        kind,
        name,
        description,
        dimension,
        x,
        y,
        z,
        source,
        dedupeKey,
        now,
        now,
      );
    for (const previousId of previousIds) {
      this.markWorldMemorySuperseded(previousId, id, now);
    }
    const saved: WorldMemoryRecord = {
      id,
      kind,
      name,
      description,
      dimension,
      x,
      y,
      z,
      source,
      status: "active",
      dedupeKey,
      createdAt: now,
      updatedAt: now,
    };
    this.index(
      id,
      "world_memory",
      GLOBAL_MEMORY_OWNER,
      worldMemorySearchText(saved),
      now,
    );
    return saved;
  }

  private markWorldMemorySuperseded(
    worldMemoryId: string,
    supersededById: string,
    updatedAt: string,
  ): void {
    this.database
      .prepare<[string, string, string]>(
        "UPDATE world_memories SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(supersededById, updatedAt, worldMemoryId);
    this.removeSearch(worldMemoryId, "world_memory");
  }

  private configure(): void {
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("busy_timeout = 5000");
  }

  private migrate(): void {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = this.database
      .prepare<[], VersionRow>("SELECT version FROM schema_migrations")
      .all();
    const appliedVersions = new Set(applied.map((row) => row.version));
    const latestApplied = applied.reduce(
      (latest, row) => Math.max(latest, row.version),
      0,
    );
    if (latestApplied > SCHEMA_VERSION) {
      throw new MemoryStoreError(
        "Database schema version is newer than this application.",
      );
    }
    const migrations: readonly {
      readonly version: number;
      readonly sql: string;
    }[] = [
      { version: 1, sql: migrationV1 },
      { version: 2, sql: migrationV2 },
    ];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      this.database.transaction(() => {
        this.database.exec(migration.sql);
        this.database
          .prepare<[number, string]>(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, timestamp());
      })();
    }
  }

  private requirePlayer(playerId: string): PlayerRow {
    const row = this.database
      .prepare<[string], PlayerRow>(
        "SELECT id, external_name, created_at, updated_at FROM players WHERE id = ?",
      )
      .get(playerId);
    if (row === undefined) {
      throw new MemoryStoreError("Unknown player id: " + playerId);
    }
    return row;
  }

  private requireFact(factId: string): FactRow {
    const row = this.database
      .prepare<[string], FactRow>(
        "SELECT id, player_id, subject, predicate, value_json, source, status, dedupe_key, superseded_by_id, retraction_reason, created_at, updated_at FROM facts WHERE id = ?",
      )
      .get(factId);
    if (row === undefined) {
      throw new MemoryStoreError("Unknown fact id: " + factId);
    }
    return row;
  }

  private requireCommitment(commitmentId: string): CommitmentRow {
    const row = this.database
      .prepare<[string], CommitmentRow>(
        "SELECT id, player_id, description, status, outcome_json, created_at, updated_at, completed_at FROM commitments WHERE id = ?",
      )
      .get(commitmentId);
    if (row === undefined) {
      throw new MemoryStoreError("Unknown commitment id: " + commitmentId);
    }
    return row;
  }

  private requireWorldMemory(worldMemoryId: string): WorldMemoryRow {
    const row = this.database
      .prepare<[string], WorldMemoryRow>(
        "SELECT id, kind, name, description, dimension, x, y, z, source, status, dedupe_key, superseded_by_id, retraction_reason, created_at, updated_at FROM world_memories WHERE id = ?",
      )
      .get(worldMemoryId);
    if (row === undefined) {
      throw new MemoryStoreError("Unknown world memory id: " + worldMemoryId);
    }
    return row;
  }

  private requireTaskRun(taskRunId: string): TaskRunRow {
    const row = this.database
      .prepare<[string], TaskRunRow>(
        "SELECT id, player_id, kind, status, phase, input_json, output_json, failure_json, checkpoint_json, created_at, updated_at FROM task_runs WHERE id = ?",
      )
      .get(taskRunId);
    if (row === undefined) {
      throw new MemoryStoreError("Unknown task run id: " + taskRunId);
    }
    return row;
  }

  private insertCheckpoint(
    taskRunId: string,
    phase: string,
    data: Readonly<Record<string, JsonValue>>,
    createdAt: string,
  ): TaskCheckpoint {
    const sequence = this.database
      .prepare<[string], SequenceRow>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM task_checkpoints WHERE task_run_id = ?",
      )
      .get(taskRunId)?.next_sequence;
    if (sequence === undefined) {
      throw new MemoryStoreError(
        "Could not allocate a task checkpoint sequence.",
      );
    }
    const id = randomUUID();
    const dataJson = json(data, "task checkpoint");
    this.database
      .prepare<[string, string, number, string, string, string]>(
        "INSERT INTO task_checkpoints (id, task_run_id, sequence, phase, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, taskRunId, sequence, phase, dataJson, createdAt);
    return {
      id,
      taskRunId,
      sequence,
      phase,
      data: record(parseJson(dataJson, "task checkpoint"), "task checkpoint"),
      createdAt,
    };
  }

  private index(
    id: string,
    kind: MemoryKind,
    playerId: string,
    content: string,
    recordedAt: string,
  ): void {
    this.removeSearch(id, kind);
    this.database
      .prepare<[string, MemoryKind, string, string, string]>(
        "INSERT INTO memory_fts (memory_id, memory_kind, player_id, content, recorded_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        id,
        kind,
        playerId,
        text(content, "memory search content", MAX_JSON_BYTES),
        recordedAt,
      );
  }

  private removeSearch(id: string, kind: MemoryKind): void {
    this.database
      .prepare<[string, MemoryKind]>(
        "DELETE FROM memory_fts WHERE memory_id = ? AND memory_kind = ?",
      )
      .run(id, kind);
  }

  private search(playerId: string, query: string, limit: number): SearchRow[] {
    try {
      const matches = this.database
        .prepare<[string, string, number], SearchRow>(
          "SELECT memory_id, memory_kind, content, recorded_at FROM memory_fts WHERE memory_fts MATCH ? AND player_id = ? ORDER BY bm25(memory_fts), recorded_at DESC LIMIT ?",
        )
        .all(ftsQuery(query), playerId, limit);
      return matches.length > 0
        ? matches
        : this.fallbackSearch(playerId, undefined, query, limit);
    } catch {
      return this.fallbackSearch(playerId, undefined, query, limit);
    }
  }

  private searchByKind(
    playerId: string,
    kind: MemoryKind,
    query: string,
    limit: number,
  ): SearchRow[] {
    try {
      const matches = this.database
        .prepare<[string, string, MemoryKind, number], SearchRow>(
          "SELECT memory_id, memory_kind, content, recorded_at FROM memory_fts WHERE memory_fts MATCH ? AND player_id = ? AND memory_kind = ? ORDER BY bm25(memory_fts), recorded_at DESC LIMIT ?",
        )
        .all(ftsQuery(query), playerId, kind, limit);
      return matches.length > 0
        ? matches
        : this.fallbackSearch(playerId, kind, query, limit);
    } catch {
      return this.fallbackSearch(playerId, kind, query, limit);
    }
  }

  private fallbackSearch(
    playerId: string,
    kind: MemoryKind | undefined,
    query: string,
    limit: number,
  ): SearchRow[] {
    const candidates =
      kind === undefined
        ? this.database
            .prepare<[string, number], SearchRow>(
              "SELECT memory_id, memory_kind, content, recorded_at FROM memory_fts WHERE player_id = ? ORDER BY recorded_at DESC LIMIT ?",
            )
            .all(playerId, MAX_RECALL_LIMIT * 4)
        : this.database
            .prepare<[string, MemoryKind, number], SearchRow>(
              "SELECT memory_id, memory_kind, content, recorded_at FROM memory_fts WHERE player_id = ? AND memory_kind = ? ORDER BY recorded_at DESC LIMIT ?",
            )
            .all(playerId, kind, MAX_RECALL_LIMIT * 4);
    return candidates
      .map((row) => ({ row, score: relevanceScore(query, row.content) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.row.recorded_at.localeCompare(left.row.recorded_at),
      )
      .slice(0, limit)
      .map(({ row }) => row);
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function text(value: string, label: string, max: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > max) {
    throw new MemoryStoreError(
      label + " must contain between 1 and " + String(max) + " characters.",
    );
  }
  if (SECRET_LABEL.test(normalized) || SECRET_VALUE.test(normalized)) {
    throw new MemoryStoreError(
      label + " appears to contain a secret and cannot be persisted.",
    );
  }
  return normalized;
}

function coordinate(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new MemoryStoreError("Coordinate " + label + " must be finite.");
  }
  return value;
}

function score(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new MemoryStoreError(
      label + " must be an integer from 0 through 100.",
    );
  }
  return value;
}

function isoTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new MemoryStoreError("Timestamp must be ISO-8601.");
  }
  return new Date(parsed).toISOString();
}

function recallLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RECALL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_LIMIT) {
    throw new MemoryStoreError(
      "Recall limit must be an integer from 1 through " +
        String(MAX_RECALL_LIMIT) +
        ".",
    );
  }
  return limit;
}

function searchQuery(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new MemoryStoreError(label + " must be a string.");
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new MemoryStoreError(label + " is too long.");
  }
  return normalized;
}

function kinds(
  value: readonly MemoryKind[] | undefined,
): ReadonlySet<MemoryKind> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = new Set<MemoryKind>();
  for (const item of value) {
    result.add(memoryKind(item));
  }
  return result;
}

function worldKinds(
  value: readonly WorldMemoryKind[] | undefined,
): ReadonlySet<WorldMemoryKind> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = new Set<WorldMemoryKind>();
  for (const item of value) {
    result.add(worldMemoryKind(item));
  }
  return result;
}

function factSource(value: string): FactSource {
  if (!factSources.includes(value as FactSource)) {
    throw new MemoryStoreError("Unsupported fact source: " + value);
  }
  return value as FactSource;
}

function factStatus(value: string): FactStatus {
  if (!factStatuses.includes(value as FactStatus)) {
    throw new MemoryStoreError("Unsupported persisted fact status: " + value);
  }
  return value as FactStatus;
}

function commitmentStatus(value: string): CommitmentStatus {
  if (!commitmentStatuses.includes(value as CommitmentStatus)) {
    throw new MemoryStoreError(
      "Unsupported persisted commitment status: " + value,
    );
  }
  return value as CommitmentStatus;
}

function commitmentVerificationSource(
  value: string,
): "owner_confirmation" | "verified_tool_result" {
  if (value !== "owner_confirmation" && value !== "verified_tool_result") {
    throw new MemoryStoreError(
      "Unsupported commitment verification source: " + value,
    );
  }
  return value;
}

function taskStatus(value: string): TaskRunStatus {
  if (!taskRunStatuses.includes(value as TaskRunStatus)) {
    throw new MemoryStoreError("Unsupported task status: " + value);
  }
  return value as TaskRunStatus;
}

function memoryKind(value: string): MemoryKind {
  if (!memoryKinds.includes(value as MemoryKind)) {
    throw new MemoryStoreError("Unsupported persisted memory kind: " + value);
  }
  return value as MemoryKind;
}

function worldMemoryKind(value: string): WorldMemoryKind {
  if (!worldMemoryKinds.includes(value as WorldMemoryKind)) {
    throw new MemoryStoreError("Unsupported world memory kind: " + value);
  }
  return value as WorldMemoryKind;
}

function worldMemoryStatus(value: string): WorldMemoryStatus {
  if (!worldMemoryStatuses.includes(value as WorldMemoryStatus)) {
    throw new MemoryStoreError(
      "Unsupported persisted world memory status: " + value,
    );
  }
  return value as WorldMemoryStatus;
}

function stringList(
  value: readonly string[],
  label: string,
  maxItems: number,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new MemoryStoreError(label + " must be an array.");
  }
  if (value.length > maxItems) {
    throw new MemoryStoreError(label + " contains too many items.");
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new MemoryStoreError(
        label + " item " + String(index + 1) + " must be a string.",
      );
    }
    return text(item, label + " item", 300);
  });
}

function lifeHomeBase(value: unknown): LifeHomeBase | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isUnknownRecord(value)) {
    throw new MemoryStoreError("Life state home base must be an object.");
  }
  const name = value.name;
  const dimension = value.dimension;
  const x = value.x;
  const y = value.y;
  const z = value.z;
  if (
    typeof name !== "string" ||
    typeof dimension !== "string" ||
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number"
  ) {
    throw new MemoryStoreError("Life state home base has an invalid shape.");
  }
  return {
    name: text(name, "life state home base name", 160),
    dimension: text(dimension, "life state home base dimension", 120),
    x: coordinate(x, "life state home base x"),
    y: coordinate(y, "life state home base y"),
    z: coordinate(z, "life state home base z"),
  };
}

function lifePossessions(value: unknown): readonly LifePossession[] {
  if (!Array.isArray(value)) {
    throw new MemoryStoreError("Life state possessions must be an array.");
  }
  if (value.length > 100) {
    throw new MemoryStoreError(
      "Life state possessions contains too many items.",
    );
  }
  return value.map((item, index) => {
    if (!isUnknownRecord(item)) {
      throw new MemoryStoreError(
        "Life state possession " + String(index + 1) + " must be an object.",
      );
    }
    const quantity = item.quantity;
    const name = item.name;
    if (
      typeof name !== "string" ||
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 0 ||
      quantity > 1_000_000
    ) {
      throw new MemoryStoreError(
        "Life state possession quantity must be an integer from 0 through 1000000.",
      );
    }
    return {
      name: text(name, "life state possession name", 160),
      quantity,
    };
  });
}

function json(value: JsonValue, label: string): string {
  const serialized = JSON.stringify(cleanJson(value, label));
  if (serialized.length > MAX_JSON_BYTES) {
    throw new MemoryStoreError(
      label + " exceeds " + String(MAX_JSON_BYTES) + " bytes.",
    );
  }
  return serialized;
}

function cleanJson(value: JsonValue, label: string): JsonValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MemoryStoreError(label + " contains a non-finite number.");
    }
    return value;
  }
  if (typeof value === "string") {
    return text(value, label, MAX_TEXT_LENGTH);
  }
  if (isJsonArray(value)) {
    if (value.length > 100) {
      throw new MemoryStoreError(label + " contains too many array items.");
    }
    return value.map((item) => cleanJson(item, label));
  }
  const result: Record<string, JsonValue> = {};
  const entries = Object.entries(value);
  if (entries.length > 100) {
    throw new MemoryStoreError(label + " contains too many object properties.");
  }
  for (const [key, item] of entries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const safeKey = text(key, label + " key", 120);
    if (SECRET_LABEL.test(safeKey)) {
      throw new MemoryStoreError(
        label + " contains a sensitive property name.",
      );
    }
    result[safeKey] = cleanJson(item, label);
  }
  return result;
}

function parseJson(value: string, label: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsedJson(parsed, label);
  } catch (error) {
    if (error instanceof MemoryStoreError) {
      throw error;
    }
    throw new MemoryStoreError("Persisted " + label + " is invalid JSON.");
  }
}

function parsedJson(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MemoryStoreError(
        "Persisted " + label + " contains a non-finite number.",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => parsedJson(item, label));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = parsedJson(item, label);
    }
    return result;
  }
  throw new MemoryStoreError("Persisted " + label + " is not JSON-shaped.");
}

function record(
  value: JsonValue,
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (!isJsonObject(value)) {
    throw new MemoryStoreError(label + " must be a JSON object.");
  }
  return value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !isJsonArray(value);
}

function isUnknownRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function factDedupe(
  playerId: string,
  subject: string,
  predicate: string,
  valueJson: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        playerId,
        subject.toLowerCase(),
        predicate.toLowerCase(),
        valueJson,
      ]),
    )
    .digest("hex");
}

function worldMemoryDedupe(
  kind: WorldMemoryKind,
  name: string,
  description: string,
  dimension: string,
  x: number,
  y: number,
  z: number,
  source: FactSource,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        name.toLowerCase(),
        description.toLowerCase(),
        dimension.toLowerCase(),
        x,
        y,
        z,
        source,
      ]),
    )
    .digest("hex");
}

function jsonText(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (isJsonArray(value)) {
    return value.map(jsonText).join(" ");
  }
  return Object.entries(value)
    .flatMap(([key, item]) => [key, jsonText(item)])
    .join(" ");
}

function ftsQuery(query: string): string {
  const terms = query
    .split(/\s+/u)
    .map((term) => term.replace(/["'()*:^~\\]/gu, ""))
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    throw new MemoryStoreError("Recall query has no searchable terms.");
  }
  return terms
    .map((term) => '"' + term.replace(/"/gu, '""') + '"')
    .join(" AND ");
}

function relevanceScore(query: string, content: string): number {
  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedContent = content.toLocaleLowerCase();
  let score = normalizedContent.includes(normalizedQuery) ? 100 : 0;
  const contentTerms = new Set(
    normalizedContent
      .split(/[^\p{L}\p{N}_:-]+/u)
      .filter((term) => term.length > 0),
  );
  const queryTerms = new Set(
    normalizedQuery
      .split(/[^\p{L}\p{N}_:-]+/u)
      .filter((term) => term.length > 0),
  );
  for (const term of contentTerms) {
    const matches = /^[a-z0-9_:-]+$/u.test(term)
      ? queryTerms.has(term)
      : normalizedQuery.includes(term);
    if (matches) score += Math.min(term.length, 20);
  }
  for (const term of normalizedQuery.split(/\s+/u)) {
    if (term.length > 0 && normalizedContent.includes(term)) {
      score += Math.min(term.length, 20);
    }
  }
  return score;
}

function failure(value: StoredFailure): string {
  const state =
    value.confirmedState === undefined
      ? undefined
      : record(
          parseJson(
            json(value.confirmedState, "failure confirmed state"),
            "failure confirmed state",
          ),
          "failure confirmed state",
        );
  return json(
    {
      category: text(value.category, "failure category", 80),
      code: text(value.code, "failure code", 120),
      message: text(value.message, "failure message", MAX_TEXT_LENGTH),
      retryable: value.retryable,
      ...(state === undefined ? {} : { confirmedState: state }),
    },
    "task failure",
  );
}

function readFailure(value: string | null): StoredFailure | undefined {
  if (value === null) {
    return undefined;
  }
  const saved = record(parseJson(value, "task failure"), "task failure");
  const category = saved.category;
  const code = saved.code;
  const message = saved.message;
  const retryable = saved.retryable;
  if (
    typeof category !== "string" ||
    typeof code !== "string" ||
    typeof message !== "string" ||
    typeof retryable !== "boolean"
  ) {
    throw new MemoryStoreError("Persisted task failure has an invalid shape.");
  }
  const confirmedState = saved.confirmedState;
  return {
    category,
    code,
    message,
    retryable,
    ...(confirmedState === undefined
      ? {}
      : { confirmedState: record(confirmedState, "failure confirmed state") }),
  };
}

function checkpointJsonValue(checkpoint: TaskCheckpoint): string {
  return json(
    {
      id: checkpoint.id,
      sequence: checkpoint.sequence,
      phase: checkpoint.phase,
      data: checkpoint.data,
      createdAt: checkpoint.createdAt,
    },
    "task checkpoint",
  );
}

function storedCheckpoint(
  value: string | null,
  taskRunId: string,
): TaskCheckpoint | undefined {
  if (value === null) {
    return undefined;
  }
  const saved = record(parseJson(value, "task checkpoint"), "task checkpoint");
  const id = saved.id;
  const sequence = saved.sequence;
  const phase = saved.phase;
  const data = saved.data;
  const createdAt = saved.createdAt;
  if (
    typeof id !== "string" ||
    typeof sequence !== "number" ||
    typeof phase !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw new MemoryStoreError(
      "Persisted task checkpoint has an invalid shape.",
    );
  }
  return {
    id,
    taskRunId,
    sequence,
    phase,
    data: record(data ?? null, "task checkpoint data"),
    createdAt,
  };
}

function storedStringList(
  value: string,
  label: string,
  maxItems: number,
): readonly string[] {
  const parsed = parseJson(value, label);
  if (!isJsonArray(parsed)) {
    throw new MemoryStoreError("Persisted " + label + " must be an array.");
  }
  if (parsed.length > maxItems) {
    throw new MemoryStoreError(
      "Persisted " + label + " contains too many items.",
    );
  }
  return parsed.map((item, index) => {
    if (typeof item !== "string") {
      throw new MemoryStoreError(
        "Persisted " +
          label +
          " item " +
          String(index + 1) +
          " must be a string.",
      );
    }
    return text(item, "persisted " + label + " item", 300);
  });
}

function storedLifeHomeBase(value: string): LifeHomeBase {
  const saved = record(
    parseJson(value, "life state home base"),
    "life state home base",
  );
  const name = saved.name;
  const dimension = saved.dimension;
  const x = saved.x;
  const y = saved.y;
  const z = saved.z;
  if (
    typeof name !== "string" ||
    typeof dimension !== "string" ||
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number"
  ) {
    throw new MemoryStoreError(
      "Persisted life state home base has an invalid shape.",
    );
  }
  return {
    name: text(name, "persisted life state home base name", 160),
    dimension: text(dimension, "persisted life state home base dimension", 120),
    x: coordinate(x, "persisted life state home base x"),
    y: coordinate(y, "persisted life state home base y"),
    z: coordinate(z, "persisted life state home base z"),
  };
}

function storedLifePossessions(value: string): readonly LifePossession[] {
  const parsed = parseJson(value, "life state possessions");
  if (!isJsonArray(parsed)) {
    throw new MemoryStoreError(
      "Persisted life state possessions must be an array.",
    );
  }
  if (parsed.length > 100) {
    throw new MemoryStoreError(
      "Persisted life state possessions contains too many items.",
    );
  }
  return parsed.map((item, index) => {
    const possession = record(item, "persisted life state possession");
    const name = possession.name;
    const quantity = possession.quantity;
    if (
      typeof name !== "string" ||
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 0 ||
      quantity > 1_000_000
    ) {
      throw new MemoryStoreError(
        "Persisted life state possession " +
          String(index + 1) +
          " has an invalid shape.",
      );
    }
    return {
      name: text(name, "persisted life state possession name", 160),
      quantity,
    };
  });
}

function lifeState(row: LifeStateRow): LifeStateRecord {
  return {
    currentInterests: storedStringList(
      row.current_interests_json,
      "life state current interests",
      24,
    ),
    longTermGoals: storedStringList(
      row.long_term_goals_json,
      "life state long-term goals",
      24,
    ),
    ...(row.home_base_json === null
      ? {}
      : { homeBase: storedLifeHomeBase(row.home_base_json) }),
    possessions: storedLifePossessions(row.possessions_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lifeStateSearchText(value: LifeStateRecord): string {
  const homeBase =
    value.homeBase === undefined
      ? []
      : [
          value.homeBase.name,
          value.homeBase.dimension,
          String(value.homeBase.x),
          String(value.homeBase.y),
          String(value.homeBase.z),
        ];
  return [
    ...value.currentInterests,
    ...value.longTermGoals,
    ...homeBase,
    ...value.possessions.flatMap((possession) => [
      possession.name,
      String(possession.quantity),
    ]),
  ].join(" ");
}

function worldMemorySearchText(value: WorldMemoryRecord): string {
  return [
    value.kind,
    value.name,
    value.description,
    value.dimension,
    String(value.x),
    String(value.y),
    String(value.z),
    value.source,
  ].join(" ");
}

function player(row: PlayerRow): PlayerRecord {
  return {
    id: row.id,
    externalName: row.external_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function relationship(row: RelationshipRow): RelationshipRecord {
  return {
    playerId: row.player_id,
    trust: row.trust,
    intimacy: row.intimacy,
    state: record(
      parseJson(row.state_json, "relationship state"),
      "relationship state",
    ),
    updatedAt: row.updated_at,
  };
}

function fact(row: FactRow): FactRecord {
  return {
    id: row.id,
    playerId: row.player_id,
    subject: row.subject,
    predicate: row.predicate,
    value: parseJson(row.value_json, "fact value"),
    source: factSource(row.source),
    status: factStatus(row.status),
    dedupeKey: row.dedupe_key,
    ...(row.superseded_by_id === null
      ? {}
      : { supersededById: row.superseded_by_id }),
    ...(row.retraction_reason === null
      ? {}
      : { retractionReason: row.retraction_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commitment(row: CommitmentRow): CommitmentRecord {
  const state = commitmentState(row);
  return {
    id: row.id,
    playerId: row.player_id,
    description: row.description,
    status: commitmentStatus(row.status),
    progress: state.progress,
    blockers: state.blockers,
    ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
    ...(state.completionVerification === undefined
      ? {}
      : { completionVerification: state.completionVerification }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function commitmentEnvelopeJson(
  progress: readonly string[],
  blockers: readonly string[],
): string {
  return json({ progress, blockers }, "commitment state");
}

function commitmentState(row: CommitmentRow): {
  readonly progress: readonly string[];
  readonly blockers: readonly string[];
  readonly outcome?: JsonValue;
  readonly completionVerification?: {
    readonly source: "owner_confirmation" | "verified_tool_result";
    readonly evidence: string;
  };
} {
  if (row.outcome_json === null) {
    return { progress: [], blockers: [] };
  }
  const parsed = parseJson(row.outcome_json, "commitment state");
  if (
    isJsonObject(parsed) &&
    parsed.progress !== undefined &&
    parsed.blockers !== undefined
  ) {
    const progress = commitmentStringList(
      parsed.progress,
      "persisted commitment progress",
    );
    const blockers = commitmentStringList(
      parsed.blockers,
      "persisted commitment blockers",
    );
    return {
      progress,
      blockers,
      ...(row.status === "completed" && parsed.result !== undefined
        ? { outcome: parsed.result }
        : {}),
      ...(row.status === "completed" &&
      (parsed.verificationSource === "owner_confirmation" ||
        parsed.verificationSource === "verified_tool_result") &&
      typeof parsed.verificationEvidence === "string"
        ? {
            completionVerification: {
              source: parsed.verificationSource,
              evidence: text(
                parsed.verificationEvidence,
                "persisted commitment verification evidence",
                500,
              ),
            },
          }
        : {}),
    };
  }
  return row.status === "completed"
    ? { progress: [], blockers: [], outcome: parsed }
    : { progress: [], blockers: [] };
}

function commitmentStringList(
  value: JsonValue | undefined,
  label: string,
): readonly string[] {
  if (value === undefined || !isJsonArray(value)) {
    throw new MemoryStoreError(label + " must be an array.");
  }
  if (value.length > 30) {
    throw new MemoryStoreError(label + " contains too many items.");
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new MemoryStoreError(
        label + " item " + String(index + 1) + " must be a string.",
      );
    }
    return text(item, label + " item", 300);
  });
}

function worldMemory(row: WorldMemoryRow): WorldMemoryRecord {
  return {
    id: row.id,
    kind: worldMemoryKind(row.kind),
    name: row.name,
    description: row.description,
    dimension: row.dimension,
    x: coordinate(row.x, "persisted world memory x"),
    y: coordinate(row.y, "persisted world memory y"),
    z: coordinate(row.z, "persisted world memory z"),
    source: factSource(row.source),
    status: worldMemoryStatus(row.status),
    dedupeKey: row.dedupe_key,
    ...(row.superseded_by_id === null
      ? {}
      : { supersededById: row.superseded_by_id }),
    ...(row.retraction_reason === null
      ? {}
      : { retractionReason: row.retraction_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRun(row: TaskRunRow): TaskRunRecord {
  const checkpoint = storedCheckpoint(row.checkpoint_json, row.id);
  const parsedFailure = readFailure(row.failure_json);
  return {
    id: row.id,
    ...(row.player_id === null ? {} : { playerId: row.player_id }),
    kind: row.kind,
    status: taskStatus(row.status),
    phase: row.phase,
    input: record(parseJson(row.input_json, "task input"), "task input"),
    ...(row.output_json === null
      ? {}
      : { output: parseJson(row.output_json, "task output") }),
    ...(parsedFailure === undefined ? {} : { failure: parsedFailure }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
