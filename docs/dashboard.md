# 観測ダッシュボード

観測ダッシュボードは、AI コンパニオンの runtime が発行した型付き trace を、ブラウザで確認するための機能です。trace、span、event、result の実データを使って、処理段階、実行結果、検証結果、エラー、Live 接続状態を表示します。

bot、Minecraft、memory、task を操作する API はありません。Presenter 用 metadata の demo-safe 化、export、import は dashboard の記録を扱う操作ですが、bot の実行状態や Minecraft の世界を変更しません。

## ローカル起動

```bash
npm ci
cp .env.example .env.local
npm run build
npm run dev
```

既定では loopback の `http://127.0.0.1:4310` を開きます。`npm run build` が dashboard の Vite 出力を生成し、bot と同じ Node.js プロセスの `DashboardHttpServer` が静的ファイルと API を配信します。UI だけを開発する場合は `npm run dev:dashboard` を使えますが、bot API は別途必要です。

設定、認証、retention、障害時の扱いは [運用](dashboard/operations.md) と [セキュリティ](dashboard/security.md) を参照してください。

## 実装済みの表示

- Three.js / WebGL 2 の 3D DAG、処理ノード一覧、Inspector、Timeline
- SSE による Live event stream と `Last-Event-ID` backfill
- 保存済み trace の Replay、再生・一時停止・seek・速度変更
- `Recorded real trace` を明示する Presenter Mode と全画面表示
- WebGL 2 が利用できない場合、scene 初期化失敗時、context lost 時の機能的な 2D SVG fallback
- keyboard 操作、DOM の node list、`prefers-reduced-motion` 対応
- demo-safe 化済み trace の export と、検証済み bundle の import
- trace がない場合の空状態と、API / stream / persistence の観測性劣化表示

製品実行経路は起動時に架空 trace、fake stream、固定成功結果を生成しません。架空 fixture、mock API、visual snapshot は `tests/` に限定されています。

## 現在の検証境界

現行 latest HEAD について、実 Minecraft server と実 OpenAI API を同時に使う dashboard の実環境 E2E は未実施です。過去の別 HEAD の E2E pass、ローカル test world、既存 log、Issue の証跡は、現行 dashboard / trace 実装の完了証跡として扱いません。

browser E2E と visual test は架空の最小 fixture を使うため、実 Minecraft / 実 OpenAI の到達性を証明しません。テスト範囲と未実施項目は [ダッシュボードのテスト](dashboard/testing.md) に記載します。

## 詳細文書

| 文書                                           | 内容                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| [アーキテクチャ](dashboard/architecture.md)    | runtime、TraceService、SQLite、HTTP、React の境界とデータフロー |
| [トレーススキーマ](dashboard/trace-schema.md)  | run、span、event、link、result、bundle、永続化整合性            |
| [ビジュアル言語](dashboard/visual-language.md) | 3D / 2D graph、node、result、状態、色、pulse、fallback          |
| [Replay](dashboard/replay.md)                  | Live / Replay の reducer、SSE backfill、再生操作                |
| [Presenter Mode](dashboard/presenter-mode.md)  | 表示制限、demo-safe、export / import                            |
| [セキュリティ](dashboard/security.md)          | loopback、token、HTTP headers、redaction、公開境界              |
| [テスト](dashboard/testing.md)                 | unit、integration、browser、visual、実環境 E2E の境界           |
| [運用](dashboard/operations.md)                | 起動、停止、retention、障害切り分け、公開手順                   |

Raw chain-of-thought 全文は要求、推測、保存、表示しません。画面と bundle は構造化 summary、検証結果、状態など、実装が外部化した情報だけを扱います。
