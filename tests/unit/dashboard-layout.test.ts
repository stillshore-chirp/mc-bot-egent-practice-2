import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { calculateLayout } from "../../dashboard/src/graph/layout.js";
import {
  TRACE_SCHEMA_VERSION,
  cognitiveStages,
  type CognitiveTraceLink,
  type CognitiveTraceSpan,
} from "../../src/trace/contracts.js";

function graph(size: number): {
  readonly spans: readonly CognitiveTraceSpan[];
  readonly links: readonly CognitiveTraceLink[];
} {
  const traceId = randomUUID();
  const ids = Array.from({ length: size }, () => randomUUID());
  const spans = ids.map<CognitiveTraceSpan>((spanId, index) => ({
    schemaVersion: TRACE_SCHEMA_VERSION,
    traceId,
    spanId,
    ...(index === 0 ? {} : { parentSpanId: ids[Math.floor((index - 1) / 2)] }),
    sequence: index + 1,
    stage: cognitiveStages[index % cognitiveStages.length] ?? "system",
    name: `test-stage-${String(index)}`,
    status: index % 5 === 0 ? "running" : "succeeded",
    sensitivity: "public",
  }));
  const links = spans.flatMap<CognitiveTraceLink>((span) =>
    span.parentSpanId === undefined
      ? []
      : [
          {
            type: "parent",
            sourceSpanId: span.parentSpanId,
            targetSpanId: span.spanId,
          },
        ],
  );
  return { spans, links };
}

describe("dashboard deterministic DAG layout", () => {
  it.each([150, 500])(
    "places %i nodes deterministically within the budget",
    (size) => {
      const input = graph(size);
      const started = performance.now();
      const first = calculateLayout(input.spans, input.links);
      const durationMs = performance.now() - started;
      const second = calculateLayout(input.spans, input.links);

      expect(first.size).toBe(size);
      expect([...first]).toEqual([...second]);
      expect(
        [...first.values()].every(
          ({ x, y, z }) =>
            Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z),
        ),
      ).toBe(true);
      expect(durationMs).toBeLessThan(250);
    },
  );
});
