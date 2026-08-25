import { describe, expect, it } from "vitest";

import {
  initialTraceState,
  reduceReplay,
  traceReducer,
} from "../../dashboard/src/trace/reducer.js";
import type {
  CognitiveTraceEvent,
  CognitiveTraceLink,
  CognitiveTraceResult,
} from "../../src/trace/contracts.js";
import { detail, events, spans } from "../browser/fixtures/trace.js";

describe("dashboard trace reducer", () => {
  it("keeps future execution data hidden before replay begins", () => {
    const state = reduceReplay(detail, events, -1);

    expect(state.run).toMatchObject({
      requestSummary: detail.run.requestSummary,
      status: "queued",
      eventCount: 0,
      lastSequence: 0,
    });
    expect(state.run?.endedAt).toBeUndefined();
    expect(state.spans).toEqual([]);
    expect(state.links).toEqual([]);
    expect(state.results).toEqual([]);
  });

  it("uses the same event application path for live and replay", () => {
    const live = traceReducer(initialTraceState(detail), {
      type: "apply-many",
      events,
    });
    const replay = reduceReplay(detail, events, events.length - 1);

    expect(replay.spans).toEqual(live.spans);
    expect(replay.links).toEqual(live.links);
    expect(replay.results).toEqual(live.results);
    expect(replay.run).toEqual(live.run);
    expect(replay.events).toEqual(live.events);
  });

  it("deduplicates event IDs and detects then resolves sequence gaps", () => {
    const first = events[0];
    const third = events[2];
    const second = events[1];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("dashboard reducer fixture is incomplete");
    }

    const withGap = traceReducer(initialTraceState(detail), {
      type: "apply-many",
      events: [first, third],
    });
    expect(withGap.gaps).toEqual([{ from: 2, to: 2 }]);
    expect(withGap.run?.eventCount).toBe(2);

    const resolved = traceReducer(withGap, { type: "apply", event: second });
    expect(resolved.gaps).toEqual([]);
    expect(resolved.outOfOrderEvents).toBe(1);
    expect(resolved.run?.eventCount).toBe(3);

    const duplicate = traceReducer(resolved, { type: "apply", event: second });
    expect(duplicate.events).toHaveLength(3);
    expect(duplicate.duplicateEvents).toBe(1);
  });

  it("materializes typed causal links and result nodes", () => {
    const toolSpan = spans[2];
    const verificationSpan = spans[3];
    if (toolSpan === undefined || verificationSpan === undefined) {
      throw new Error("dashboard graph fixture is incomplete");
    }
    const link: CognitiveTraceLink = {
      type: "verifies",
      sourceSpanId: toolSpan.spanId,
      targetSpanId: verificationSpan.spanId,
    };
    const result: CognitiveTraceResult = {
      resultId: "66666666-6666-4666-8666-666666666666",
      spanId: toolSpan.spanId,
      kind: "tool_result",
      summary: "構造化された観測結果",
      sensitivity: "public",
    };
    const typedEvents: readonly CognitiveTraceEvent[] = [
      event(1, "link.created", { link }),
      event(2, "result.created", { result }),
    ];

    const state = traceReducer(initialTraceState(detail), {
      type: "apply-many",
      events: typedEvents,
    });
    expect(state.links).toEqual([link]);
    expect(state.results).toEqual([result]);
  });
});

function event(
  sequence: number,
  type: CognitiveTraceEvent["type"],
  payload: Pick<CognitiveTraceEvent, "link" | "result">,
): CognitiveTraceEvent {
  const toolSpan = spans[2];
  if (toolSpan === undefined) {
    throw new Error("dashboard event fixture is incomplete");
  }
  return {
    schemaVersion: 1,
    eventId:
      sequence === 1
        ? "12121212-1212-4212-8212-121212121212"
        : "13131313-1313-4313-8313-131313131313",
    streamId: sequence,
    traceId: detail.run.traceId,
    spanId: toolSpan.spanId,
    sequence,
    timestamp: `2026-08-25T00:00:0${String(sequence)}.000Z`,
    type,
    ...payload,
  };
}
