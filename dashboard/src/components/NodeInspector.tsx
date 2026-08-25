import type { CognitiveTraceResult, CognitiveTraceSpan } from "@trace";

import {
  formatDate,
  formatDuration,
  stageLabels,
  statusLabels,
  truncate,
} from "../trace/labels";

interface NodeInspectorProps {
  readonly span?: CognitiveTraceSpan;
  readonly results: readonly CognitiveTraceResult[];
  readonly presenter: boolean;
}

export function NodeInspector({
  span,
  results,
  presenter,
}: NodeInspectorProps) {
  if (span === undefined) {
    return (
      <section className="inspector-panel" aria-labelledby="inspector-heading">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">INSPECTOR</p>
            <h2 id="inspector-heading">ノード詳細</h2>
          </div>
        </div>
        <p className="empty-copy">
          ノードを選択すると、実イベントに基づく詳細が表示されます。
        </p>
      </section>
    );
  }
  const related = results.filter((result) => result.spanId === span.spanId);
  const redactedDto = toRedactedDto(span);
  return (
    <section className="inspector-panel" aria-labelledby="inspector-heading">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">INSPECTOR</p>
          <h2 id="inspector-heading">ノード詳細</h2>
        </div>
        <span className={`status-label status-${span.status}`}>
          {statusLabels[span.status]}
        </span>
      </div>
      <div className="inspector-title">
        <span className="stage-kicker">{stageLabels[span.stage]}</span>
        <h3>{span.name}</h3>
        <p>{span.summary ?? "判断要約なし"}</p>
      </div>
      <div
        className="inspector-section"
        aria-labelledby="inspector-overview-heading"
      >
        <h3
          id="inspector-overview-heading"
          className="inspector-section-heading"
        >
          Overview
        </h3>
        <dl className="detail-grid">
          <Detail label="段階" value={stageLabels[span.stage]} />
          <Detail label="状態" value={statusLabels[span.status]} />
          <Detail label="開始" value={formatDate(span.startedAt)} />
          <Detail label="終了" value={formatDate(span.endedAt)} />
          <Detail
            label="所要時間"
            value={formatDuration(span.startedAt, span.endedAt)}
          />
          <Detail
            label="sequence"
            value={presenter ? "非表示" : String(span.sequence)}
          />
        </dl>
      </div>
      <details
        className="inspector-section inspector-disclosure"
        open={!presenter}
      >
        <summary>Expanded</summary>
        <dl className="detail-grid">
          <Detail
            label="判断要約"
            value={truncate(span.decisionSummary ?? "判断要約なし", 240)}
          />
          <Detail label="期待結果" value={truncate(span.expectedResult, 240)} />
          <Detail label="実際の結果" value={truncate(span.actualResult, 240)} />
          <Detail
            label="検証結果"
            value={truncate(span.verificationResult, 240)}
          />
          <Detail label="エラー" value={span.errorCode ?? "なし"} />
          <Detail
            label="再試行"
            value={
              span.retryCount === undefined ? "なし" : String(span.retryCount)
            }
          />
        </dl>
        {!presenter && span.attributes !== undefined ? (
          <div className="result-block">
            <h3>redacted attributes</h3>
            <dl className="attribute-list">
              {Object.entries(span.attributes).map(([key, value]) => (
                <Detail
                  key={key}
                  label={key}
                  value={value === null ? "null" : String(value)}
                />
              ))}
            </dl>
          </div>
        ) : null}
      </details>
      {related.length > 0 ? (
        <div className="result-block">
          <h3>関連結果</h3>
          {related.map((result) => (
            <article className="result-card" key={result.resultId}>
              <span>{result.kind}</span>
              <p>{result.summary}</p>
              {result.verificationSummary ? (
                <small>{result.verificationSummary}</small>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {!presenter ? (
        <details className="inspector-section inspector-disclosure">
          <summary>Raw (redacted DTO)</summary>
          <pre className="redacted-dto">
            {JSON.stringify(redactedDto, null, 2)}
          </pre>
          <p className="presenter-note">
            raw prompt、model response、記憶本文は保存していません。token
            metricは開発者向けRawだけに残し、Presenter Modeでは表示しません。
          </p>
        </details>
      ) : null}
      {presenter ? (
        <p className="presenter-note">
          Presenter Modeでは内部識別子、raw prompt、model
          response、記憶本文、token metricを表示しません。
        </p>
      ) : null}
    </section>
  );
}

function toRedactedDto(span: CognitiveTraceSpan): Record<string, unknown> {
  return {
    schemaVersion: span.schemaVersion,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    sequence: span.sequence,
    stage: span.stage,
    name: span.name,
    status: span.status,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    summary: span.summary,
    decisionSummary: span.decisionSummary,
    expectedResult: span.expectedResult,
    actualResult: span.actualResult,
    verificationResult: span.verificationResult,
    errorCode: span.errorCode,
    retryCount: span.retryCount,
    metrics: span.metrics,
    sensitivity: span.sensitivity,
  };
}

function Detail({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
