import type {
  CognitiveTraceLink,
  CognitiveTraceResult,
  CognitiveTraceSpan,
} from "@trace";

import { stageLanes } from "../trace/labels";

export interface GraphPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const laneOrder = [
  "input",
  "perception",
  "memory",
  "deliberation",
  "tool",
  "minecraft",
  "verification",
  "memory-write",
  "response",
  "safety",
  "system",
];

export function calculateLayout(
  spans: readonly CognitiveTraceSpan[],
  links: readonly CognitiveTraceLink[],
  results: readonly CognitiveTraceResult[] = [],
): ReadonlyMap<string, GraphPoint> {
  const parents = new Map<string, string>();
  for (const span of spans)
    if (span.parentSpanId !== undefined)
      parents.set(span.spanId, span.parentSpanId);
  for (const link of links)
    if (link.type === "parent")
      parents.set(link.targetSpanId, link.sourceSpanId);
  const ordered = [...spans].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const points = new Map<string, GraphPoint>();
  for (const [index, span] of ordered.entries()) {
    const depth = graphDepth(span.spanId, parents, new Set());
    const lane = Math.max(0, laneOrder.indexOf(stageLanes[span.stage]));
    points.set(span.spanId, {
      x: index * 3.1,
      y: (lane - (laneOrder.length - 1) / 2) * 2.4,
      z: depth * 2.2,
    });
  }
  for (const [index, result] of [...results]
    .sort((left, right) => left.resultId.localeCompare(right.resultId))
    .entries()) {
    const parent = points.get(result.spanId);
    if (parent === undefined) continue;
    points.set(result.resultId, {
      x: parent.x + 1.35 + (index % 3) * 0.35,
      y: parent.y - 1.1 - (index % 2) * 0.5,
      z: parent.z + 0.8,
    });
  }
  return points;
}

function graphDepth(
  spanId: string,
  parents: ReadonlyMap<string, string>,
  seen: Set<string>,
): number {
  if (seen.has(spanId)) return 0;
  const parent = parents.get(spanId);
  if (parent === undefined) return 0;
  seen.add(spanId);
  return Math.min(8, 1 + graphDepth(parent, parents, seen));
}
