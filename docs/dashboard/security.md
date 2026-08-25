# ダッシュボードのセキュリティ

## 公開範囲

既定の bind 先は `127.0.0.1` です。`::1` と `localhost` も loopback として扱います。dashboard は bot 操作、Minecraft 管理、memory 編集、task 強制完了、tool 再実行の endpoint を提供しません。demo-safe、export、import は trace metadata / recorded bundle の管理に限定されます。

loopback 外へ bind する場合は `DASHBOARD_AUTH_TOKEN` が必須です。token は 32 文字以上でなければ設定 validation と server constructor が拒否します。token が設定されている場合は loopback でも認証を要求します。

## 認証

HTTP server は `Authorization: Bearer <token>` と Basic 認証の password を受け付けます。Basic の username は認証値として使わず、password と configured token を比較します。browser UIはBasic challengeで認証し、同一originの`fetch`と`EventSource`へbrowserの認証状態を引き継ぎます。比較は hash を使った timing-safe comparison です。token を URL、source、local storage、log、screen share、repository、Issue、PR に置きません。

## response と request の防御

- `Content-Security-Policy` は self の script / style / connect に限定し、object と frame ancestor を禁止
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Resource-Policy: same-origin`
- JSON は `Cache-Control: no-store`
- static path は static root 外へ traversal できないよう検査
- `/api/` は static fallback へ渡さない
- import JSON は 5 MiB を超えると拒否
- SSE は 2,000 event の backfill page と 1 MiB の writable buffer 上限を持ち、shutdown時はactive responseを閉じる
- CORS を無制限に許可しない

外部公開時は token だけに依存せず、HTTPS reverse proxy、network access control、運用上の閲覧者制限を併用します。

## trace 情報の制限

TraceService は保存前に text と attributes を sanitize します。blocked field name の attributes を落とし、文字列中の secret token、IPv4、UUID、座標表現を置換します。text は最大 1,000 文字、attributes は最大 100 entries です。trace contract に raw prompt、raw model response、会話全文、memory 本文、authorization header を保存する field はありません。

OpenAI 呼出しの trace は deliberation の構造化 summary、結果、duration / model latency / tool call metrics だけを扱います。非公開 chain-of-thought 全文を要求、推測、保存、表示しません。Inspector の `Raw (redacted DTO)` も redacted DTO の allowlist だけを表示します。

## Presenter export

demo-safe 化では `presenter-v1` redaction manifest を生成し、sensitive summary、attributes、内部参照、token metrics を bundle から除外します。export は demo-safe flag と manifest が両方存在する completed trace だけに許可されます。import は schema、version、event count、連続 sequence、trace ID、unique event ID、root completion、demo-safe flag、link先spanを検証し、全eventへserver redactionを再適用してserver自身のmanifestを保存します。

公開文書、Issue、PR、log summary、sample、screenshot、bundle に API key、token、Cookie、Minecraft username / UUID、server address、IP、world seed、私的座標、会話、LLM input / output、実 memory content、trace / session ID を残しません。fixture は架空の最小値に限定します。

## 観測性劣化時の扱い

trace の SQLite write、dashboard start、HTTP request、SSE subscriber に失敗した場合は、`observability` category の error と health `degraded` を記録します。TraceService は persistence を停止して主処理を二重実行せず、dashboard は `観測性劣化`、再接続、integrity gap を表示します。欠落した event や結果を推測して補いません。dashboard の failure は bot task failure として扱いません。
