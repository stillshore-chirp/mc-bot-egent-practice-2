import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  cognitiveTraceBundleSchema,
  cognitiveTraceEventSchema,
  TRACE_SCHEMA_VERSION,
  type CognitiveTraceEvent,
  type CognitiveTraceSpan,
} from "../../src/trace/contracts.js";

const span = (input: Partial<CognitiveTraceSpan> = {}): CognitiveTraceSpan => ({
  schemaVersion: TRACE_SCHEMA_VERSION,
  traceId: randomUUID(),
  spanId: randomUUID(),
  sequence: 1,
  stage: "request",
  name: "利用者依頼",
  status: "running",
  sensitivity: "internal",
  ...input,
});

describe("cognitiveTraceBundleSchema", () => {
  it("rejects foreign, duplicated, missing, or nonterminal bundle events", () => {
    const root = span({
      status: "succeeded",
      endedAt: new Date().toISOString(),
    });
    const completed = eventFor(root, {
      type: "trace.completed",
      sequence: 1,
    });
    const bundle = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      kind: "recorded-real-trace" as const,
      exportedAt: new Date().toISOString(),
      trace: {
        schemaVersion: TRACE_SCHEMA_VERSION,
        traceId: root.traceId,
        rootSpanId: root.spanId,
        status: "succeeded" as const,
        requestSummary: "利用者依頼",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        lastSequence: 1,
        eventCount: 1,
        demoSafe: true,
        source: "recorded" as const,
      },
      events: [completed],
      redaction: {
        schemaVersion: TRACE_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        policy: "presenter-v1" as const,
        removedFields: ["event.attributes"],
      },
    };

    expect(cognitiveTraceBundleSchema.parse(bundle).events).toHaveLength(1);
    expect(() =>
      cognitiveTraceBundleSchema.parse({
        ...bundle,
        events: [{ ...completed, traceId: randomUUID() }],
      }),
    ).toThrow();
    expect(() =>
      cognitiveTraceBundleSchema.parse({
        ...bundle,
        trace: { ...bundle.trace, eventCount: 2, lastSequence: 2 },
        events: [completed, completed],
      }),
    ).toThrow();
    expect(() =>
      cognitiveTraceBundleSchema.parse({
        ...bundle,
        events: [{ ...completed, type: "span.succeeded" }],
      }),
    ).toThrow();
  });
});

const eventFor = (
  snapshot: CognitiveTraceSpan,
  input: Partial<CognitiveTraceEvent> = {},
): CognitiveTraceEvent => ({
  schemaVersion: TRACE_SCHEMA_VERSION,
  eventId: randomUUID(),
  traceId: snapshot.traceId,
  spanId: snapshot.spanId,
  sequence: 1,
  timestamp: new Date().toISOString(),
  type: "span.started",
  span: snapshot,
  ...input,
});

describe("cognitiveTraceEventSchema", () => {
  it("accepts a matching span event", () => {
    const snapshot = span();
    expect(cognitiveTraceEventSchema.parse(eventFor(snapshot))).toMatchObject({
      type: "span.started",
      spanId: snapshot.spanId,
    });
  });

  it("rejects event types whose payload or status does not match", () => {
    const snapshot = span();
    expect(() =>
      cognitiveTraceEventSchema.parse(
        eventFor(snapshot, {
          type: "result.created",
          span: snapshot,
        }),
      ),
    ).toThrow();
    expect(() =>
      cognitiveTraceEventSchema.parse(
        eventFor(snapshot, {
          type: "span.succeeded",
          span: snapshot,
        }),
      ),
    ).toThrow();
  });

  it("requires trace.completed to carry a terminal parentless root snapshot", () => {
    const child = span({
      parentSpanId: randomUUID(),
      status: "succeeded",
      endedAt: new Date().toISOString(),
    });
    expect(() =>
      cognitiveTraceEventSchema.parse(
        eventFor(child, { type: "trace.completed", span: child }),
      ),
    ).toThrow();

    const root = span({
      status: "succeeded",
      endedAt: new Date().toISOString(),
    });
    expect(
      cognitiveTraceEventSchema.parse(
        eventFor(root, { type: "trace.completed", span: root }),
      ).type,
    ).toBe("trace.completed");
  });

  it("allows progress only on span.progress and requires its value", () => {
    const snapshot = span();
    expect(() =>
      cognitiveTraceEventSchema.parse(eventFor(snapshot, { progress: 0.5 })),
    ).toThrow();
    expect(() =>
      cognitiveTraceEventSchema.parse(
        eventFor(snapshot, { type: "span.progress" }),
      ),
    ).toThrow();
  });
});
