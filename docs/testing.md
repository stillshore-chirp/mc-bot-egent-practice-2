# テスト

このプロジェクトでは、test double による設計検証と、実 Minecraft・実 OpenAI API による受け入れ試験を分けます。前者の成功は後者の代替ではありません。

## ローカル品質確認

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:high
```

GitHub Actions の `Product quality` workflow は Node.js 22 と 24 のそれぞれで同じ command を実行します。`audit:high`はhigh / critical advisoryを品質gateにし、既知のmoderate認証依存はIssue #4で追跡します。CI は API key、Minecraft 接続情報、実 world を持たず、live E2E を起動しません。

## Unit test

Unit test は外部境界を fake に置換してよい範囲です。製品 build に test-only 実装を混入させません。

- environment schema と上限値、credential 不足時の fail-fast
- task status、優先順位、cancel、retry、timeout、checkpoint
- tool input validation、統一 failure detail、壊れた LLM tool input の拒否
- snapshot 比較、inventory 数量、success / failure 判定
- persona context の生成
- memory の保存、検索、訂正、撤回、重複、矛盾、commitment完了根拠

## Integration test

Integration test は実装された依存境界の契約を確認します。Minecraft server や OpenAI API の実アカウントは使いません。

- Mineflayer adapter と runtime の event / snapshot 契約
- tool から skill への schema 済み引数の伝達
- SQLite migration、transaction、再起動復元
- OpenAI Responses API の function-call output に対する validation
- Minecraft 観測イベントから reflexes への伝達
- 長時間 skill の cancellation と再開判断

## 実環境 E2E

`npm run test:e2e` は実 Minecraft Java Edition server と実 OpenAI API を対象にします。次の preflight が一つでも欠ける場合、Minecraft 接続や API 呼出しを開始せず、設定エラーとして失敗させます。

このcommandは対話式です。安全なtest world、botの接続、block破壊、危険・空腹の再現、process再起動、切断試験まで許可されたrunでだけ、`.env.local`の`LIVE_E2E_CONFIRMED`を`true`にします。既定値`false`では製品runtime moduleの読込み、外部接続、API呼出しより前に停止し、非対話CIでも実行しません。各項目はoperatorが実worldの画面と観測状態を確認して`pass`、`fail`、`skip`を記録し、全項目`pass`の場合だけ終了code 0になります。

1. `.env.local` に `MINECRAFT_HOST`、`MINECRAFT_USERNAME`、`OWNER_USERNAME`、`OPENAI_API_KEY` が設定され、port、auth、version、各上限値が validation を通る。
2. 対象 server と world、bot account、指定利用者、行動範囲、切断・再起動試験の許可が確認されている。
3. Mineflayer が対象 Minecraft version を直接サポートし、OpenAI model と Responses API の利用権限・ネットワーク到達性が確認されている。
4. 実験用の安全な場所に、食料、検出可能な危険、原木、帰還できる利用者が用意されている。実利用中の world や他者の資産に影響する試験は行わない。

preflight を通過したら、以下を同一の E2E run または追跡可能な一連の run で確認します。

1. bot が独立した player として接続する。
2. 指定利用者の日本語チャットを認識し、日本語で応答する。
3. 指定利用者を安全な距離で追従する。
4. 停止指示により移動または長時間作業が即時中断する。
5. 空腹時に食事する。
6. 指定利用者から明示された情報を記憶する。
7. process 再起動後にその記憶を復元する。
8. 指定種類・指定数の原木を収集する。
9. 依頼者の位置へ帰還する。
10. inventory の観測値に基づき完了数を報告する。
11. 資源不足、経路不達、timeout、cancel などの途中 failure を確認済み状態とともに正しく報告する。
12. 接続を失った後、設定された上限で復帰するか、明示的な停止状態へ遷移する。

各項目の成功は、LLM の出力、chat acknowledgement、command 受付だけで判断しません。Minecraft で観測した位置、health、food、inventory、task state、接続状態と、安全に要約した log / correlation ID を根拠にします。

runnerは項目7の前にapplicationをshutdownして同じSQLiteから再生成し、Minecraftへ再接続します。各入力後に、次の秘密を含まないmachine-readable JSON evidenceを取得します。

- 捕捉時刻とconnection managerの状態
- `connected / spawned`、health、food、oxygen、inventory総数
- 直近taskのkind、status、phase、failure code、correlation ID
- 原木収集taskの場合はresource名、依頼数、実収集数、最終所持数、依頼者との距離
- reflex state

このJSONはoperatorの画面確認を置き換えません。world座標、server address、player名、会話、memory本文、credentialを出力せず、各`pass / fail / skip`と実観測状態を同じ項目へ結び付ける監査補助です。

## E2E 証跡

Issue・PR・commit には API key、server address、IP、Minecraft username / UUID、world seed、座標、会話全文、memory 実内容、実ログ原文を載せません。次だけを一般化して記録します。

- 実行環境の区分と時間範囲
- 実行した受け入れ項目
- 観測した Pass / Fail と failure category
- 再試行の有無、停止・復帰の結果
- 未実行項目と理由

runnerのJSONを保存する場合は、repository外またはgit ignore済みの`logs/`へ置きます。Issue / PRには原文を貼らず、上記項目を一般化した要約だけを載せます。

実環境資格情報または許可がない場合は、`npm run test:e2e` を実行しません。未実施であることと残る risk を記録し、固定応答・模擬 Minecraft・模擬 LLM で E2E を代替しません。
