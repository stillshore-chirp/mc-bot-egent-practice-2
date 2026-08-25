import type {
  CognitiveTraceLink,
  CognitiveTraceResult,
  CognitiveTraceSpan,
} from "@trace";

import {
  resultKindLabels,
  stageColors,
  stageLabels,
  statusLabels,
  statusSymbols,
} from "../trace/labels";
import { calculateLayout } from "../graph/layout";

interface TraceGraph2DProps {
  readonly spans: readonly CognitiveTraceSpan[];
  readonly links: readonly CognitiveTraceLink[];
  readonly results: readonly CognitiveTraceResult[];
  readonly selectedSpanId?: string;
  readonly onSelect: (spanId: string) => void;
}

export function TraceGraph2D({
  spans,
  links,
  results,
  selectedSpanId,
  onSelect,
}: TraceGraph2DProps) {
  const layout = calculateLayout(spans, links, results);
  const width = Math.max(680, (spans.length + results.length) * 120);
  const height = 430;
  const points = new Map(
    [...layout].map(([id, point]) => [
      id,
      { x: 50 + point.x * 38, y: 215 + point.y * 16 },
    ]),
  );
  const edges =
    links.length > 0
      ? links
      : spans.flatMap((span) =>
          span.parentSpanId === undefined
            ? []
            : [
                {
                  sourceSpanId: span.parentSpanId,
                  targetSpanId: span.spanId,
                  type: "parent" as const,
                },
              ],
        );
  return (
    <div
      className="graph-2d-wrap"
      role="group"
      aria-label="2D処理グラフ。処理ノード一覧からも選択できます。"
    >
      <svg
        className="graph-2d"
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="処理トレースの2Dグラフ"
      >
        <defs>
          <marker
            id="trace-arrow"
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <path d="M0,0 L7,3.5 L0,7 z" fill="#6b7da4" />
          </marker>
        </defs>
        {edges.map((link) => {
          const from = points.get(link.sourceSpanId);
          const to = points.get(link.targetSpanId);
          return from && to ? (
            <line
              key={`${link.sourceSpanId}-${link.targetSpanId}-${link.type}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={link.type === "interrupts" ? "#fb7185" : "#6b7da4"}
              strokeWidth={link.type === "interrupts" ? 3 : 1.5}
              markerEnd="url(#trace-arrow)"
            />
          ) : null;
        })}
        {results.map((result) => {
          const from = points.get(result.spanId);
          const to = points.get(result.resultId);
          return from && to ? (
            <line
              key={`result-${result.resultId}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="#7dd3fc"
              strokeWidth={1.5}
              markerEnd="url(#trace-arrow)"
            />
          ) : null;
        })}
        {spans.map((span) => {
          const point = points.get(span.spanId);
          if (point === undefined) return null;
          return (
            <g
              key={span.spanId}
              className={`graph-node-2d ${selectedSpanId === span.spanId ? "is-selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${stageLabels[span.stage]}、${statusLabels[span.status]}、${span.name}`}
              onClick={() => onSelect(span.spanId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(span.spanId);
                }
              }}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={selectedSpanId === span.spanId ? 22 : 17}
                fill={stageColors[span.stage]}
                fillOpacity={span.status === "skipped" ? 0.35 : 0.85}
                stroke={span.status === "failed" ? "#fecaca" : "#f8fafc"}
                strokeWidth={selectedSpanId === span.spanId ? 3 : 1}
              />
              <text
                x={point.x}
                y={point.y + 5}
                textAnchor="middle"
                fill="#08101f"
                fontSize="14"
                fontWeight="700"
              >
                {statusSymbols[span.status]}
              </text>
              <text
                x={point.x}
                y={point.y + 38}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize="12"
              >
                {stageLabels[span.stage]}
              </text>
            </g>
          );
        })}
        {results.map((result) => {
          const point = points.get(result.resultId);
          if (point === undefined) return null;
          return (
            <g
              key={result.resultId}
              className="graph-node-2d graph-result-node"
              role="button"
              tabIndex={0}
              aria-label={`${resultKindLabels[result.kind]}、${result.summary}`}
              onClick={() => onSelect(result.spanId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(result.spanId);
                }
              }}
            >
              <rect
                x={point.x - 12}
                y={point.y - 12}
                width="24"
                height="24"
                rx="5"
                fill="#7dd3fc"
                fillOpacity="0.9"
                stroke="#f8fafc"
                strokeWidth="1.5"
              />
              <text
                x={point.x}
                y={point.y + 4}
                textAnchor="middle"
                fill="#08101f"
                fontSize="10"
                fontWeight="700"
              >
                R
              </text>
              <text
                x={point.x}
                y={point.y + 30}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize="10"
              >
                {resultKindLabels[result.kind]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
