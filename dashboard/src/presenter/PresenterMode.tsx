import { useEffect, useState } from "react";

import type { CognitiveTraceSpan } from "@trace";

import { stageLabels, statusLabels } from "../trace/labels";
import type { DashboardMode } from "../trace/use-dashboard";

interface PresenterModeProps {
  readonly active: boolean;
  readonly span?: CognitiveTraceSpan;
  readonly mode: DashboardMode;
  readonly onClose: () => void;
}

export function PresenterMode({
  active,
  span,
  mode,
  onClose,
}: PresenterModeProps) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!active) return;
    const update = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, [active]);
  if (!active) return null;
  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (document.fullscreenElement !== null) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      setFullscreen(document.fullscreenElement !== null);
    } catch {
      setFullscreen(false);
    }
  };
  // The display boundary is the active mode: a completed live trace can be
  // replayed, and that view must be labelled as recorded event playback.
  const isRecorded = mode === "replay";
  return (
    <section
      className="presenter-overlay"
      aria-labelledby="presenter-mode-heading"
    >
      <h2 id="presenter-mode-heading" className="sr-only">
        Presenter Mode
      </h2>
      <div className="presenter-topline">
        <span className="mode-chip">
          {isRecorded ? "Recorded real trace" : "Live real trace"}
        </span>
        <span className="presenter-caption">
          {isRecorded
            ? "実際に保存されたイベントだけを表示しています"
            : "接続中の実runから受信したイベントだけを表示しています"}
        </span>
      </div>
      <div className="presenter-stage" aria-live="polite">
        <p className="eyebrow">CURRENT STAGE</p>
        <h2>
          {span === undefined ? "イベントを待機中" : stageLabels[span.stage]}
        </h2>
        <p className="presenter-status">
          {span === undefined
            ? "選択されたノードはありません"
            : `${statusLabels[span.status]} · ${span.name}`}
        </p>
        <p className="presenter-summary">
          {span?.actualResult ??
            span?.summary ??
            "実トレースから結果が提供されると、ここに表示されます。"}
        </p>
      </div>
      <div className="presenter-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? "全画面を終了" : "全画面"}
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={onClose}
        >
          Presenter終了
        </button>
      </div>
      <p className="presenter-note">
        内部識別子、raw prompt、model response、記憶本文は表示しません。token
        metricは開発者向けRawだけに残し、Presenter Modeでは表示しません。
      </p>
    </section>
  );
}
