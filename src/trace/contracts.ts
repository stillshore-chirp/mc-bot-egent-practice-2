import { z } from "zod";

export const TRACE_SCHEMA_VERSION = 1;

export const cognitiveStages = [
  "request",
  "perception",
  "memory_read",
  "context",
  "deliberation",
  "plan",
  "tool",
  "skill",
  "minecraft_action",
  "verification",
  "memory_write",
  "response",
  "reflex",
  "cancellation",
  "recovery",
  "system",
] as const;

export const traceStatuses = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
] as const;

export const traceLinkTypes = [
  "parent",
  "caused_by",
  "retry_of",
  "verifies",
  "reads_memory",
  "writes_memory",
  "interrupts",
  "resumes",
] as const;

export const traceEventTypes = [
  "span.queued",
  "span.started",
  "span.progress",
  "span.waiting",
  "span.succeeded",
  "span.failed",
  "span.cancelled",
  "span.skipped",
  "result.created",
  "link.created",
  "trace.completed",
] as const;

export const traceResultKinds = [
  "selected_tool",
  "tool_result",
  "skill_result",
  "minecraft_state_delta",
  "verification_result",
  "memory_update_result",
  "final_response",
] as const;

export type CognitiveStage = (typeof cognitiveStages)[number];
export type TraceStatus = (typeof traceStatuses)[number];
export type TraceLinkType = (typeof traceLinkTypes)[number];
export type TraceEventType = (typeof traceEventTypes)[number];
export type TraceResultKind = (typeof traceResultKinds)[number];
export type TraceSensitivity = "public" | "internal" | "sensitive";
export type TraceScalar = string | number | boolean | null;
export type TraceAttributes = Readonly<Record<string, TraceScalar>>;

export interface TraceMetrics {
  readonly durationMs?: number | undefined;
  readonly modelLatencyMs?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly toolCalls?: number | undefined;
}

export interface CognitiveTraceSpan {
  readonly schemaVersion: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly sequence: number;
  readonly stage: CognitiveStage;
  readonly name: string;
  readonly status: TraceStatus;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly summary?: string | undefined;
  readonly decisionSummary?: string | undefined;
  readonly expectedResult?: string | undefined;
  readonly actualResult?: string | undefined;
  readonly verificationResult?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly retryCount?: number | undefined;
  readonly inputRefs?: readonly string[] | undefined;
  readonly outputRefs?: readonly string[] | undefined;
  readonly memoryRefs?: readonly string[] | undefined;
  readonly metrics?: TraceMetrics | undefined;
  readonly attributes?: TraceAttributes | undefined;
  readonly sensitivity: TraceSensitivity;
}

export interface CognitiveTraceLink {
  readonly type: TraceLinkType;
  readonly sourceSpanId: string;
  readonly targetSpanId: string;
}

export interface CognitiveTraceResult {
  readonly resultId: string;
  readonly spanId: string;
  readonly kind: TraceResultKind;
  readonly summary: string;
  readonly verificationSummary?: string | undefined;
  readonly sensitivity: TraceSensitivity;
}

export interface CognitiveTraceEvent {
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly streamId?: number | undefined;
  readonly traceId: string;
  readonly spanId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: TraceEventType;
  readonly summary?: string | undefined;
  readonly progress?: number | undefined;
  readonly span?: CognitiveTraceSpan | undefined;
  readonly link?: CognitiveTraceLink | undefined;
  readonly result?: CognitiveTraceResult | undefined;
  readonly attributes?: TraceAttributes | undefined;
}

export interface CognitiveTraceRun {
  readonly schemaVersion: number;
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly status: TraceStatus;
  readonly requestSummary: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly demoSafe: boolean;
  readonly source: "live" | "recorded";
}

export interface CognitiveTraceDetail {
  readonly run: CognitiveTraceRun;
  readonly spans: readonly CognitiveTraceSpan[];
  readonly links: readonly CognitiveTraceLink[];
  readonly results: readonly CognitiveTraceResult[];
}

export interface TraceRedactionManifest {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly policy: "presenter-v1";
  readonly removedFields: readonly string[];
}

