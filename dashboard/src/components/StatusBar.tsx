import type { CognitiveTraceRun } from "@trace";

import { formatDate, formatDuration, statusLabels } from "../trace/labels";
import type { DashboardBotHealth, DashboardMode } from "../trace/use-dashboard";
import type { TraceStreamState } from "../trace/reducer";

interface StatusBarProps {
  readonly healthState: "unknown" | "healthy" | "degraded" | "offline";
  readonly botHealth: DashboardBotHealth;
  readonly streamState: TraceStreamState;
  readonly streamMessage?: string;
  readonly run?: CognitiveTraceRun;
  readonly mode: DashboardMode;
  readonly presenter: boolean;
  readonly onPresenter: () => void;
}

const connectionLabels: Record<TraceStreamState, string> = {
  idle: "未接続",
  connecting: "接続中",
  connected: "ライブ接続",
  reconnecting: "再接続中",
  disconnected: "切断",
  degraded: "観測性劣化",
};

export function StatusBar({
  healthState,
  botHealth,
  streamState,
  streamMessage,
  run,
  mode,
  presenter,
  onPresenter,
}: StatusBarProps) {
  const healthLabel =
    healthState === "healthy"
      ? "API正常"
      : healthState === "degraded"
        ? "観測性劣化"
        : healthState === "offline"
          ? "API未接続"
          : "API確認中";
  return (
    <header className="status-bar">
      <div className="brand-block">
        <p className="eyebrow">AI COMPANION OBSERVATORY</p>
        <h1>処理トレース</h1>
      </div>
      <div className="status-cluster" aria-live="polite">
        <span className={`status-chip status-${healthState}`}>
          <span className="status-dot" aria-hidden="true" />
          {healthLabel}
        </span>
        <span className={`status-chip stream-${streamState}`}>
          <span className="status-symbol" aria-hidden="true">
            {streamState === "connected" ? "●" : "○"}
          </span>
          {connectionLabels[streamState]}
        </span>
        <span className="mode-chip">
          {mode === "replay" ? "Recorded / Replay" : "Live"}
        </span>
        <StatusChip label="Bot" value={botHealth.botState} />
        <StatusChip label="Connection" value={botHealth.connectionState} />
        <StatusChip label="AI" value={botHealth.aiState} />
        <StatusChip label="Memory" value={botHealth.memoryState} />
        <StatusChip
          label="Task"
          value={botHealth.taskStatus ?? botHealth.taskPhase}
        />
        <StatusChip label="Health" value={botHealth.health} />
        <StatusChip label="Food" value={botHealth.food} />
        <StatusChip label="Position" value={botHealth.positionState} />
        {run === undefined ? (
          <span className="status-muted">選択中のトレースなし</span>
        ) : (
          <span className="status-task">
            <span>{run.requestSummary}</span>
            <span className="status-task-meta">
              {statusLabels[run.status]} · {formatDate(run.startedAt)} ·{" "}
              {formatDuration(run.startedAt, run.endedAt)}
            </span>
          </span>
        )}
      </div>
      <button
        className="button button-secondary presenter-trigger"
        type="button"
        aria-pressed={presenter}
        onClick={onPresenter}
      >
        {presenter ? "Presenter終了" : "Presenter Mode"}
      </button>
      {streamMessage !== undefined ? (
        <p className="sr-only">{streamMessage}</p>
      ) : null}
    </header>
  );
}

function StatusChip({
  label,
  value,
}: {
  readonly label: string;
  readonly value?: string | number;
}) {
  return (
    <span
      className="status-chip status-neutral"
      aria-label={`${label}: ${statusText(value)}`}
    >
      <span>{label}</span>
      <span>{statusText(value)}</span>
    </span>
  );
}

function statusText(value: string | number | undefined): string {
  if (value === undefined) return "未取得";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "未取得";
  const labels: Record<string, string> = {
    online: "稼働中",
    running: "実行中",
    ready: "準備完了",
    idle: "待機中",
    connected: "接続済み",
    disconnected: "切断",
    connecting: "接続中",
    healthy: "正常",
    degraded: "劣化",
    offline: "停止中",
    unavailable: "利用不可",
    unknown: "不明",
    available: "利用可能",
    available_redacted: "座標は秘匿済み",
    active: "有効",
    inactive: "無効",
    blocked: "停止要因あり",
    queued: "待機中",
    waiting: "待機中",
    succeeded: "成功",
    failed: "失敗",
    cancelled: "キャンセル済み",
    skipped: "スキップ",
  };
  return labels[value] ?? "未認識状態";
}
