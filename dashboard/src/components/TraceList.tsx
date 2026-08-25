import { useRef, useState } from "react";

import type { CognitiveTraceRun, CognitiveStage, TraceStatus } from "@trace";

import {
  exportBundle,
  importDemoBundle,
  markTraceDemoSafe,
} from "../trace/api";
import {
  formatDate,
  formatDuration,
  stageLabels,
  statusLabels,
  statusSymbols,
} from "../trace/labels";

interface TraceListProps {
  readonly runs: readonly CognitiveTraceRun[];
  readonly selectedTraceId?: string;
  readonly query: string;
  readonly stage?: CognitiveStage;
  readonly status?: TraceStatus;
  readonly onQuery: (value: string) => void;
  readonly onStage: (value: CognitiveStage | undefined) => void;
  readonly onStatus: (value: TraceStatus | undefined) => void;
  readonly onSelect: (traceId: string) => void;
  readonly onRefresh: () => Promise<void>;
}

export function TraceList({
  runs,
  selectedTraceId,
  query,
  stage,
  status,
  onQuery,
  onStage,
  onStatus,
  onSelect,
  onRefresh,
}: TraceListProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [action, setAction] = useState<"marking" | "exporting" | "importing">();
  const [actionMessage, setActionMessage] = useState<string>();
  const selectedRun = runs.find(({ traceId }) => traceId === selectedTraceId);
  const filtered = runs.filter((run) => {
    const matchesQuery =
      query.trim().length === 0 ||
      run.requestSummary
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase());
    const matchesStatus = status === undefined || run.status === status;
    return (
      matchesQuery &&
      matchesStatus &&
      (stage === undefined || run.requestSummary.length > 0)
    );
  });
  return (
    <aside className="trace-sidebar" aria-label="トレース一覧">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RECORDED RUNS</p>
          <h2>トレース一覧</h2>
        </div>
        <span className="count-badge" aria-label={`${filtered.length}件`}>
          {filtered.length}
        </span>
      </div>
      <label className="field-label" htmlFor="trace-search">
        依頼を検索
      </label>
      <input
        id="trace-search"
        className="text-input"
        type="search"
        value={query}
        onChange={(event) => onQuery(event.currentTarget.value)}
        placeholder="redacted summary"
      />
      <div className="filter-row" aria-label="トレースフィルター">
        <label className="compact-field">
          <span>状態</span>
          <select
            value={status ?? ""}
            onChange={(event) =>
              onStatus(
                event.currentTarget.value === ""
                  ? undefined
                  : (event.currentTarget.value as TraceStatus),
              )
            }
          >
            <option value="">すべて</option>
            {(Object.keys(statusLabels) as TraceStatus[]).map((value) => (
              <option key={value} value={value}>
                {statusLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="compact-field">
          <span>段階</span>
          <select
            value={stage ?? ""}
            onChange={(event) =>
              onStage(
                event.currentTarget.value === ""
                  ? undefined
                  : (event.currentTarget.value as CognitiveStage),
              )
            }
          >
            <option value="">すべて</option>
            {(Object.keys(stageLabels) as CognitiveStage[]).map((value) => (
              <option key={value} value={value}>
                {stageLabels[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="trace-tools" aria-labelledby="trace-tools-heading">
        <div className="trace-tools-heading">
          <h3 id="trace-tools-heading">Demo-safe 管理</h3>
          <span className="trace-card-meta">実保存トレースのみ</span>
        </div>
        <p className="trace-tools-copy">
          Presenter用の秘匿化をbackendで適用した実データだけをexport/importできます。
        </p>
        <div className="trace-tools-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={
              selectedRun === undefined ||
              selectedRun.demoSafe ||
              action !== undefined
            }
            onClick={() => {
              if (selectedRun === undefined) return;
              setAction("marking");
              setActionMessage(undefined);
              void markTraceDemoSafe(selectedRun.traceId)
                .then(async () => {
                  setActionMessage("demo-safeマークを保存しました。");
                  await onRefresh();
                })
                .catch(() =>
                  setActionMessage(
                    "demo-safeマークを保存できませんでした。backendの状態を確認してください。",
                  ),
                )
                .finally(() => setAction(undefined));
            }}
          >
            {selectedRun?.demoSafe
              ? "demo-safe済み"
              : action === "marking"
                ? "秘匿化中…"
                : "demo-safeにする"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={
              selectedRun === undefined ||
              !selectedRun.demoSafe ||
              action !== undefined
            }
            onClick={() => {
              if (!selectedRun?.demoSafe) return;
              setAction("exporting");
              setActionMessage(undefined);
              void exportBundle(selectedRun.traceId)
                .then((bundle) => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(bundle, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = `trace-${selectedRun.traceId}.json`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                  setActionMessage("秘匿化済みトレースをexportしました。");
                })
                .catch(() =>
                  setActionMessage(
                    "exportできませんでした。demo-safe状態とbackendの状態を確認してください。",
                  ),
                )
                .finally(() => setAction(undefined));
            }}
          >
            {action === "exporting" ? "export中…" : "export"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={action !== undefined}
            onClick={() => fileInputRef.current?.click()}
          >
            {action === "importing" ? "import中…" : "import"}
          </button>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            aria-label="demo-safeトレースJSONをimport"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file === undefined) return;
              setAction("importing");
              setActionMessage(undefined);
              void file
                .text()
                .then((text) => importDemoBundle(JSON.parse(text)))
                .then(async (run) => {
                  await onRefresh();
                  onSelect(run.traceId);
                  setActionMessage("demo-safeトレースをimportしました。");
                })
                .catch(() =>
                  setActionMessage(
                    "importできませんでした。秘匿化済みの実トレースJSONを選択してください。",
                  ),
                )
                .finally(() => setAction(undefined));
            }}
          />
        </div>
        <p className="trace-tools-status" aria-live="polite">
          {selectedRun === undefined
            ? "トレースを選択してください。"
            : (actionMessage ??
              (selectedRun.demoSafe
                ? "export可能なdemo-safeトレースです。"
                : "exportにはdemo-safe化が必要です。"))}
        </p>
      </section>
      {filtered.length === 0 ? (
        <p className="empty-copy">
          実行トレースはまだありません。
          <br />
          ボットが依頼を処理すると、ここに処理グラフが表示されます。
        </p>
      ) : (
        <ul className="trace-list">
          {filtered.map((run) => (
            <li key={run.traceId}>
              <button
                className={`trace-card ${run.traceId === selectedTraceId ? "is-selected" : ""}`}
                type="button"
                aria-current={
                  run.traceId === selectedTraceId ? "true" : undefined
                }
                onClick={() => onSelect(run.traceId)}
              >
                <span className="trace-card-topline">
                  <span
                    className={`state-symbol state-${run.status}`}
                    aria-hidden="true"
                  >
                    {statusSymbols[run.status]}
                  </span>
                  <span className="trace-card-status">
                    {statusLabels[run.status]}
                  </span>
                  {run.demoSafe ? (
                    <span className="safe-badge">demo-safe</span>
                  ) : null}
                </span>
                <strong>{run.requestSummary}</strong>
                <span className="trace-card-meta">
                  {formatDate(run.startedAt)} ·{" "}
                  {formatDuration(run.startedAt, run.endedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
