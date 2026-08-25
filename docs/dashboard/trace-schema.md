# トレーススキーマ

## バージョンと構成要素

現在の `TRACE_SCHEMA_VERSION` は `1` です。runtime と dashboard は次の型を共有します。

- `CognitiveTraceRun`: 一つの依頼から応答までの root metadata
- `CognitiveTraceSpan`: 処理 stage の状態、summary、結果、検証、metrics
- `CognitiveTraceEvent`: span 状態、result、link、completion を順序付きで伝える envelope
- `CognitiveTraceLink`: span 間の因果・親子関係
- `CognitiveTraceResult`: tool、skill、Minecraft state、verification、memory、response の結果 summary
- `CognitiveTraceBundle`: demo-safe export / import の記録形式

## Stage

定義済み stage は `request`、`perception`、`memory_read`、`context`、`deliberation`、`plan`、`tool`、`skill`、`minecraft_action`、`verification`、`memory_write`、`response`、`reflex`、`cancellation`、`recovery`、`system` です。

実装済みの計測点だけが span を作ります。`plan` など schema に存在する stage は、対応する実処理が記録された場合にだけ表示されます。画面を埋めるための架空 node は生成しません。

## Run / span / result

| 型     | 主なフィールド                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run    | `traceId`、`rootSpanId`、`status`、`requestSummary`、開始・終了時刻、`lastSequence`、`eventCount`、`demoSafe`、`source` (`live` / `recorded`)                          |
| Span   | `spanId`、`parentSpanId`、`sequence`、`stage`、`name`、`status`、summary、decision / expected / actual / verification result、error、retry、参照、metrics、sensitivity |
| Result | `resultId`、関連 `spanId`、`kind`、summary、verification summary、sensitivity                                                                                          |
| Link   | `parent`、`caused_by`、`retry_of`、`verifies`、`reads_memory`、`writes_memory`、`interrupts`、`resumes` と source / target span ID                                     |

status は `queued`、`running`、`waiting`、`succeeded`、`failed`、`cancelled`、`skipped` です。UI は status を文字、記号、色、node 表現の組み合わせで表示します。

result kind は `selected_tool`、`tool_result`、`skill_result`、`minecraft_state_delta`、`verification_result`、`memory_update_result`、`final_response` です。

## Event の整合性

event type は `span.queued`、`span.started`、`span.progress`、`span.waiting`、`span.succeeded`、`span.failed`、`span.cancelled`、`span.skipped`、`result.created`、`link.created`、`trace.completed` です。

- span event は同じ trace / span の snapshot を持ち、event type と span status が一致します。
- `span.progress` だけが `progress` 値を持ち、値は 0 以上 1 以下です。
- result / link event は対応する payload だけを持ち、関連 ID が一致します。
- `trace.completed` は parent のない root span の terminal status を要求します。
- run のterminal statusと`endedAt`は末尾のroot `trace.completed`でだけ確定します。root spanのterminal eventだけが保存され、completion前にprocessが停止したrunは実行完了として表示しません。
- `trace.completed` の保存後は同じtraceへのevent追記を拒否します。
- Store は trace ごとに sequence を 1 から連続させ、欠落 sequence を拒否します。
- 同じ `eventId` の同一内容は同じ保存 event を返し、異なる内容で再利用すると conflict になります。
- link は同じtraceに保存済みのsource / target spanだけを参照できます。実在しないnodeへのedgeは保存しません。
- SQLite の autoincrement `stream_id` は SSE の `Last-Event-ID` に使われます。これは trace sequence と別の配信順 ID です。

汎用retry自体は成功を推測しません。実skillまたはMinecraft接続から呼ばれた各attemptを`recovery` spanとして記録し、失敗attemptには`willRetry`と予定delay、次attemptには前attemptを指す`retry_of` linkを保存します。delay中にcancelされた場合も、記録値は実際に予定されたdelayとして扱います。

bundle では schema version、trace、redaction manifest の version を一致させ、event count、trace ID、連続 sequence、unique event ID、末尾の root `trace.completed` を検証します。bundle の event 数は最大 10,000、import request は HTTP server 側で 5 MiB までです。

## 保存先

TraceStore は SQLite の WAL、foreign key、busy timeout を有効にし、次の tables を migration version 1 で作成します。

- `trace_runs`: run metadata と demo-safe / source
- `trace_spans`: span snapshot
- `trace_events`: event JSON、trace sequence、配信 `stream_id`
- `trace_links`: causal link
- `trace_results`: result summary
- `trace_redaction_manifests`: Presenter redaction policy

保存順序は event を SQLite に確定してから Live subscriber へ配信する順です。schema、sequence、root completion、event payload の検証に失敗した event は表示済みとして配信しません。

## 情報境界

span の text は構造化 summary、判断要約、期待結果、実行結果、検証結果です。Raw prompt、raw model response、token stream、非公開 chain-of-thought 全文を schema の表示対象にしません。sensitivity は `public`、`internal`、`sensitive` のいずれかで、Presenter export では redaction manifest に従ってさらに fields を削除します。
