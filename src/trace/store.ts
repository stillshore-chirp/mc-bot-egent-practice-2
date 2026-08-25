import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import {
  cognitiveTraceBundleSchema,
  cognitiveTraceEventSchema,
  cognitiveTraceLinkSchema,
  cognitiveTraceResultSchema,
  cognitiveTraceRunSchema,
  cognitiveTraceSpanSchema,
  TRACE_SCHEMA_VERSION,
  type CognitiveTraceBundle,
  type CognitiveTraceDetail,
  type CognitiveTraceEvent,
  type CognitiveTraceLink,
  type CognitiveTraceResult,
  type CognitiveTraceRun,
  type CognitiveTraceSpan,
} from "./contracts.js";
import {
  createPresenterRedactionManifest,
  presenterSafeEvent,
  sanitizeTraceText,
} from "./redaction.js";

const TRACE_STORE_SCHEMA_VERSION = 1;
const MAX_LIST_LIMIT = 200;
const MAX_STREAM_BACKFILL = 2_000;

const migrationV1 = [
  "CREATE TABLE trace_runs (trace_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, root_span_id TEXT NOT NULL, status TEXT NOT NULL, request_summary TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, last_sequence INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0, demo_safe INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL CHECK (source IN ('live', 'recorded')))",
  "CREATE INDEX trace_runs_started_idx ON trace_runs(started_at DESC)",
  "CREATE INDEX trace_runs_status_idx ON trace_runs(status, started_at DESC)",
  "CREATE TABLE trace_spans (trace_id TEXT NOT NULL REFERENCES trace_runs(trace_id) ON DELETE CASCADE, span_id TEXT NOT NULL, parent_span_id TEXT, sequence INTEGER NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, ended_at TEXT, span_json TEXT NOT NULL, PRIMARY KEY(trace_id, span_id))",
  "CREATE INDEX trace_spans_trace_sequence_idx ON trace_spans(trace_id, sequence)",
  "CREATE TABLE trace_events (stream_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, trace_id TEXT NOT NULL REFERENCES trace_runs(trace_id) ON DELETE CASCADE, span_id TEXT NOT NULL, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, type TEXT NOT NULL, event_json TEXT NOT NULL, UNIQUE(trace_id, sequence))",
  "CREATE INDEX trace_events_trace_sequence_idx ON trace_events(trace_id, sequence)",
  "CREATE INDEX trace_events_stream_idx ON trace_events(stream_id)",
  "CREATE TABLE trace_links (trace_id TEXT NOT NULL REFERENCES trace_runs(trace_id) ON DELETE CASCADE, source_span_id TEXT NOT NULL, target_span_id TEXT NOT NULL, type TEXT NOT NULL, link_json TEXT NOT NULL, PRIMARY KEY(trace_id, source_span_id, target_span_id, type))",
  "CREATE TABLE trace_results (trace_id TEXT NOT NULL REFERENCES trace_runs(trace_id) ON DELETE CASCADE, span_id TEXT NOT NULL, result_id TEXT NOT NULL, kind TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(trace_id, result_id))",
  "CREATE INDEX trace_results_span_idx ON trace_results(trace_id, span_id)",
  "CREATE TABLE trace_redaction_manifests (trace_id TEXT PRIMARY KEY REFERENCES trace_runs(trace_id) ON DELETE CASCADE, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL)",
].join(";\n");

interface TraceRunRow {
  readonly trace_id: string;
  readonly schema_version: number;
  readonly root_span_id: string;
  readonly status: string;
  readonly request_summary: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly last_sequence: number;
  readonly event_count: number;
  readonly demo_safe: number;
  readonly source: string;
}

interface EventRow {
  readonly stream_id: number;
  readonly event_json: string;
}

interface JsonRow {
  readonly value_json: string;
}

interface VersionRow {
  readonly version: number;
}

interface CountRow {
  readonly count: number;
}

export class TraceStoreError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TraceStoreError";
  }
}

export class TraceStore {
  private constructor(private readonly database: Database.Database) {}

  public static open(databasePath: string): TraceStore {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    const store = new TraceStore(database);
    store.migrate();
    return store;
  }

  public close(): void {
    this.database.close();
  }

