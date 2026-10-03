# 運用

この文書は、安全な起動、停止、再起動、ログ確認、SQLite の保全、障害切り分けを定めます。実 server、bot account、OpenAI API を操作する前に、対象と許可された影響範囲を確認してください。

## 起動前の確認

1. Node.js 24 を推奨します。Node.js 22.13.0 以上が必要です。
2. `npm ci` を実行し、`npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build` を確認します。
3. `.env.example` を `.env.local` へコピーし、実値は `.env.local` だけに保存します。
4. `MINECRAFT_HOST`、`MINECRAFT_USERNAME`、`OWNER_USERNAME`、`OPENAI_API_KEY`、必要な connection / limit 設定を確認します。値を terminal、log、Issue、PR に表示しません。
5. 対象 Minecraft server、world、bot account、指定利用者、ブロック破壊・採取・移動・切断試験の許可範囲を確認します。

ローカルプレイでは、Bot の起動前に次の読み取り専用チェックを実行します。`--server-dir` は今回遊ぶ **ローカルサーバーのディレクトリだけ**を指定し、期待するモードと難易度は毎回明示します。このコマンドは server、world、権限を変更せず、接続もしません。

```bash
npm run preflight:local -- --server-dir <ローカルサーバーのディレクトリ> --expected-mode survival --expected-difficulty normal
```

結果は接続先と待受がともに loopback か、ポートが一致するか、サーバー既定のゲームモード・難易度、既定モードの強制有無、指定利用者の**保存済み**モードと OP 権限を別々に示します。利用者名、UUID、接続先、認証値は表示しません。保存済みプレイヤーデータがない場合は `unknown` とし、接続中の変更は保存データへまだ反映されていない可能性があります。現在の利用者モードとコマンド権限は、接続後に本人のゲーム画面と許可されたコマンドの成否で確認します。ハート・空腹表示とクリエイティブ用インベントリなどを確認し、判断が曖昧ならサーバー管理者がその利用者の状態を確認してください。既定値だけで個人の現在値を断定しません。

`survival` でも難易度が `peaceful` なら敵対 Mob は自然出現しません。期待値と異なる場合、チェックは終了コード 1 で知らせます。ローカル専用判定またはポート照合が不一致なら接続先を確認するまで Bot を起動しません。共有・公開サーバーに対して、この手順から OP 付与、認証方式変更、ゲーム設定変更を行いません。

設定を変える場合は、対象を先に選びます。本人だけのモードなら管理者が対象プレイヤーを指定して `/gamemode survival <対象プレイヤー>` を使い、再接続後も本人の画面で確認します。コマンド権限が必要なら今回のローカルサーバーで対象プレイヤーだけを OP にし、不要になれば解除します。難易度はサーバー全体へ及ぶため、他のプレイヤーがいないことと対象 world を確認してから管理者が `/difficulty normal` を実行し、ゲーム内の敵対 Mob 条件を確認します。既定モードや `force-gamemode` を変更する場合だけ、対象サーバーの `server.properties` を編集します。認証を緩めて権限問題を解消しません。

サーバー全体の変更・再起動前には、対象プロセスと world を確認し、Bot を通常停止して接続を切り、server を正常停止します。world と `server.properties`・`ops.json` を復元可能な場所へバックアップし、選んだ対象だけ変更して起動します。再起動後に同じチェックを再実行し、本人と Bot の接続・チャット・モード・難易度をゲーム内で確認します。失敗時は Bot と server を正常停止し、対象のバックアップから復元して旧設定で再起動・再接続を確認します。既存の別 server や world へ OP 設定を転用しません。

設定が不足・不正な場合は、起動処理が Minecraft 接続や OpenAI API 呼出しを行う前に停止する必要があります。認証失敗を offline mode や固定応答へ自動的に切り替える運用は行いません。

## 起動と停止

開発時は次を使います。

```bash
npm run dev
```

build 済みの成果物を使う場合は次を使います。

```bash
npm run build
npm start
```

### ゲーム内の停止とプロセス終了

ゲーム内のowner停止は、既定PlayerRuntimeの停止ラッチを先にSQLiteへ保存し、思考とBodyを止めます。この停止は再接続やプロセス再起動でも残り、ownerの明示再開で解除します。

プロセスを終了する場合は通常のinterruptを使います。既定applicationはRuntimeと接続を止め、dashboard・trace・skills・mind・memoryの順に終了処理を行います。異常終了後は、保存済みactiveOperationをreceiptと照合し、一致する結果がなければ `unverified` として次の判断へ渡します。停止ラッチがない場合は自律判断を再開するので、再起動だけを永続停止の代わりにしないでください。