export interface CognitiveTraceBundle {
  readonly schemaVersion: number;
  readonly kind: "recorded-real-trace";
  readonly exportedAt: string;
  readonly trace: CognitiveTraceRun;
  readonly events: readonly CognitiveTraceEvent[];
  readonly redaction: TraceRedactionManifest;
}

const scalarSchema = z.union([
  z.string().max(1_000),
  z.number(),
  z.boolean(),
  z.null(),
]);
const attributesSchema = z.record(z.string().max(80), scalarSchema);
const metricsSchema = z.object({
  durationMs: z.number().nonnegative().optional(),
  modelLatencyMs: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
});

export const cognitiveTraceSpanSchema: z.ZodType<CognitiveTraceSpan> = z.object(
  {
    schemaVersion: z.number().int().positive(),
    traceId: z.uuid(),
    spanId: z.uuid(),
    parentSpanId: z.uuid().optional(),
    sequence: z.number().int().positive(),
    stage: z.enum(cognitiveStages),
    name: z.string().trim().min(1).max(160),
    status: z.enum(traceStatuses),
    startedAt: z.iso.datetime().optional(),
    endedAt: z.iso.datetime().optional(),
    summary: z.string().max(1_000).optional(),
    decisionSummary: z.string().max(1_000).optional(),
    expectedResult: z.string().max(1_000).optional(),
    actualResult: z.string().max(1_000).optional(),
    verificationResult: z.string().max(1_000).optional(),
    errorCode: z.string().max(160).optional(),
    retryCount: z.number().int().nonnegative().max(100).optional(),
    inputRefs: z.array(z.string().max(160)).max(100).optional(),
    outputRefs: z.array(z.string().max(160)).max(100).optional(),
    memoryRefs: z.array(z.string().max(160)).max(100).optional(),
    metrics: metricsSchema.optional(),
    attributes: attributesSchema.optional(),
    sensitivity: z.enum(["public", "internal", "sensitive"]),
  },
);

export const cognitiveTraceLinkSchema: z.ZodType<CognitiveTraceLink> = z.object(
  {
    type: z.enum(traceLinkTypes),
    sourceSpanId: z.uuid(),
    targetSpanId: z.uuid(),
  },
);

export const cognitiveTraceResultSchema: z.ZodType<CognitiveTraceResult> =
  z.object({
    resultId: z.uuid(),
    spanId: z.uuid(),
    kind: z.enum(traceResultKinds),
    summary: z.string().trim().min(1).max(1_000),
    verificationSummary: z.string().max(1_000).optional(),
    sensitivity: z.enum(["public", "internal", "sensitive"]),
  });