  public createTrace(run: CognitiveTraceRun): void {
    const parsed = cognitiveTraceRunSchema.parse(run);
    if (parsed.schemaVersion !== TRACE_SCHEMA_VERSION) {
      throw new TraceStoreError(
        "TRACE_SCHEMA_UNSUPPORTED",
        "The trace schema version is not supported",
      );
    }
    this.database
      .prepare(
        "INSERT INTO trace_runs (trace_id, schema_version, root_span_id, status, request_summary, started_at, ended_at, last_sequence, event_count, demo_safe, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        parsed.traceId,
        parsed.schemaVersion,
        parsed.rootSpanId,
        parsed.status,
        sanitizeTraceText(parsed.requestSummary),
        parsed.startedAt,
        parsed.endedAt ?? null,
        parsed.lastSequence,
        parsed.eventCount,
        parsed.demoSafe ? 1 : 0,
        parsed.source,
      );
  }

  public persistEvent(event: CognitiveTraceEvent): CognitiveTraceEvent {
    const parsed = cognitiveTraceEventSchema.parse(event);
    return this.database.transaction(() =>
      this.persistValidatedEvent(parsed),
    )();
  }

  public listTraces(limit = 50): readonly CognitiveTraceRun[] {
    const boundedLimit = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
    const rows = this.database
      .prepare<[number], TraceRunRow>(
        "SELECT trace_id, schema_version, root_span_id, status, request_summary, started_at, ended_at, last_sequence, event_count, demo_safe, source FROM trace_runs ORDER BY started_at DESC LIMIT ?",
      )
      .all(boundedLimit);
    return rows.map(toTraceRun);
  }

  public getTrace(traceId: string): CognitiveTraceDetail | undefined {
    const row = this.getTraceRow(traceId);
    if (row === undefined) return undefined;
    const spans = this.database
      .prepare<[string], JsonRow>(
        "SELECT span_json AS value_json FROM trace_spans WHERE trace_id = ? ORDER BY sequence",
      )
      .all(traceId)
      .map(({ value_json }) =>
        cognitiveTraceSpanSchema.parse(parseJson(value_json)),
      );
    const links = this.database
      .prepare<[string], JsonRow>(
        "SELECT link_json AS value_json FROM trace_links WHERE trace_id = ? ORDER BY rowid",
      )
      .all(traceId)
      .map(({ value_json }) =>
        cognitiveTraceLinkSchema.parse(parseJson(value_json)),
      );
    const results = this.database
      .prepare<[string], JsonRow>(
        "SELECT result_json AS value_json FROM trace_results WHERE trace_id = ? ORDER BY rowid",
      )
      .all(traceId)
      .map(({ value_json }) =>
        cognitiveTraceResultSchema.parse(parseJson(value_json)),
      );
    return { run: toTraceRun(row), spans, links, results };
  }

