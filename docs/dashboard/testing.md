# ダッシュボードのテスト

## テストの境界

dashboard の unit、integration、browser、visual test は、実装の契約と表示経路を検証します。test double、架空 trace、mock API route、固定時刻、visual snapshot は `tests/` の test 専用です。製品 build は fake Minecraft、fake OpenAI、fake stream、demo generator を含みません。

これらのテストは、実 Minecraft server、実 OpenAI API、実 world、実 account の到達性を証明しません。現行 latest HEAD の実 Minecraft + 実 OpenAI actual E2E は未実施です。過去の別 HEAD の pass や既存 log を今回の完了証跡へ繰り返し利用しません。

## ローカル command

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:visual
npm run audit:high
```

`build` は server の `tsc -p tsconfig.build.json` と dashboard の Vite build を連続して実行します。`typecheck` は server と `tsconfig.dashboard.json` を別々に検査します。

## Unit / integration

| 対象                      | 確認内容                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| trace contracts           | schema version、payload の型、status / event の整合性、bundle invariant                                                                                        |
| reducer / layout          | live / replay同一適用、future非表示、duplicate / gap解消、causal link / result、stage lane、150 / 500 node決定性                                               |
| redaction                 | blocked attributes、secret / address / UUID / position の置換、Presenter fields の除外、import時のserver再秘匿化                                               |
| TraceStore / TraceService | persist-before-publish、連続 sequence、duplicate / conflict、root completionだけでのrun終端、完了後追記拒否、link実在性、demo-safe export / import、主処理継続 |
| DashboardHttpServer       | trace list、SSE `Last-Event-ID` backfill、active SSE shutdown、loopback 外 auth、Basic auth、static / API 境界                                                 |
| runtime instrumentation   | context、memory、perception、deliberation、tool、skill、Minecraft action、verification、memory write、retry attempt / delay / `retry_of` の要約と redaction    |

integration test は in-memory SQLite、fake Minecraft、fake OpenAI、pino silent logger を使用します。実環境への接続情報は test data に入れません。

## Browser / visual

`npm run test:browser` は先にproduction dashboardをVite buildし、Node の Playwright runner と Chromium を使って検証します。通常画面はVite serverとtest専用routeを使い、別specではbuild済みassetを実`DashboardHttpServer`、CSP、Basic auth、実SSEと組み合わせます。現在の browser spec は次を確認します。

- persisted recorded trace の一覧、初期選択、node list の keyboard 移動、Inspector
- 同一 event data による Replay、Presenter の表示境界
- trace がない場合の空状態
- Live pause / bounded buffer / overflow再構築、SSE gap / duplicate / reconnect / `Last-Event-ID`
- demo-safe mark / export / import、Presenter fullscreen API
- WebGL 2未対応とcontext lost時の機能的な 2D fallback、renderer資源解放、hidden tabのRAF停止
- keyboard、axe critical 0、reduced motion、narrow width、200% text、2D fallback時の操作とaccessibility
- 150 / 500 nodes、1,000 events、UI反映budget
- UTC、固定DPR、固定clock、platform非依存名のfictional trace visual snapshot

visual snapshot は product data や実環境画面ではありません。Playwright の `test-results/`、`playwright-report/`、`blob-report/` は gitignore 対象です。visual baseline は test source と同じく、採用する場合の platform 差分を確認します。

GitHub Actions の Product quality workflow では、Node.js 22 / 24 の server・dashboard quality job に加えて、Node.js 24 の独立 browser job が `npm ci`、Chromium install、`npm run test:browser` を実行します。CI へ API key、Minecraft 接続情報、実 world を渡しません。

## 実環境 E2E

dashboard の actual E2E は、bot の既存 E2E preflight を通過した許可済み test world と実 OpenAI API を使い、現行 HEAD で別途実行します。最低限、次を同じ観測証跡で確認します。

```bash
npm run test:e2e:dashboard
```

専用の対話runnerは各操作後に保存済みrunをdashboard APIから読み、必要なstage、terminal status、resultの存在を自動照合します。Replay、Presenter、stream切断復帰は操作者が実画面で確認します。出力する証跡は件数、stage数、terminal有無に限定し、trace ID、summary、server address、player名、tokenを出力しません。

1. 日本語の会話だけを行う persisted trace
2. 保存済み記憶を検索して応答する trace
3. 原木収集、帰還、inventory / 距離検証、応答、記憶更新の trace
4. tool または skill の実 failure / retry 経路
5. 停止指示で cancelled になる trace
6. 危険検出で reflex が割り込む trace
7. 明示情報または検証済み結果を memory write する trace
8. 完了した実 trace の Replay、seek、step、speed
9. Presenter Mode の Recorded表示、redaction、fullscreen
10. live stream切断と復帰、`Last-Event-ID` backfill、gap表示

この実環境 E2E は現時点で未実施です。資格情報、許可、実 server、実 world、ネットワーク到達性が揃わない状態では開始しません。実行した場合も、Issue / PR / repository に実 log、ID、server address、player 情報、会話、memory 本文を保存しません。
