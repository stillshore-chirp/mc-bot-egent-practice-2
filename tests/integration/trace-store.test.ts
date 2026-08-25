import { randomUUID } from "node:crypto";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { TRACE_SCHEMA_VERSION } from "../../src/trace/contracts.js";
import { TraceService } from "../../src/trace/service.js";
import { TraceStore, type TraceStoreError } from "../../src/trace/store.js";

describe("TraceStore and TraceService", () => {
  it("persists before publish and produces a complete ordered trace", async () => {
    const store = TraceStore.open(":memory:");
    const service = new TraceService(store, pino({ level: "silent" }));
    const observedCounts: number[] = [];
    service.subscribe(() => observedCounts.push(store.countEvents()));

    const session = await service.startTrace("利用者依頼", {
      attributes: { requestKind: "owner_chat", username: "must-drop" },
    });
    await service.withTrace(session, async () => {
      await service.withSpan(
        "deliberation",
        "次の行動を選択",
        { resultKind: "selected_tool", summarizeResult: () => "行動を選択" },
        async () => "safe",
      );
    });
    await session.complete("succeeded", { summary: "応答完了" });

    const detail = store.getTrace(session.traceId);
    const events = store.listEvents(session.traceId);
    expect(detail?.run.status).toBe("succeeded");
    expect(detail?.run.eventCount).toBe(events.length);
    expect(events.map(({ sequence }) => sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.at(-1)).toMatchObject({
      type: "trace.completed",
      spanId: session.rootSpanId,
    });
    expect(observedCounts).toEqual(events.map((_, index) => index + 1));
    expect(JSON.stringify(events)).not.toContain("must-drop");
    const bundle = store.markDemoSafe(session.traceId);
    expect(bundle.kind).toBe("recorded-real-trace");
    expect(bundle.trace.demoSafe).toBe(true);
    expect(JSON.stringify(bundle.events)).not.toContain("requestKind");
    expect(store.exportDemoBundle(session.traceId).events).toEqual(
      bundle.events,
    );
    const importedStore = TraceStore.open(":memory:");
    const firstEvent = bundle.events[0];
    if (firstEvent?.span === undefined) {
      throw new Error("completed bundle is missing its first span snapshot");
    }
    const firstSpan = firstEvent.span;
    const unsafeBundle = {
      ...bundle,
      trace: {
        ...bundle.trace,
        requestSummary: "sk-proj-unsafeimportsecretvalue",
      },
      events: bundle.events.map((event, index) =>
        index === 0
          ? {
              ...event,
              summary: "sk-proj-unsafeimportsecretvalue",
              attributes: { rawPrompt: "private", safeKey: "private" },
              span: {
                ...firstSpan,
                inputRefs: [randomUUID()],
                outputRefs: [randomUUID()],
                attributes: { rawPrompt: "private" },
                metrics: {
                  inputTokens: 99,
                  outputTokens: 42,
                  durationMs: 12,
                },
              },
            }
          : event,
      ),
    };
    expect(importedStore.importDemoBundle(unsafeBundle)).toMatchObject({
      traceId: session.traceId,
      status: "succeeded",
      source: "recorded",
      demoSafe: true,
    });
    expect(importedStore.listEvents(session.traceId)).toHaveLength(
      bundle.events.length,
    );
    const importedJson = JSON.stringify(
      importedStore.getTrace(session.traceId),
    );
    expect(importedJson).not.toContain("unsafeimportsecretvalue");
    expect(importedJson).not.toContain("rawPrompt");
    expect(importedJson).not.toContain("inputRefs");
    expect(importedJson).not.toContain("outputTokens");
    importedStore.close();
    store.close();
  });

  it("deduplicates eventId and rejects a sequence gap", () => {
    const store = TraceStore.open(":memory:");
    const traceId = randomUUID();
    const rootSpanId = randomUUID();
    store.createTrace({
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId,
      rootSpanId,
      status: "queued",
      requestSummary: "利用者依頼",
      startedAt: new Date().toISOString(),
      lastSequence: 0,
      eventCount: 0,
      demoSafe: false,
      source: "live",
    });
    const event = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      eventId: randomUUID(),
      traceId,
      spanId: rootSpanId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "span.queued" as const,
      span: {
        schemaVersion: TRACE_SCHEMA_VERSION,
        traceId,
        spanId: rootSpanId,
        sequence: 1,
        stage: "request" as const,
        name: "利用者依頼",
        status: "queued" as const,
        sensitivity: "internal" as const,
      },
    };

    const first = store.persistEvent(event);
    const duplicate = store.persistEvent(event);
    expect(duplicate.streamId).toBe(first.streamId);
    expect(store.countEvents()).toBe(1);
    expect(() =>
      store.persistEvent({
        ...event,
        summary: "同じIDの異なる内容",
      }),
    ).toThrow(
      expect.objectContaining<Partial<TraceStoreError>>({
        code: "TRACE_EVENT_ID_CONFLICT",
      }),
    );
    expect(() =>
      store.persistEvent({
        ...event,
        eventId: randomUUID(),
        sequence: 3,
      }),
    ).toThrow(
      expect.objectContaining<Partial<TraceStoreError>>({
        code: "TRACE_SEQUENCE_GAP",
      }),
    );
    store.close();
  });

  it("requires trace completion to identify the persisted root", () => {
    const store = TraceStore.open(":memory:");
    const traceId = randomUUID();
    const rootSpanId = randomUUID();
    const otherRoot = randomUUID();
    store.createTrace({
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId,
      rootSpanId,
      status: "running",
      requestSummary: "利用者依頼",
      startedAt: new Date().toISOString(),
      lastSequence: 0,
      eventCount: 0,
      demoSafe: false,
      source: "live",
    });
    expect(() =>
      store.persistEvent({
        schemaVersion: TRACE_SCHEMA_VERSION,
        eventId: randomUUID(),
        traceId,
        spanId: otherRoot,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: "trace.completed",
        span: {
          schemaVersion: TRACE_SCHEMA_VERSION,
          traceId,
          spanId: otherRoot,
          sequence: 1,
          stage: "request",
          name: "利用者依頼",
          status: "succeeded",
          endedAt: new Date().toISOString(),
          sensitivity: "internal",
        },
      }),
    ).toThrow(
      expect.objectContaining<Partial<TraceStoreError>>({
        code: "TRACE_COMPLETION_ROOT_MISMATCH",
      }),
    );
    store.close();
  });

  it("keeps root terminal span provisional until completion and rejects later events", async () => {
    const store = TraceStore.open(":memory:");
    const service = new TraceService(store, pino({ level: "silent" }));
    const session = await service.startTrace("利用者依頼");

    await session.finishSpan(session.rootSpanId, "succeeded", {
      summary: "root span処理完了",
    });
    const provisional = store.getTrace(session.traceId)?.run;
    expect(provisional?.status).toBe("running");
    expect(provisional?.endedAt).toBeUndefined();
    await session.complete("succeeded", { summary: "trace完了" });
    const completed = store.getTrace(session.traceId)?.run;
    expect(completed).toMatchObject({ status: "succeeded" });
    expect(completed?.endedAt).toBeDefined();

    await expect(
      service.withTrace(session, () =>
        session.startSpan("system", "late event"),
      ),
    ).rejects.toMatchObject({ code: "TRACE_ALREADY_COMPLETE" });

    const eventCount = store.listEvents(session.traceId).length;
    expect(() =>
      store.persistEvent({
        schemaVersion: TRACE_SCHEMA_VERSION,
        eventId: randomUUID(),
        traceId: session.traceId,
        spanId: session.rootSpanId,
        sequence: eventCount + 1,
        timestamp: new Date().toISOString(),
        type: "span.started",
        span: {
          schemaVersion: TRACE_SCHEMA_VERSION,
          traceId: session.traceId,
          spanId: session.rootSpanId,
          sequence: eventCount + 1,
          stage: "request",
          name: "利用者依頼",
          status: "running",
          sensitivity: "internal",
        },
      }),
    ).toThrow(
      expect.objectContaining<Partial<TraceStoreError>>({
        code: "TRACE_ALREADY_COMPLETE",
      }),
    );
    store.close();
  });

  it("rejects dangling or cross-trace causal links", async () => {
    const store = TraceStore.open(":memory:");
    const service = new TraceService(store, pino({ level: "silent" }));
    const session = await service.startTrace("利用者依頼");
    const eventsBefore = store.listEvents(session.traceId).length;

    expect(() =>
      store.persistEvent({
        schemaVersion: TRACE_SCHEMA_VERSION,
        eventId: randomUUID(),
        traceId: session.traceId,
        spanId: session.rootSpanId,
        sequence: eventsBefore + 1,
        timestamp: new Date().toISOString(),
        type: "link.created",
        link: {
          type: "caused_by",
          sourceSpanId: session.rootSpanId,
          targetSpanId: randomUUID(),
        },
      }),
    ).toThrow(
      expect.objectContaining<Partial<TraceStoreError>>({
        code: "TRACE_LINK_SPAN_NOT_FOUND",
      }),
    );
    expect(store.listEvents(session.traceId)).toHaveLength(eventsBefore);
    store.close();
  });

  it("enforces age and count retention for unpinned traces", () => {
    const store = TraceStore.open(":memory:");
    const createRun = (startedAt: string): string => {
      const traceId = randomUUID();
      store.createTrace({
        schemaVersion: TRACE_SCHEMA_VERSION,
        traceId,
        rootSpanId: randomUUID(),
        status: "queued",
        requestSummary: "利用者依頼",
        startedAt,
        lastSequence: 0,
        eventCount: 0,
        demoSafe: false,
        source: "live",
      });
      return traceId;
    };
    createRun("2020-01-01T00:00:00.000Z");
    const newest = createRun(new Date().toISOString());
    createRun(new Date(Date.now() - 1_000).toISOString());

    expect(store.enforceRetention({ maxAgeDays: 30, maxTraces: 1 })).toBe(2);
    expect(store.listTraces()).toEqual([
      expect.objectContaining({ traceId: newest }),
    ]);
    store.close();
  });

  it("keeps the primary operation successful when persistence is unavailable", async () => {
    const store = TraceStore.open(":memory:");
    const service = new TraceService(store, pino({ level: "silent" }));
    store.close();

    const session = await service.startTrace("利用者依頼");
    const value = await service.withTrace(session, () =>
      service.withSpan(
        "system",
        "主要処理",
        { summary: "主要処理を継続" },
        async () => 42,
      ),
    );
    await session.complete("succeeded");

    expect(value).toBe(42);
    expect(service.health).toMatchObject({
      state: "degraded",
      lastErrorCode: "TRACE_CREATE_FAILED",
    });
  });
});
