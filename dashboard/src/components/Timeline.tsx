import type { CSSProperties } from "react";
import type { CognitiveTraceEvent, CognitiveTraceSpan } from "@trace";

import {
  formatDate,
  formatDuration,
  stageColors,
  stageLabels,
  statusLabels,
} from "../trace/labels";

interface TimelineProps {
  readonly spans: readonly CognitiveTraceSpan[];
  readonly events: readonly CognitiveTraceEvent[];
  readonly selectedSpanId?: string;
  readonly replayIndex: number;
  readonly replayEnabled: boolean;
  readonly onSelect: (spanId: string) => void;
  readonly onSeek: (index: number) => void;
}

export function Timeline({
  spans,
  events,
  selectedSpanId,
  replayIndex,
  replayEnabled,
  onSelect,
  onSeek,
}: TimelineProps) {
  const sorted = [...spans].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const starts = sorted
    .map((span) => parseTimestamp(span.startedAt))
    .filter(isFiniteTimestamp);
  const ends = sorted
    .map((span) => parseTimestamp(span.endedAt ?? span.startedAt))
    .filter(isFiniteTimestamp);
  const start = starts.length > 0 ? Math.min(...starts) : Date.now();
  const end = ends.length > 0 ? Math.max(...ends, start + 1) : start + 1;
  const width = Math.max(1, end - start);
  return (
    <section className="timeline-panel" aria-labelledby="timeline-heading">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">EVENT ORDER</p>
          <h2 id="timeline-heading">Timeline</h2>
        </div>
        <span className="timeline-range">
          {formatDate(new Date(start).toISOString())} —{" "}
          {formatDate(new Date(end).toISOString())}
        </span>
      </div>
      {replayEnabled ? (
        <label className="timeline-slider-label" htmlFor="replay-seek">
          再生位置{" "}
          <span>
            {replayIndex < 0
              ? "開始前"
              : `${replayIndex + 1} / ${events.length}`}
          </span>
        </label>
      ) : null}
      {replayEnabled ? (
        <input
          id="replay-seek"
          className="timeline-slider"
          type="range"
          min={-1}
          max={Math.max(-1, events.length - 1)}
          value={replayIndex}
          onChange={(event) => onSeek(Number(event.currentTarget.value))}
          aria-valuetext={
            replayIndex < 0 ? "開始前" : `${replayIndex + 1}イベント目`
          }
        />
      ) : null}
      {sorted.length === 0 ? (
        <p className="empty-copy">
          タイムラインへ表示するイベントはありません。
        </p>
      ) : (
        <ol className="timeline-list">
          {sorted.map((span) => {
            const spanStart = Date.parse(span.startedAt ?? "") || start;
            const spanEnd =
              Date.parse(span.endedAt ?? span.startedAt ?? "") || spanStart + 1;
            const left = `${Math.max(0, ((spanStart - start) / width) * 100)}%`;
            const barWidth = `${Math.max(1, ((spanEnd - spanStart) / width) * 100)}%`;
            const firstEventIndex = events.findIndex(
              (event) => event.spanId === span.spanId,
            );
            return (
              <li key={span.spanId}>
                <button
                  type="button"
                  className={`timeline-row ${selectedSpanId === span.spanId ? "is-selected" : ""}`}
                  onClick={() => {
                    onSelect(span.spanId);
                    if (replayEnabled && firstEventIndex >= 0)
                      onSeek(firstEventIndex);
                  }}
                >
                  <span className="timeline-label">
                    {stageLabels[span.stage]}
                    <small>
                      {statusLabels[span.status]} ·{" "}
                      {formatDuration(span.startedAt, span.endedAt)}
                    </small>
                  </span>
                  <span className="timeline-track" aria-hidden="true">
                    <span
                      className="timeline-bar"
                      style={
                        {
                          left,
                          width: barWidth,
                          "--timeline-color": stageColors[span.stage],
                        } as CSSProperties
                      }
                    />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function parseTimestamp(value: string | undefined): number {
  return value === undefined ? Number.NaN : Date.parse(value);
}

function isFiniteTimestamp(value: number): value is number {
  return Number.isFinite(value);
}