  public getSpan(
    spanId: string,
  ):
    | { readonly traceId: string; readonly span: CognitiveTraceSpan }
    | undefined {
    const row = this.database
      .prepare<
        [string],
        { readonly trace_id: string; readonly span_json: string }
      >(
        "SELECT trace_id, span_json FROM trace_spans WHERE span_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(spanId);
    return row === undefined
      ? undefined
      : {
          traceId: row.trace_id,
          span: cognitiveTraceSpanSchema.parse(parseJson(row.span_json)),
        };
  }

  public listEvents(
    traceId: string,
    afterSequence = 0,
    limit = 2_000,
  ): readonly CognitiveTraceEvent[] {
    const boundedLimit = Math.min(Math.max(1, limit), MAX_STREAM_BACKFILL);
    return this.database
      .prepare<[string, number, number], EventRow>(
        "SELECT stream_id, event_json FROM trace_events WHERE trace_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(traceId, Math.max(0, afterSequence), boundedLimit)
      .map(toTraceEvent);
  }

  public listStreamEventsAfter(
    streamId: number,
    limit = MAX_STREAM_BACKFILL,
  ): readonly CognitiveTraceEvent[] {
    const boundedLimit = Math.min(Math.max(1, limit), MAX_STREAM_BACKFILL);
    return this.database
      .prepare<[number, number], EventRow>(
        "SELECT stream_id, event_json FROM trace_events WHERE stream_id > ? ORDER BY stream_id LIMIT ?",
      )
      .all(Math.max(0, streamId), boundedLimit)
      .map(toTraceEvent);
  }

  public markDemoSafe(traceId: string): CognitiveTraceBundle {
    const events = this.listAllEvents(traceId).map(presenterSafeEvent);
    const runRow = this.getTraceRow(traceId);
    if (runRow === undefined) {
      throw new TraceStoreError("TRACE_NOT_FOUND", "The trace was not found");
    }
    if (
      runRow.ended_at === null ||
      !["succeeded", "failed", "cancelled"].includes(runRow.status)
    ) {
      throw new TraceStoreError(
        "TRACE_NOT_COMPLETE",
        "Only completed real traces can be marked demo-safe",
      );
    }
    if (events.length !== runRow.event_count) {
      throw new TraceStoreError(
        "TRACE_EXPORT_INCOMPLETE",
        "The persisted trace event count does not match",
      );
    }
    const manifest = createPresenterRedactionManifest();
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE trace_runs SET demo_safe = 1 WHERE trace_id = ?")
        .run(traceId);
      this.database
        .prepare(
          "INSERT INTO trace_redaction_manifests (trace_id, manifest_json, created_at) VALUES (?, ?, ?) ON CONFLICT(trace_id) DO UPDATE SET manifest_json = excluded.manifest_json, created_at = excluded.created_at",
        )
        .run(traceId, JSON.stringify(manifest), manifest.generatedAt);
    })();
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      kind: "recorded-real-trace",
      exportedAt: new Date().toISOString(),
      trace: { ...toTraceRun(runRow), demoSafe: true },
      events,
      redaction: manifest,
    };
  }

  public exportDemoBundle(traceId: string): CognitiveTraceBundle {
    const run = this.getTraceRow(traceId);
    if (run === undefined) {
      throw new TraceStoreError("TRACE_NOT_FOUND", "The trace was not found");
    }
    if (run.demo_safe !== 1) {
      throw new TraceStoreError(
        "TRACE_NOT_DEMO_SAFE",
        "The trace has not passed presenter redaction",
      );
    }
    const manifestRow = this.database
      .prepare<[string], { readonly manifest_json: string }>(
        "SELECT manifest_json FROM trace_redaction_manifests WHERE trace_id = ?",
      )
      .get(traceId);
    if (manifestRow === undefined) {
      throw new TraceStoreError(
        "TRACE_REDACTION_MANIFEST_MISSING",
        "The trace redaction manifest is missing",
      );
    }
    return cognitiveTraceBundleSchema.parse({
      schemaVersion: TRACE_SCHEMA_VERSION,
      kind: "recorded-real-trace",
      exportedAt: new Date().toISOString(),
      trace: toTraceRun(run),
      events: this.listAllEvents(traceId).map(presenterSafeEvent),
      redaction: parseJson(manifestRow.manifest_json),
    });
  }

  public importDemoBundle(input: unknown): CognitiveTraceRun {
    const bundle = cognitiveTraceBundleSchema.parse(input);
    if (!bundle.trace.demoSafe) {
      throw new TraceStoreError(
        "TRACE_IMPORT_NOT_DEMO_SAFE",
        "Only redacted demo-safe traces can be imported",
      );
    }
    const ordered = [...bundle.events]
      .sort((a, b) => a.sequence - b.sequence)
      .map(presenterSafeEvent);
    const run: CognitiveTraceRun = {
      ...bundle.trace,
      status: "queued",
      endedAt: undefined,
      lastSequence: 0,
      eventCount: 0,
      source: "recorded",
    };
    const manifest = createPresenterRedactionManifest();
    this.database.transaction(() => {
      this.createTrace(run);
      for (const original of ordered) {
        const { streamId: _streamId, ...event } = original;
        this.persistValidatedEvent(event);
      }
      this.database
        .prepare(
          "INSERT INTO trace_redaction_manifests (trace_id, manifest_json, created_at) VALUES (?, ?, ?)",
        )
        .run(run.traceId, JSON.stringify(manifest), manifest.generatedAt);
    })();
    const imported = this.getTraceRow(run.traceId);
    if (imported === undefined) {
      throw new TraceStoreError(
        "TRACE_IMPORT_FAILED",
        "The imported trace could not be read",
      );
    }
    return toTraceRun(imported);
  }

  public enforceRetention(input: {
    readonly maxAgeDays: number;
    readonly maxTraces: number;
  }): number {
    const maxAgeDays = Math.max(1, Math.trunc(input.maxAgeDays));
    const maxTraces = Math.max(1, Math.trunc(input.maxTraces));
    const cutoff = new Date(
      Date.now() - maxAgeDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    return this.database.transaction(() => {
      const expired = this.database
        .prepare(
          "DELETE FROM trace_runs WHERE demo_safe = 0 AND started_at < ?",
        )
        .run(cutoff).changes;
      const overflow = this.database
        .prepare(
          "DELETE FROM trace_runs WHERE demo_safe = 0 AND trace_id IN (SELECT trace_id FROM trace_runs WHERE demo_safe = 0 ORDER BY started_at DESC LIMIT -1 OFFSET ?)",
        )
        .run(maxTraces).changes;
      return expired + overflow;
    })();
  }

  public countEvents(): number {
    return (
      this.database
        .prepare<[], CountRow>("SELECT COUNT(*) AS count FROM trace_events")
        .get()?.count ?? 0
    );
  }

  private persistValidatedEvent(
    event: CognitiveTraceEvent,
  ): CognitiveTraceEvent {
    validateEventPayload(event);
    if (event.schemaVersion !== TRACE_SCHEMA_VERSION) {
      throw new TraceStoreError(
        "TRACE_SCHEMA_UNSUPPORTED",
        "The trace event schema version is not supported",
      );
    }
    const existing = this.database
      .prepare<[string], EventRow>(
        "SELECT stream_id, event_json FROM trace_events WHERE event_id = ?",
      )
      .get(event.eventId);
    if (existing !== undefined) {
      const persisted = toTraceEvent(existing);
      if (
        JSON.stringify(withoutStreamId(persisted)) !==
        JSON.stringify(withoutStreamId(event))
      ) {
        throw new TraceStoreError(
          "TRACE_EVENT_ID_CONFLICT",
          "The trace event identifier was reused with different content",
        );
      }
      return persisted;
    }

    const run = this.getTraceRow(event.traceId);
    if (run === undefined) {
      throw new TraceStoreError(
        "TRACE_NOT_FOUND",
        "The trace event references an unknown trace",
      );
    }
    if (run.ended_at !== null) {
      throw new TraceStoreError(
        "TRACE_ALREADY_COMPLETE",
        "Completed traces cannot accept more events",
      );
    }
    const expectedSequence = run.last_sequence + 1;
    if (event.sequence !== expectedSequence) {
      throw new TraceStoreError(
        "TRACE_SEQUENCE_GAP",
        `Expected trace sequence ${String(expectedSequence)}`,
      );
    }
    if (
      event.type === "trace.completed" &&
      (event.spanId !== run.root_span_id ||
        event.span?.spanId !== run.root_span_id)
    ) {
      throw new TraceStoreError(
        "TRACE_COMPLETION_ROOT_MISMATCH",
        "Trace completion must reference the persisted root span",
      );
    }

    const insert = this.database
      .prepare(
        "INSERT INTO trace_events (event_id, trace_id, span_id, sequence, timestamp, type, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventId,
        event.traceId,
        event.spanId,
        event.sequence,
        event.timestamp,
        event.type,
        JSON.stringify(event),
      );
    const streamId = Number(insert.lastInsertRowid);
    const persisted = cognitiveTraceEventSchema.parse({ ...event, streamId });
    this.database
      .prepare("UPDATE trace_events SET event_json = ? WHERE stream_id = ?")
      .run(JSON.stringify(persisted), streamId);

    if (persisted.span !== undefined) this.upsertSpan(persisted.span);
    if (persisted.link !== undefined)
      this.insertLink(persisted.traceId, persisted.link);
    if (persisted.result !== undefined)
      this.insertResult(persisted.traceId, persisted.spanId, persisted.result);

    const completed = persisted.type === "trace.completed";
    const rootStatus = completed
      ? (persisted.span?.status ?? run.status)
      : persisted.spanId === run.root_span_id &&
          (persisted.type === "span.queued" ||
            persisted.type === "span.started" ||
            persisted.type === "span.waiting")
        ? (persisted.span?.status ?? run.status)
        : run.status;
    this.database
      .prepare(
        "UPDATE trace_runs SET status = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END, last_sequence = ?, event_count = event_count + 1 WHERE trace_id = ?",
      )
      .run(
        rootStatus,
        completed ? 1 : 0,
        completed ? persisted.timestamp : null,
        persisted.sequence,
        persisted.traceId,
      );
    return persisted;
  }

  private upsertSpan(span: CognitiveTraceSpan): void {
    this.database
      .prepare(
        "INSERT INTO trace_spans (trace_id, span_id, parent_span_id, sequence, stage, status, started_at, ended_at, span_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trace_id, span_id) DO UPDATE SET parent_span_id = excluded.parent_span_id, sequence = excluded.sequence, stage = excluded.stage, status = excluded.status, started_at = excluded.started_at, ended_at = excluded.ended_at, span_json = excluded.span_json",
      )
      .run(
        span.traceId,
        span.spanId,
        span.parentSpanId ?? null,
        span.sequence,
        span.stage,
        span.status,
        span.startedAt ?? null,
        span.endedAt ?? null,
        JSON.stringify(span),
      );
  }

  private insertLink(traceId: string, link: CognitiveTraceLink): void {
    const spanCount =
      this.database
        .prepare<[string, string, string], CountRow>(
          "SELECT COUNT(*) AS count FROM trace_spans WHERE trace_id = ? AND span_id IN (?, ?)",
        )
        .get(traceId, link.sourceSpanId, link.targetSpanId)?.count ?? 0;
    const expectedCount = link.sourceSpanId === link.targetSpanId ? 1 : 2;
    if (spanCount !== expectedCount) {
      throw new TraceStoreError(
        "TRACE_LINK_SPAN_NOT_FOUND",
        "Trace links must reference persisted spans in the same trace",
      );
    }
    this.database
      .prepare(
        "INSERT OR IGNORE INTO trace_links (trace_id, source_span_id, target_span_id, type, link_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        traceId,
        link.sourceSpanId,
        link.targetSpanId,
        link.type,
        JSON.stringify(link),
      );
  }

  private insertResult(
    traceId: string,
    spanId: string,
    result: CognitiveTraceResult,
  ): void {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO trace_results (trace_id, span_id, result_id, kind, result_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        traceId,
        spanId,
        result.resultId,
        result.kind,
        JSON.stringify(result),
      );
  }

  private listAllEvents(traceId: string): readonly CognitiveTraceEvent[] {
    return this.database
      .prepare<[string], EventRow>(
        "SELECT stream_id, event_json FROM trace_events WHERE trace_id = ? ORDER BY sequence",
      )
      .all(traceId)
      .map(toTraceEvent);
  }

  private getTraceRow(traceId: string): TraceRunRow | undefined {
    return this.database
      .prepare<[string], TraceRunRow>(
        "SELECT trace_id, schema_version, root_span_id, status, request_summary, started_at, ended_at, last_sequence, event_count, demo_safe, source FROM trace_runs WHERE trace_id = ?",
      )
      .get(traceId);
  }

  private migrate(): void {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS trace_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      this.database
        .prepare<[], VersionRow>(
          "SELECT version FROM trace_schema_migrations ORDER BY version",
        )
        .all()
        .map(({ version }) => version),
    );
    if (!applied.has(TRACE_STORE_SCHEMA_VERSION)) {
      this.database.transaction(() => {
        this.database.exec(migrationV1);
        this.database
          .prepare(
            "INSERT INTO trace_schema_migrations (version, applied_at) VALUES (?, ?)",
          )
          .run(TRACE_STORE_SCHEMA_VERSION, new Date().toISOString());
      })();
    }
  }
}

