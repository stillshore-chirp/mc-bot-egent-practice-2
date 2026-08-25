# ダッシュボード運用

## 起動

設定名と既定値は `.env.example` が正本です。実値は `.env.local` だけに保存します。

```bash
npm ci
cp .env.example .env.local
npm run build
npm run dev
```

既定の dashboard URL は loopback の `http://127.0.0.1:4310` です。build 済み server を使う場合は `npm run build && npm start` を実行します。UI だけを確認する場合は `npm run dev:dashboard` を使いますが、これは bot の HTTP API を起動しません。

主な dashboard 設定は次のとおりです。

| 設定                   | 既定値           | 運用上の意味                          |
| ---------------------- | ---------------- | ------------------------------------- |
| `DASHBOARD_ENABLED`    | `true`           | dashboard server の有効化             |
| `DASHBOARD_HOST`       | `127.0.0.1`      | bind 先。loopback 外は認証必須        |
| `DASHBOARD_PORT`       | `4310`           | HTTP port                             |
| `DASHBOARD_STATIC_DIR` | `dashboard/dist` | Vite build の配信先                   |
| `DASHBOARD_AUTH_TOKEN` | 空欄             | 32 文字以上の Bearer / Basic password |
| `TRACE_RETENTION_DAYS` | `30`             | 未 demo-safe trace の age 上限        |
| `TRACE_MAX_RUNS`       | `500`            | 未 demo-safe trace の件数上限         |

token 認証を有効にした画面は、browser の Basic 認証challengeから開きます。username は表示上の任意値、password は `DASHBOARD_AUTH_TOKEN` です。一度認証された同一originの `fetch` と `EventSource` にbrowserが資格情報を引き継ぐため、tokenをURL、query、frontend source、local storageへ埋め込みません。Bearer認証はAPI client向けです。

## 停止と再起動

通常の interrupt で process を graceful shutdown します。dashboard server の停止、memory close、trace store close は application の shutdown sequence に従います。停止時は接続中のSSE responseとkeepaliveを先に閉じるため、閲覧中のbrowserがあってもHTTP serverの終了を待ち続けません。dashboard の停止は bot の task を強制完了・cancel しません。

再起動時は同じ SQLite database path を使います。TraceStore は migration を確認し、起動時に未 demo-safe trace の retention を実行します。demo-safe trace は再利用できる recorded data として retention の削除対象から除外されます。

## HTTP surface

| Method / path                             | 用途                                                   |
| ----------------------------------------- | ------------------------------------------------------ |
| `GET /api/dashboard/health`               | observability health と bot health の取得              |
| `GET /api/traces`                         | trace list                                             |
| `GET /api/traces/:traceId`                | detail の run / spans / links / results                |
| `GET /api/traces/:traceId/events?after=N` | trace sequence の続き                                  |
| `GET /api/spans/:spanId`                  | 単一 span の取得                                       |
| `GET /api/stream`                         | SSE live stream                                        |
| `POST /api/traces/:traceId/demo-safe`     | completed trace の Presenter redaction / metadata 更新 |
| `GET /api/traces/:traceId/export`         | demo-safe bundle の取得                                |
| `POST /api/traces/import`                 | demo-safe recorded bundle の検証・取り込み             |

これらは観測と recorded bundle の管理だけを行い、bot、Minecraft、memory、task を操作する endpoint はありません。

## retention と bundle

server start 時に `TRACE_RETENTION_DAYS` と `TRACE_MAX_RUNS` を使って retention を実行します。削除対象は `demo_safe = 0` の trace だけです。期限超過分と、最新上限を超えた古い未 demo-safe trace を transaction 内で削除します。foreign key cascade により関連 span、event、link、result、manifest も trace と同じ lifecycle になります。

export は terminal status、endedAt、persisted event count の一致、redaction manifest を要求します。import は 5 MiB、schema version、demo-safe、event count、連続 sequence、root completion、同一trace内に実在するlink先を検証し、server側で `presenter-v1` redactionを再適用してから `source: recorded` で保存します。持ち込まれたmanifestやdemo-safe flagだけを信頼しません。JSON の内容を編集して成功へ変える処理はありません。

## 障害切り分け

| 表示・症状                | 観測する場所                             | 扱い                                                                      |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `API未接続` / `API確認中` | `/api/dashboard/health`、application log | dashboard API / process を確認し、bot の task 結果を推測しない            |
| `再接続中` / `切断`       | `/api/stream`、browser status            | SSE と `Last-Event-ID` を確認し、保存済み events を基準にする             |
| `観測性劣化`              | TraceService health、integrity banner    | gap / duplicate / persistence error を表示し、bot task failure とは分ける |
| 2D fallback               | WebGL 2、scene init、context lost status | DOM node list、Inspector、Timeline を使い続ける                           |
| export 拒否               | demo-safe status、event count、manifest  | redaction を再確認し、未 redaction bundle を公開しない                    |
| trace がない              | trace list の空状態                      | 架空 run を追加せず、bot が依頼を処理した後の persisted trace を待つ      |

error summary を共有するときは、error code、環境区分、時刻範囲だけを一般化します。token、server address、player 情報、会話、memory 本文、trace ID を log summary や Issue に転載しません。

## 実環境の到達性

この文書の起動確認、typecheck、build、browser fixture は、実 Minecraft server と実 OpenAI API の到達性を示しません。現行 latest HEAD の実 Minecraft + 実 OpenAI dashboard E2E は未実施であり、過去の別 HEAD の証跡を現在の完了根拠へ使いません。
