import { useCallback, useEffect, useMemo, useState } from "react";

import type { CognitiveStage, TraceStatus } from "@trace";

import { BrainGraphCanvas } from "./components/BrainGraphCanvas";
import { NodeInspector } from "./components/NodeInspector";
import { NodeList } from "./components/NodeList";
import { StatusBar } from "./components/StatusBar";
import { Timeline } from "./components/Timeline";
import { TraceList } from "./components/TraceList";
import { PresenterMode } from "./presenter/PresenterMode";
import { ReplayControls } from "./replay/ReplayControls";
import { stageLabels, statusLabels } from "./trace/labels";
import { useDashboardData } from "./trace/use-dashboard";

export function App() {
  const data = useDashboardData();
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<CognitiveStage>();
  const [statusFilter, setStatusFilter] = useState<TraceStatus>();
  const [presenter, setPresenter] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const selectedSpan = data.state.spans.find(
    ({ spanId }) => spanId === data.state.selectedSpanId,
  );
  const selectedRun = data.runs.find(
    ({ traceId }) => traceId === data.selectedTraceId,
  );
  const latestEventSpanId = data.state.events.at(-1)?.spanId;
  const presenterSpan =
    data.state.spans.find(({ spanId }) => spanId === latestEventSpanId) ??
    selectedSpan;
  const filteredSpans = useMemo(
    () =>
      data.state.spans.filter(
        (span) =>
          (stageFilter === undefined || span.stage === stageFilter) &&
          (statusFilter === undefined || span.status === statusFilter),
      ),
    [data.state.spans, stageFilter, statusFilter],
  );
  const filteredResults = useMemo(
    () =>
      data.state.results.filter((result) =>
        filteredSpans.some((span) => span.spanId === result.spanId),
      ),
    [data.state.results, filteredSpans],
  );
  const handleSelectSpan = useCallback(
    (spanId: string): void => {
      data.dispatch({ type: "select", spanId });
    },
    [data.dispatch],
  );
  const handleSelectTrace = useCallback(
    (traceId: string): void => {
      setPlaying(false);
      void data.selectTrace(traceId);
    },
    [data.selectTrace],
  );

  useEffect(() => {
    if (!playing || data.mode !== "replay" || data.events.length === 0) return;
    const timer = window.setInterval(
      () => {
        const next = data.state.replayIndex + 1;
        if (next >= data.events.length) setPlaying(false);
        else data.setReplayIndex(next);
      },
      Math.max(125, 1_000 / speed),
    );
    return () => window.clearInterval(timer);
  }, [
    data.events.length,
    data.mode,
    data.setReplayIndex,
    data.state.replayIndex,
    playing,
    speed,
  ]);

  return (
    <div className={`dashboard-shell ${presenter ? "presenter-active" : ""}`}>
      <a className="skip-link" href="#main-content">
        本文へ移動
      </a>
      <StatusBar
        healthState={data.healthState}
        botHealth={data.botHealth}
        streamState={data.streamState}
        streamMessage={data.streamMessage}
        run={selectedRun}
        mode={data.mode}
        presenter={presenter}
        onPresenter={() => setPresenter((value) => !value)}
      />
      {data.error !== undefined ? (
        <div className="error-banner" role="alert">
          <strong>観測性劣化</strong>
          <span>{data.error}</span>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void data.refresh()}
          >
            再接続
          </button>
        </div>
      ) : null}
      <main id="main-content" className="dashboard-main">
        <TraceList
          runs={data.runs}
          selectedTraceId={data.selectedTraceId}
          query={query}
          stage={stageFilter}
          status={statusFilter}
          onQuery={setQuery}
          onStage={setStageFilter}
          onStatus={setStatusFilter}
          onSelect={handleSelectTrace}
          onRefresh={data.refresh}
        />
        <section className="graph-panel" aria-labelledby="graph-heading">
          <div className="section-heading graph-heading">
            <div>
              <p className="eyebrow">DETERMINISTIC DAG</p>
              <h2 id="graph-heading">Brain Graph</h2>
            </div>
            <div className="graph-legend" aria-label="状態凡例">
              <span>
                <i className="legend-dot legend-running" />
                実行中
              </span>
              <span>
                <i className="legend-dot legend-failed" />
                失敗
              </span>
              <span>
                <i className="legend-dot legend-complete" />
                完了
              </span>
            </div>
          </div>
          {data.loading && data.runs.length === 0 ? (
            <div className="loading-state" role="status">
              実トレースを読み込んでいます…
            </div>
          ) : (
            <BrainGraphCanvas
              state={{
                ...data.state,
                spans: filteredSpans,
                results: filteredResults,
              }}
              onSelect={handleSelectSpan}
            />
          )}
          <div className="filter-summary" aria-live="polite">
            {stageFilter === undefined && statusFilter === undefined
              ? "すべてのノード"
              : `${stageFilter === undefined ? "すべて" : stageLabels[stageFilter]} · ${statusFilter === undefined ? "すべて" : statusLabels[statusFilter]}`}{" "}
            · {filteredSpans.length + filteredResults.length} nodes
          </div>
        </section>
        <div className="right-rail">
          <NodeInspector
            span={selectedSpan}
            results={data.state.results}
            presenter={presenter}
          />
          <NodeList
            spans={filteredSpans}
            results={filteredResults}
            selectedSpanId={data.state.selectedSpanId}
            onSelect={handleSelectSpan}
          />
        </div>
      </main>
      <section className="bottom-dock" aria-label="再生とタイムライン">
        <ReplayControls
          mode={data.mode}
          livePaused={data.livePaused}
          liveBufferedCount={data.liveBufferedCount}
          liveBufferOverflow={data.liveBufferOverflow}
          eventCount={data.events.length}
          replayIndex={data.state.replayIndex}
          eventTimestamp={
            data.state.replayIndex < 0
              ? undefined
              : data.events[data.state.replayIndex]?.timestamp
          }
          speed={speed}
          playing={playing}
          onMode={(mode) => {
            setPlaying(false);
            data.setMode(mode);
          }}
          onLivePaused={data.setLivePaused}
          onIndex={data.setReplayIndex}
          onSpeed={setSpeed}
          onPlaying={setPlaying}
        />
        <Timeline
          spans={filteredSpans}
          events={data.events}
          selectedSpanId={data.state.selectedSpanId}
          replayIndex={data.state.replayIndex}
          replayEnabled={data.mode === "replay"}
          onSelect={handleSelectSpan}
          onSeek={data.setReplayIndex}
        />
        {data.liveBufferOverflow ||
        data.hydrationIssue !== undefined ||
        data.state.gaps.length > 0 ||
        data.state.duplicateEvents > 0 ||
        data.streamIntegrity.gaps.length > 0 ||
        data.streamIntegrity.duplicateEventIds > 0 ||
        data.streamIntegrity.duplicateStreamIds > 0 ||
        data.streamIntegrity.outOfOrderStreamIds > 0 ? (
          <div className="integrity-banner" role="status">
            {data.liveBufferOverflow
              ? `Live buffer overflow: ${data.liveBufferedCount}件を保持。再開時に保存済みeventsから再構築します。`
              : null}
            {data.hydrationIssue === undefined
              ? null
              : ` ${data.hydrationIssue}`}
            {data.state.gaps.length > 0
              ? ` sequence gap ${data.state.gaps.map(({ from, to }) => `${from}–${to}`).join(", ")}`
              : null}
            {data.state.duplicateEvents > 0
              ? ` duplicate event ${data.state.duplicateEvents}`
              : null}
            {data.streamIntegrity.gaps.length > 0
              ? ` SSE stream gap ${data.streamIntegrity.gaps.map(({ from, to }) => `${from}–${to}`).join(", ")}`
              : null}
            {data.streamIntegrity.duplicateEventIds > 0
              ? ` SSE duplicate event ${data.streamIntegrity.duplicateEventIds}`
              : null}
            {data.streamIntegrity.duplicateStreamIds > 0
              ? ` SSE duplicate stream ${data.streamIntegrity.duplicateStreamIds}`
              : null}
            {data.streamIntegrity.outOfOrderStreamIds > 0
              ? ` SSE out-of-order ${data.streamIntegrity.outOfOrderStreamIds}`
              : null}
          </div>
        ) : null}
      </section>
      <PresenterMode
        active={presenter}
        mode={data.mode}
        span={presenterSpan}
        onClose={() => setPresenter(false)}
      />
    </div>
  );
}
