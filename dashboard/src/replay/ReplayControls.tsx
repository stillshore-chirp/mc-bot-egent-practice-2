import type { DashboardMode } from "../trace/use-dashboard";
import { formatDate } from "../trace/labels";

interface ReplayControlsProps {
  readonly mode: DashboardMode;
  readonly livePaused: boolean;
  readonly liveBufferedCount: number;
  readonly liveBufferOverflow: boolean;
  readonly eventCount: number;
  readonly replayIndex: number;
  readonly eventTimestamp?: string;
  readonly speed: number;
  readonly playing: boolean;
  readonly onMode: (mode: DashboardMode) => void;
  readonly onLivePaused: (paused: boolean) => void;
  readonly onIndex: (index: number) => void;
  readonly onSpeed: (speed: number) => void;
  readonly onPlaying: (playing: boolean) => void;
}

const speeds = [0.25, 0.5, 1, 2, 4];

export function ReplayControls({
  mode,
  livePaused,
  liveBufferedCount,
  liveBufferOverflow,
  eventCount,
  replayIndex,
  eventTimestamp,
  speed,
  playing,
  onMode,
  onLivePaused,
  onIndex,
  onSpeed,
  onPlaying,
}: ReplayControlsProps) {
  const maxIndex = Math.max(-1, eventCount - 1);
  return (
    <section className="replay-controls" aria-label="Replay controls">
      <div className="replay-control-group">
        <span className="eyebrow">TRACE MODE</span>
        <div className="segmented-control" role="group" aria-label="表示モード">
          <button
            type="button"
            className={mode === "live" ? "is-active" : ""}
            aria-pressed={mode === "live"}
            onClick={() => onMode("live")}
          >
            Live
          </button>
          <button
            type="button"
            className={mode === "replay" ? "is-active" : ""}
            aria-pressed={mode === "replay"}
            onClick={() => onMode("replay")}
            disabled={eventCount === 0}
          >
            Replay
          </button>
        </div>
      </div>
      {mode === "replay" ? (
        <>
          <div className="replay-control-group replay-buttons">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onIndex(Math.max(-1, replayIndex - 1))}
              disabled={eventCount === 0}
              aria-label="1イベント戻る"
            >
              戻る
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() => onPlaying(!playing)}
              disabled={eventCount === 0}
            >
              {playing ? "一時停止" : "再生"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onIndex(Math.min(maxIndex, replayIndex + 1))}
              disabled={eventCount === 0}
              aria-label="1イベント進む"
            >
              進む
            </button>
          </div>
          <label className="speed-control">
            速度
            <select
              value={speed}
              onChange={(event) => onSpeed(Number(event.currentTarget.value))}
            >
              {speeds.map((value) => (
                <option key={value} value={value}>
                  {value}x
                </option>
              ))}
            </select>
          </label>
          <span className="replay-position" aria-live="polite">
            {eventCount === 0
              ? "イベントなし"
              : replayIndex < 0
                ? "開始前"
                : `${replayIndex + 1} / ${eventCount} event · original ${formatDate(eventTimestamp)}`}
          </span>
        </>
      ) : (
        <>
          <button
            type="button"
            className="button button-secondary live-pause-button"
            aria-pressed={livePaused}
            onClick={() => onLivePaused(!livePaused)}
          >
            {livePaused ? "Live更新を再開" : "Live更新を一時停止"}
          </button>
          <span className="replay-hint" aria-live="polite">
            {livePaused
              ? `Live更新停止 · ${liveBufferedCount}件待機${liveBufferOverflow ? " · 保存済みeventsから再構築します" : ""}`
              : "実イベントを受信したときだけグラフを更新します。"}
          </span>
        </>
      )}
    </section>
  );
}