function validateEventPayload(event: CognitiveTraceEvent): void {
  const isSpanEvent = event.type.startsWith("span.");
  if (isSpanEvent && event.span === undefined) {
    throw new TraceStoreError(
      "TRACE_SPAN_PAYLOAD_MISSING",
      "Span events require a span snapshot",
    );
  }
  if (event.type === "link.created" && event.link === undefined) {
    throw new TraceStoreError(
      "TRACE_LINK_PAYLOAD_MISSING",
      "Link events require a link payload",
    );
  }
  if (event.type === "result.created" && event.result === undefined) {
    throw new TraceStoreError(
      "TRACE_RESULT_PAYLOAD_MISSING",
      "Result events require a result payload",
    );
  }
  if (event.type === "trace.completed" && event.span === undefined) {
    throw new TraceStoreError(
      "TRACE_COMPLETION_PAYLOAD_MISSING",
      "Trace completion requires the root span snapshot",
    );
  }
}

function toTraceRun(row: TraceRunRow): CognitiveTraceRun {
  return cognitiveTraceRunSchema.parse({
    schemaVersion: row.schema_version,
    traceId: row.trace_id,
    rootSpanId: row.root_span_id,
    status: row.status,
    requestSummary: row.request_summary,
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    lastSequence: row.last_sequence,
    eventCount: row.event_count,
    demoSafe: row.demo_safe === 1,
    source: row.source,
  });
}

function toTraceEvent(row: EventRow): CognitiveTraceEvent {
  return cognitiveTraceEventSchema.parse({
    ...(parseJson(row.event_json) as CognitiveTraceEvent),
    streamId: row.stream_id,
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new TraceStoreError(
      "TRACE_STORED_JSON_INVALID",
      "Persisted trace data is invalid",
    );
  }
}

function withoutStreamId(
  event: CognitiveTraceEvent,
): Omit<CognitiveTraceEvent, "streamId"> {
  const { streamId: _streamId, ...rest } = event;
  return rest;
}
