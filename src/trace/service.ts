import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { Logger } from "pino";

import {
  TRACE_SCHEMA_VERSION,
  type CognitiveStage,
  type CognitiveTraceEvent,
  type CognitiveTraceRun,
  type CognitiveTraceSpan,
  type TraceLinkType,
  type TraceMetrics,
  type TraceResultKind,
  type TraceSensitivity,
  type TraceStatus,
} from "./contracts.js";
import { sanitizeTraceAttributes, sanitizeTraceText } from "./redaction.js";
import { TraceStoreError, type TraceStore } from "./store.js";

interface TraceContext {
  readonly session: TraceSession;
  readonly parentSpanId: string;
}

export interface TraceHealth {
  readonly state: "ok" | "degraded";
  readonly lastErrorCode?: string | undefined;
  readonly lastPersistedAt?: string | undefined;
  readonly active: boolean;
  readonly subscriberCount: number;
}

export interface TraceSpanOptions {
  readonly summary?: string | undefined;
  readonly decisionSummary?: string | undefined;
  readonly expectedResult?: string | undefined;
  readonly sensitivity?: TraceSensitivity | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface TraceCompletion {
  readonly summary?: string | undefined;
  readonly actualResult?: string | undefined;
  readonly verificationResult?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly metrics?: TraceMetrics | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface WithSpanOptions<T> extends TraceSpanOptions {
  readonly resultKind?: TraceResultKind | undefined;
  readonly summarizeResult?: ((result: T) => string | undefined) | undefined;
  readonly verifyResult?: ((result: T) => string | undefined) | undefined;
  readonly metrics?:
    ((result: T, durationMs: number) => TraceMetrics) | undefined;
}

type TraceListener = (event: CognitiveTraceEvent) => void;

export class TraceService {
  readonly #context = new AsyncLocalStorage<TraceContext>();
  readonly #listeners = new Set<TraceListener>();
  readonly #store: TraceStore;
  readonly #logger: Logger;
  #activeSession: TraceSession | undefined;
  #lastErrorCode: string | undefined;
  #lastPersistedAt: string | undefined;

  public constructor(store: TraceStore, logger: Logger) {
    this.#store = store;
    this.#logger = logger;
  }

  public get store(): TraceStore {
    return this.#store;
  }

  public get health(): TraceHealth {
    return {
      state: this.#lastErrorCode === undefined ? "ok" : "degraded",
      ...(this.#lastErrorCode === undefined
        ? {}
        : { lastErrorCode: this.#lastErrorCode }),
      ...(this.#lastPersistedAt === undefined
        ? {}
        : { lastPersistedAt: this.#lastPersistedAt }),
      active: this.#activeSession !== undefined,
      subscriberCount: this.#listeners.size,
    };
  }

  public subscribe(listener: TraceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async startTrace(
    requestSummary: string,
    options: {
      readonly source?: "live" | "recorded";
      readonly attributes?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<TraceSession> {
    const traceId = randomUUID();
    const rootSpanId = randomUUID();
    const startedAt = new Date().toISOString();
    const run: CognitiveTraceRun = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId,
      rootSpanId,
      status: "queued",
      requestSummary: sanitizeTraceText(requestSummary),
      startedAt,
      lastSequence: 0,
      eventCount: 0,
      demoSafe: false,
      source: options.source ?? "live",
    };
    let persisted = true;
    try {
      this.#store.createTrace(run);
    } catch (error) {
      persisted = false;
      this.recordFailure(error, "TRACE_CREATE_FAILED");
    }
    const session = new TraceSession(this, run, persisted);
    this.#activeSession = session;
    await session.startRoot(options.attributes);
    return session;
  }

  public async withTrace<T>(
    session: TraceSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#context.run(
      { session, parentSpanId: session.rootSpanId },
      operation,
    );
  }

  public async withActiveTrace<T>(operation: () => Promise<T>): Promise<T> {
    const active = this.#activeSession;
    return active === undefined
      ? operation()
      : this.withTrace(active, operation);
  }

  public currentSession(): TraceSession | undefined {
    return this.#context.getStore()?.session;
  }

  public async startSpan(
    stage: CognitiveStage,
    name: string,
    options: TraceSpanOptions = {},
  ): Promise<ActiveTraceSpan | undefined> {
    const context = this.#context.getStore();
    if (context === undefined) return undefined;
    return context.session.startSpan(
      stage,
      name,
      context.parentSpanId,
      options,
    );
  }

  public async withSpan<T>(
    stage: CognitiveStage,
    name: string,
    options: WithSpanOptions<T>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const context = this.#context.getStore();
    if (context === undefined) return operation();
    const span = await context.session.startSpan(
      stage,
      name,
      context.parentSpanId,
      options,
    );
    const started = performance.now();
    return this.#context.run(
      { session: context.session, parentSpanId: span.spanId },
      async () => {
        try {
          const result = await operation();
          const durationMs = Math.max(0, performance.now() - started);
          const actualResult = options.summarizeResult?.(result);
          const verificationResult = options.verifyResult?.(result);
          await span.succeed({
            ...(actualResult === undefined ? {} : { actualResult }),
            ...(verificationResult === undefined ? {} : { verificationResult }),
            metrics:
              options.metrics?.(result, durationMs) ??
              ({ durationMs } satisfies TraceMetrics),
          });
          if (options.resultKind !== undefined && actualResult !== undefined) {
            await span.result(
              options.resultKind,
              actualResult,
              verificationResult,
            );
          }
          return result;
        } catch (error) {
          await span.fail({
            summary: "処理を完了できませんでした",
            errorCode:
              error instanceof TraceStoreError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "UNKNOWN_ERROR",
            metrics: { durationMs: Math.max(0, performance.now() - started) },
          });
          throw error;
        }
      },
    );
  }

  public async persistAndPublish(
    session: TraceSession,
    event: CognitiveTraceEvent,
  ): Promise<CognitiveTraceEvent | undefined> {
    if (!session.persisted) return undefined;
    try {
      const persisted = this.#store.persistEvent(event);
      this.#lastPersistedAt = persisted.timestamp;
      this.#lastErrorCode = undefined;
      for (const listener of this.#listeners) {
        try {
          listener(persisted);
        } catch (error) {
          this.#logger.warn(
            {
              category: "observability",
              code: "TRACE_SUBSCRIBER_FAILED",
              errorType: error instanceof Error ? error.name : "UnknownError",
            },
            "trace subscriber failed",
          );
        }
      }
      return persisted;
    } catch (error) {
      session.disablePersistence();
      this.recordFailure(error, "TRACE_PERSIST_FAILED");
      return undefined;
    }
  }

  public release(session: TraceSession): void {
    if (this.#activeSession === session) this.#activeSession = undefined;
  }

  private recordFailure(error: unknown, fallbackCode: string): void {
    const code = error instanceof TraceStoreError ? error.code : fallbackCode;
    this.#lastErrorCode = code;
    this.#logger.error(
      {
        category: "observability",
        code,
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
      "trace observability degraded",
    );
  }
}

export class TraceSession {
  readonly #service: TraceService;
  readonly #spans = new Map<string, CognitiveTraceSpan>();
  readonly #startedAt: string;
  readonly traceId: string;
  readonly rootSpanId: string;
  #sequence = 0;
  #persisted: boolean;
  #completed = false;

  public constructor(
    service: TraceService,
    run: CognitiveTraceRun,
    persisted: boolean,
  ) {
    this.#service = service;
    this.traceId = run.traceId;
    this.rootSpanId = run.rootSpanId;
    this.#startedAt = run.startedAt;
    this.#persisted = persisted;
  }

  public get persisted(): boolean {
    return this.#persisted;
  }

  public disablePersistence(): void {
    this.#persisted = false;
  }

  public async startRoot(
    attributes?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const queued = this.createSpan(
      this.rootSpanId,
      "request",
      "利用者依頼",
      undefined,
      {
        summary: "利用者から依頼を受信",
        sensitivity: "internal",
        attributes,
      },
    );
    this.#spans.set(this.rootSpanId, queued);
    await this.emitSpan("span.queued", queued);
    const running = {
      ...queued,
      status: "running" as const,
      startedAt: this.#startedAt,
    };
    this.#spans.set(this.rootSpanId, running);
    await this.emitSpan("span.started", running);
  }

  public async startSpan(
    stage: CognitiveStage,
    name: string,
    parentSpanId = this.rootSpanId,
    options: TraceSpanOptions = {},
  ): Promise<ActiveTraceSpan> {
    this.ensureOpen();
    const spanId = randomUUID();
    const queued = this.createSpan(spanId, stage, name, parentSpanId, options);
    this.#spans.set(spanId, queued);
    await this.emitSpan("span.queued", queued);
    const running: CognitiveTraceSpan = {
      ...queued,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.#spans.set(spanId, running);
    await this.emitSpan("span.started", running);
    await this.link("parent", parentSpanId, spanId);
    return new ActiveTraceSpan(this, spanId);
  }

  public async progress(
    spanId: string,
    progress: number,
    summary?: string,
    attributes?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.ensureOpen();
    const span = this.requireSpan(spanId);
    const updated: CognitiveTraceSpan = {
      ...span,
      status: "running",
      ...(summary === undefined ? {} : { summary: sanitizeTraceText(summary) }),
      ...(sanitizeTraceAttributes(attributes) === undefined
        ? {}
        : { attributes: sanitizeTraceAttributes(attributes) }),
    };
    this.#spans.set(spanId, updated);
    await this.emit({
      type: "span.progress",
      spanId,
      span: updated,
      progress: Math.min(1, Math.max(0, progress)),
      ...(summary === undefined ? {} : { summary }),
      ...(attributes === undefined ? {} : { attributes }),
    });
  }

  public async wait(
    spanId: string,
    summary: string,
    attributes?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.ensureOpen();
    const span = this.requireSpan(spanId);
    const updated: CognitiveTraceSpan = {
      ...span,
      status: "waiting",
      summary: sanitizeTraceText(summary),
      ...(sanitizeTraceAttributes(attributes) === undefined
        ? {}
        : { attributes: sanitizeTraceAttributes(attributes) }),
    };
    this.#spans.set(spanId, updated);
    await this.emit({
      type: "span.waiting",
      spanId,
      span: updated,
      summary,
      ...(attributes === undefined ? {} : { attributes }),
    });
  }

  public async finishSpan(
    spanId: string,
    status: Extract<
      TraceStatus,
      "succeeded" | "failed" | "cancelled" | "skipped"
    >,
    completion: TraceCompletion = {},
  ): Promise<void> {
    this.ensureOpen();
    const span = this.requireSpan(spanId);
    const updated: CognitiveTraceSpan = {
      ...span,
      status,
      endedAt: new Date().toISOString(),
      ...(completion.summary === undefined
        ? {}
        : { summary: sanitizeTraceText(completion.summary) }),
      ...(completion.actualResult === undefined
        ? {}
        : { actualResult: sanitizeTraceText(completion.actualResult) }),
      ...(completion.verificationResult === undefined
        ? {}
        : {
            verificationResult: sanitizeTraceText(
              completion.verificationResult,
            ),
          }),
      ...(completion.errorCode === undefined
        ? {}
        : { errorCode: completion.errorCode.slice(0, 160) }),
      ...(completion.metrics === undefined
        ? {}
        : { metrics: completion.metrics }),
      ...(sanitizeTraceAttributes(completion.attributes) === undefined
        ? {}
        : { attributes: sanitizeTraceAttributes(completion.attributes) }),
    };
    this.#spans.set(spanId, updated);
    const eventType = {
      succeeded: "span.succeeded",
      failed: "span.failed",
      cancelled: "span.cancelled",
      skipped: "span.skipped",
    } as const;
    await this.emit({
      type: eventType[status],
      spanId,
      span: updated,
      ...(completion.summary === undefined
        ? {}
        : { summary: completion.summary }),
      ...(completion.attributes === undefined
        ? {}
        : { attributes: completion.attributes }),
    });
  }

  public async link(
    type: TraceLinkType,
    sourceSpanId: string,
    targetSpanId: string,
  ): Promise<void> {
    this.ensureOpen();
    await this.emit({
      type: "link.created",
      spanId: sourceSpanId,
      link: { type, sourceSpanId, targetSpanId },
    });
  }

  public async result(
    spanId: string,
    kind: TraceResultKind,
    summary: string,
    verificationSummary?: string,
    sensitivity: TraceSensitivity = "internal",
  ): Promise<void> {
    this.ensureOpen();
    await this.emit({
      type: "result.created",
      spanId,
      result: {
        resultId: randomUUID(),
        spanId,
        kind,
        summary: sanitizeTraceText(summary),
        ...(verificationSummary === undefined
          ? {}
          : { verificationSummary: sanitizeTraceText(verificationSummary) }),
        sensitivity,
      },
    });
  }

  public async complete(
    status: Extract<TraceStatus, "succeeded" | "failed" | "cancelled">,
    completion: TraceCompletion = {},
  ): Promise<void> {
    if (this.#completed) return;
    await this.finishSpan(this.rootSpanId, status, completion);
    const root = this.requireSpan(this.rootSpanId);
    await this.emit({
      type: "trace.completed",
      spanId: this.rootSpanId,
      span: root,
      ...(completion.summary === undefined
        ? {}
        : { summary: completion.summary }),
    });
    this.#completed = true;
    this.#service.release(this);
  }

  private createSpan(
    spanId: string,
    stage: CognitiveStage,
    name: string,
    parentSpanId: string | undefined,
    options: TraceSpanOptions,
  ): CognitiveTraceSpan {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: this.traceId,
      spanId,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      sequence: this.#sequence + 1,
      stage,
      name: name.slice(0, 160),
      status: "queued",
      ...(options.summary === undefined
        ? {}
        : { summary: sanitizeTraceText(options.summary) }),
      ...(options.decisionSummary === undefined
        ? {}
        : { decisionSummary: sanitizeTraceText(options.decisionSummary) }),
      ...(options.expectedResult === undefined
        ? {}
        : { expectedResult: sanitizeTraceText(options.expectedResult) }),
      ...(sanitizeTraceAttributes(options.attributes) === undefined
        ? {}
        : { attributes: sanitizeTraceAttributes(options.attributes) }),
      sensitivity: options.sensitivity ?? "internal",
    };
  }

  private requireSpan(spanId: string): CognitiveTraceSpan {
    const span = this.#spans.get(spanId);
    if (span === undefined) {
      throw new Error("TRACE_SPAN_NOT_FOUND");
    }
    return span;
  }

  private ensureOpen(): void {
    if (this.#completed) {
      throw new TraceStoreError(
        "TRACE_ALREADY_COMPLETE",
        "Completed trace sessions cannot accept more events",
      );
    }
  }

  private async emitSpan(
    type: "span.queued" | "span.started",
    span: CognitiveTraceSpan,
  ): Promise<void> {
    await this.emit({ type, spanId: span.spanId, span });
  }

  private async emit(input: {
    readonly type: CognitiveTraceEvent["type"];
    readonly spanId: string;
    readonly summary?: string;
    readonly progress?: number;
    readonly span?: CognitiveTraceSpan;
    readonly link?: CognitiveTraceEvent["link"];
    readonly result?: CognitiveTraceEvent["result"];
    readonly attributes?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    this.#sequence += 1;
    const attributes = sanitizeTraceAttributes(input.attributes);
    await this.#service.persistAndPublish(this, {
      schemaVersion: TRACE_SCHEMA_VERSION,
      eventId: randomUUID(),
      traceId: this.traceId,
      spanId: input.spanId,
      sequence: this.#sequence,
      timestamp: new Date().toISOString(),
      type: input.type,
      ...(input.summary === undefined
        ? {}
        : { summary: sanitizeTraceText(input.summary) }),
      ...(input.progress === undefined ? {} : { progress: input.progress }),
      ...(input.span === undefined ? {} : { span: input.span }),
      ...(input.link === undefined ? {} : { link: input.link }),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(attributes === undefined ? {} : { attributes }),
    });
  }
}

export class ActiveTraceSpan {
  public constructor(
    private readonly session: TraceSession,
    public readonly spanId: string,
  ) {}

  public progress(
    progress: number,
    summary?: string,
    attributes?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.session.progress(this.spanId, progress, summary, attributes);
  }

  public wait(
    summary: string,
    attributes?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.session.wait(this.spanId, summary, attributes);
  }

  public succeed(completion: TraceCompletion = {}): Promise<void> {
    return this.session.finishSpan(this.spanId, "succeeded", completion);
  }

  public fail(completion: TraceCompletion = {}): Promise<void> {
    return this.session.finishSpan(this.spanId, "failed", completion);
  }

  public cancel(completion: TraceCompletion = {}): Promise<void> {
    return this.session.finishSpan(this.spanId, "cancelled", completion);
  }

  public skip(completion: TraceCompletion = {}): Promise<void> {
    return this.session.finishSpan(this.spanId, "skipped", completion);
  }

  public result(
    kind: TraceResultKind,
    summary: string,
    verificationSummary?: string,
    sensitivity?: TraceSensitivity,
  ): Promise<void> {
    return this.session.result(
      this.spanId,
      kind,
      summary,
      verificationSummary,
      sensitivity,
    );
  }

  public link(type: TraceLinkType, targetSpanId: string): Promise<void> {
    return this.session.link(type, this.spanId, targetSpanId);
  }
}
