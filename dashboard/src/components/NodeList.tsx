import { useRef, type CSSProperties } from "react";

import type { CognitiveTraceResult, CognitiveTraceSpan } from "@trace";

import {
  formatDuration,
  resultKindLabels,
  stageColors,
  stageLabels,
  statusLabels,
  statusSymbols,
  truncate,
} from "../trace/labels";

interface NodeListProps {
  readonly spans: readonly CognitiveTraceSpan[];
  readonly results: readonly CognitiveTraceResult[];
  readonly selectedSpanId?: string;
  readonly onSelect: (spanId: string) => void;
}

export function NodeList({
  spans,
  results,
  selectedSpanId,
  onSelect,
}: NodeListProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const orderedSpans = [...spans].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const orderedResults = [...results].sort((left, right) =>
    left.resultId.localeCompare(right.resultId),
  );
  const itemCount = orderedSpans.length + orderedResults.length;
  const focusAt = (index: number): void => {
    const boundedIndex = Math.min(Math.max(index, 0), itemCount - 1);
    const targetId =
      boundedIndex < orderedSpans.length
        ? orderedSpans[boundedIndex]?.spanId
        : orderedResults[boundedIndex - orderedSpans.length]?.resultId;
    if (targetId !== undefined) refs.current.get(targetId)?.focus();
  };
  return (
    <section className="node-list-panel" aria-labelledby="node-list-heading">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">ACCESSIBLE GRAPH</p>
          <h2 id="node-list-heading">処理ノード</h2>
        </div>
        <span
          className="count-badge"
          aria-label={`${spans.length + results.length}ノード`}
        >
          {spans.length + results.length}
        </span>
      </div>
      {itemCount === 0 ? (
        <p className="empty-copy">
          選択したトレースに表示可能なノードはありません。
        </p>
      ) : (
        <div
          className="node-list"
          role="listbox"
          aria-label="処理ノード一覧"
          aria-orientation="vertical"
        >
          {orderedSpans.map((span, index) => (
            <div key={span.spanId} role="presentation">
              <button
                ref={(element) => {
                  if (element === null) refs.current.delete(span.spanId);
                  else refs.current.set(span.spanId, element);
                }}
                className={`node-row ${span.spanId === selectedSpanId ? "is-selected" : ""}`}
                type="button"
                role="option"
                aria-selected={span.spanId === selectedSpanId}
                aria-current={
                  span.spanId === selectedSpanId ? "true" : undefined
                }
                tabIndex={
                  selectedSpanId === undefined
                    ? index === 0
                      ? 0
                      : -1
                    : span.spanId === selectedSpanId
                      ? 0
                      : -1
                }
                onClick={() => onSelect(span.spanId)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                    event.preventDefault();
                    focusAt(index + 1);
                  }
                  if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    focusAt(index - 1);
                  }
                  if (event.key === "Home") {
                    event.preventDefault();
                    focusAt(0);
                  }
                  if (event.key === "End") {
                    event.preventDefault();
                    focusAt(itemCount - 1);
                  }
                }}
              >
                <span
                  className="node-shape"
                  style={
                    { "--node-color": stageColors[span.stage] } as CSSProperties
                  }
                  aria-hidden="true"
                >
                  <span>{statusSymbols[span.status]}</span>
                </span>
                <span className="node-row-copy">
                  <span className="node-row-title">
                    <strong>{stageLabels[span.stage]}</strong>
                    <span className="node-status-text">
                      {statusLabels[span.status]}
                    </span>
                  </span>
                  <span className="node-row-name">{span.name}</span>
                  <span className="node-row-summary">
                    {truncate(span.summary)}
                  </span>
                </span>
                <span className="node-row-duration">
                  {formatDuration(span.startedAt, span.endedAt)}
                </span>
              </button>
            </div>
          ))}
          {orderedResults.map((result, resultIndex) => (
            <div key={result.resultId} role="presentation">
              <button
                className={`node-row node-result-row ${result.spanId === selectedSpanId ? "is-selected" : ""}`}
                type="button"
                role="option"
                aria-selected={result.spanId === selectedSpanId}
                tabIndex={
                  selectedSpanId === undefined
                    ? resultIndex === 0 && orderedSpans.length === 0
                      ? 0
                      : -1
                    : result.spanId === selectedSpanId
                      ? 0
                      : -1
                }
                aria-label={`${resultKindLabels[result.kind]}、${result.summary}`}
                onClick={() => onSelect(result.spanId)}
                ref={(element) => {
                  if (element === null) refs.current.delete(result.resultId);
                  else refs.current.set(result.resultId, element);
                }}
                onKeyDown={(event) => {
                  const index = orderedSpans.length + resultIndex;
                  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                    event.preventDefault();
                    focusAt(index + 1);
                  }
                  if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    focusAt(index - 1);
                  }
                  if (event.key === "Home") {
                    event.preventDefault();
                    focusAt(0);
                  }
                  if (event.key === "End") {
                    event.preventDefault();
                    focusAt(itemCount - 1);
                  }
                }}
              >
                <span
                  className="node-shape node-result-shape"
                  aria-hidden="true"
                >
                  <span>R</span>
                </span>
                <span className="node-row-copy">
                  <span className="node-row-title">
                    <strong>{resultKindLabels[result.kind]}</strong>
                    <span className="node-status-text">結果</span>
                  </span>
                  <span className="node-row-summary">
                    {truncate(result.summary)}
                  </span>
                  {result.verificationSummary ? (
                    <span className="node-row-summary">
                      {truncate(result.verificationSummary)}
                    </span>
                  ) : null}
                </span>
                <span className="node-row-duration">{result.sensitivity}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