export const cognitiveTraceEventSchema: z.ZodType<CognitiveTraceEvent> = z
  .object({
    schemaVersion: z.number().int().positive(),
    eventId: z.uuid(),
    streamId: z.number().int().positive().optional(),
    traceId: z.uuid(),
    spanId: z.uuid(),
    sequence: z.number().int().positive(),
    timestamp: z.iso.datetime(),
    type: z.enum(traceEventTypes),
    summary: z.string().max(1_000).optional(),
    progress: z.number().min(0).max(1).optional(),
    span: cognitiveTraceSpanSchema.optional(),
    link: cognitiveTraceLinkSchema.optional(),
    result: cognitiveTraceResultSchema.optional(),
    attributes: attributesSchema.optional(),
  })
  .superRefine((event, context) => {
    const fail = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    const spanStatusByType: Partial<Record<TraceEventType, TraceStatus>> = {
      "span.queued": "queued",
      "span.started": "running",
      "span.progress": "running",
      "span.waiting": "waiting",
      "span.succeeded": "succeeded",
      "span.failed": "failed",
      "span.cancelled": "cancelled",
      "span.skipped": "skipped",
    };
    const expectedSpanStatus = spanStatusByType[event.type];
    if (expectedSpanStatus !== undefined) {
      if (event.span === undefined) {
        fail("Span events require a span snapshot");
      } else {
        if (
          event.span.traceId !== event.traceId ||
          event.span.spanId !== event.spanId
        ) {
          fail("Span event identifiers must match the span snapshot");
        }
        if (event.span.status !== expectedSpanStatus) {
          fail("Span event type must match the span status");
        }
      }
      if (event.link !== undefined || event.result !== undefined) {
        fail("Span events cannot include link or result payloads");
      }
    }
    if (event.type === "span.progress") {
      if (event.progress === undefined)
        fail("Progress events require progress");
    } else if (event.progress !== undefined) {
      fail("Only progress events may include progress");
    }
    if (event.type === "link.created") {
      if (event.link === undefined) {
        fail("Link events require a link payload");
      } else if (event.link.sourceSpanId !== event.spanId) {
        fail("Link event spanId must identify the source span");
      }
      if (event.span !== undefined || event.result !== undefined) {
        fail("Link events cannot include span or result payloads");
      }
    }
    if (event.type === "result.created") {
      if (event.result === undefined)
        fail("Result events require a result payload");
      else if (event.result.spanId !== event.spanId) {
        fail("Result event spanId must match the result payload");
      }
      if (event.span !== undefined || event.link !== undefined) {
        fail("Result events cannot include span or link payloads");
      }
    }
    if (event.type === "trace.completed") {
      if (event.span === undefined) {
        fail("Trace completion requires the root span snapshot");
      } else {
        if (
          event.span.traceId !== event.traceId ||
          event.span.spanId !== event.spanId ||
          event.span.parentSpanId !== undefined
        ) {
          fail("Trace completion must identify a parentless root span");
        }
        if (
          event.span.status !== "succeeded" &&
          event.span.status !== "failed" &&
          event.span.status !== "cancelled"
        ) {
          fail("Trace completion requires a terminal root status");
        }
      }
      if (event.link !== undefined || event.result !== undefined) {
        fail("Trace completion cannot include link or result payloads");
      }
    }
  });

export const cognitiveTraceRunSchema: z.ZodType<CognitiveTraceRun> = z.object({
  schemaVersion: z.number().int().positive(),
  traceId: z.uuid(),
  rootSpanId: z.uuid(),
  status: z.enum(traceStatuses),
  requestSummary: z.string().trim().min(1).max(1_000),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  lastSequence: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  demoSafe: z.boolean(),
  source: z.enum(["live", "recorded"]),
});

export const cognitiveTraceBundleSchema: z.ZodType<CognitiveTraceBundle> = z
  .object({
    schemaVersion: z.number().int().positive(),
    kind: z.literal("recorded-real-trace"),
    exportedAt: z.iso.datetime(),
    trace: cognitiveTraceRunSchema,
    events: z.array(cognitiveTraceEventSchema).max(10_000),
    redaction: z.object({
      schemaVersion: z.number().int().positive(),
      generatedAt: z.iso.datetime(),
      policy: z.literal("presenter-v1"),
      removedFields: z.array(z.string().max(160)).max(100),
    }),
  })
  .superRefine((bundle, context) => {
    const fail = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    if (
      bundle.schemaVersion !== bundle.trace.schemaVersion ||
      bundle.schemaVersion !== bundle.redaction.schemaVersion
    ) {
      fail("Bundle, trace, and redaction schema versions must match");
    }
    if (!bundle.trace.demoSafe) {
      fail("Recorded trace bundles must contain a demo-safe trace");
    }
    if (bundle.events.length !== bundle.trace.eventCount) {
      fail("Bundle event count must match the trace metadata");
    }

    const eventIds = new Set<string>();
    for (const [index, event] of bundle.events.entries()) {
      const expectedSequence = index + 1;
      if (event.traceId !== bundle.trace.traceId) {
        fail("Every bundle event must belong to the bundled trace");
      }
      if (event.sequence !== expectedSequence) {
        fail("Bundle events must be ordered with a contiguous sequence");
      }
      if (eventIds.has(event.eventId)) {
        fail("Bundle event identifiers must be unique");
      }
      eventIds.add(event.eventId);
    }

    if (bundle.trace.lastSequence !== bundle.events.length) {
      fail("Bundle lastSequence must match the final event sequence");
    }
    const completion = bundle.events.at(-1);
    if (
      completion?.type !== "trace.completed" ||
      completion.spanId !== bundle.trace.rootSpanId
    ) {
      fail("Recorded trace bundles must end with root trace completion");
    }
  });