旧 `TaskRuntime` の `running → suspended` とcheckpointによる復元は、明示的に起動した[legacy経路](architecture.md#旧toolruntime経路の詳細)の契約です。

## ログ確認

既定経路では、`category=llm` / `purpose=player_agent` のround・使用量・時間と、`player_runtime`、`player_memory`等の固定codeを確認します。会話/目的thoughtのtrace、Body結果、MindStoreのeventとSkill receiptは別の観測先です。traceの成功だけでMinecraft操作成功と判断しません。

具体的な「症状 → 観測項目 → コード → テスト」の対応は[評価と原因調査](testing.md#3-返事はしたが依頼を達成しないを辿る)を参照してください。旧tool/skillの相関ID・failure categoryはlegacy用の観測として区別します。

障害を共有するときは、対象commit、環境区分、時刻範囲、固定code、結果分類、確認済み状態、未確認事項だけを安全に要約します。API key、接続先、player名、会話全文、記憶本文、追跡可能な実ID、原logをIssue/PRへ載せません。redaction済み出力でも、任意の自由文が公開可能とは限りません。

## SQLite のバックアップと復元確認

`DATABASE_PATH` は既定で `data/companion.sqlite` です。backup は、bot を停止した後に SQLite の backup API または `sqlite3` の `.backup` を使って整合した copy を作成します。WAL 使用中の database file を単純 copy で保全する手順は採用しません。

```bash
sqlite3 data/companion.sqlite ".backup 'backups/companion-YYYYMMDD.sqlite'"
```

復元確認は本番 database を上書きしない一時領域で行います。persona設定とDBの組合せ、MindStoreのgoal・提案・停止・直近結果、MemoryStoreのepisode、Skillの版・receiptを確認します。旧経路を使う場合は場所・約束・task checkpointも確認します。未完了操作を未観測の成功にしないことを確かめます。

## 障害切り分け

| 症状                 | 最初に確認すること                                       | 扱い                                                            |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| 起動直後の設定エラー | 必須環境変数、数値上限、persona path                     | 値を表示せず field 名だけで修正する                             |
| Minecraft 接続失敗   | server の稼働、version、auth、接続許可                   | 設定上限後はconnection stateを`failed`にし、安全なlogで報告する |
| OpenAI failure       | API 利用権限、network、model、failure category           | credential を log に出さず、自然文の推測実行をしない            |
| 操作が拒否される     | owner照合、停止状態、入力schema、server権限              | 会話参加と操作権限を混同しない                                  |
| 移動・採取が失敗する | snapshot、path、resource、inventory、timeout、retry 回数 | 観測した state と次に可能な行動を報告する                       |
| 記憶が復元しない     | database path、migration、shutdown、backup の整合性      | 実 record を外部へ転載せず、persistence failure として扱う      |

server 再起動、world の変更、bot 操作、memory の修正、rollback、credential の変更は、対象と影響を示した明示的な運用判断の後にだけ実施します。

既定Playerは接続復旧eventと新しい観測から目的を再評価します。旧helperには再接続結果をchatで報告する経路もありますが、既定Playerの全再接続で同じ定型報告が出るとは限りません。再接続上限へ到達した場合はchat transport自体が利用できないため、`RECONNECT_RETRY_EXHAUSTED`と`connectionState=failed`をローカルの構造化logまたはlive E2E evidenceで確認します。未送信のchat報告を送信済みとして扱いません。

## 実環境受け入れ

実 Minecraft と実 OpenAI API の E2E 手順・事前条件・証跡境界は [testing.md](testing.md#実環境-e2e) を正本とします。現行Playerのcase別記録は[AIプレイヤーE2E](ai-player-e2e.md)、旧経路の歴史的記録は [2026-08-25実施結果](testing.md#2026-08-25-実施結果) にあります。資格情報または server 操作の許可がないときは、実 E2E を未実施として記録し、模擬環境の結果を置き換えません。

26.1クライアントと1.21.11サーバーを併用する場合は、[26.1検証手順](minecraft-26-1.md)でサーバー側ViaVersionとBot側の接続版を分けて確認します。既存サーバーへ適用する際は、サーバーを停止し、worldと設定・plugin一式の復元可能なバックアップを作成してから、保守時間内にpluginを適用して再起動します。接続・chat・停止・切断の確認で問題が出たら停止し、バックアップからpluginと設定を戻して旧構成で起動・接続確認します。このリポジトリから実利用サーバーへの適用は行っていません。
