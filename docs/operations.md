# 運用

この文書は、安全な起動、停止、再起動、ログ確認、SQLite の保全、障害切り分けを定めます。実 server、bot account、OpenAI API を操作する前に、対象と許可された影響範囲を確認してください。

## 起動前の確認

1. Node.js 24 を推奨します。Node.js 22 以上が必要です。
2. `npm ci` を実行し、`npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build` を確認します。
3. `.env.example` を `.env.local` へコピーし、実値は `.env.local` だけに保存します。
4. `MINECRAFT_HOST`、`MINECRAFT_USERNAME`、`OWNER_USERNAME`、`OPENAI_API_KEY`、必要な connection / limit 設定を確認します。値を terminal、log、Issue、PR に表示しません。
5. 対象 Minecraft server、world、bot account、指定利用者、ブロック破壊・採取・移動・切断試験の許可範囲を確認します。

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

停止はprocessに通常のinterruptを送ります。graceful shutdownが、進行中taskの`suspended`遷移とcheckpoint、SQLiteの確定、接続の安全な切断を終えてから終了することを確認します。強制終了した場合も、次回起動時に`running`を`suspended`へ変更し、taskをcompletedと扱わず、保存されたcheckpointとMinecraftの観測状態からread-onlyで再評価します。再開にはownerの新しい明示指示が必要です。

## ログ確認

各依頼には相関IDを付け、接続、観測、path、resource、inventory、authorization / permission、timeout、cancelled、LLM、persistence、safety、validation、internalのfailure categoryを確認します。相関IDはOpenAI呼出し、同じasync実行範囲のtool / skill / Minecraftログ、SQLiteのtask inputとterminal Episodeへ引き継ぎます。

ログは構造化し、API key、Minecraft host、bot / owner username、会話全文、memory 本文を redact します。障害を共有するときは、相関 ID、環境区分、時刻範囲、failure category、確認済み状態、再試行結果だけを安全に要約します。

## SQLite のバックアップと復元確認

`DATABASE_PATH` は既定で `data/companion.sqlite` です。backup は、bot を停止した後に SQLite の backup API または `sqlite3` の `.backup` を使って整合した copy を作成します。WAL 使用中の database file を単純 copy で保全する手順は採用しません。

```bash
sqlite3 data/companion.sqlite ".backup 'backups/companion-YYYYMMDD.sqlite'"
```

復元確認は本番 database を上書きしない一時領域で行います。migration、人格設定、利用者情報、場所、約束、直近の task result が再起動後に読めることを確認し、未完了 task が success 扱いにならないことを確認します。

## 障害切り分け

| 症状                 | 最初に確認すること                                       | 扱い                                                            |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| 起動直後の設定エラー | 必須環境変数、数値上限、persona path                     | 値を表示せず field 名だけで修正する                             |
| Minecraft 接続失敗   | server の稼働、version、auth、接続許可                   | 設定上限後はconnection stateを`failed`にし、安全なlogで報告する |
| OpenAI failure       | API 利用権限、network、model、failure category           | credential を log に出さず、自然文の推測実行をしない            |
| 操作が拒否される     | `OWNER_USERNAME`、権限、不可逆操作の明示依頼             | 会話参加と操作権限を混同しない                                  |
| 移動・採取が失敗する | snapshot、path、resource、inventory、timeout、retry 回数 | 観測した state と次に可能な行動を報告する                       |
| 記憶が復元しない     | database path、migration、shutdown、backup の整合性      | 実 record を外部へ転載せず、persistence failure として扱う      |

server 再起動、world の変更、bot 操作、memory の修正、rollback、credential の変更は、対象と影響を示した明示的な運用判断の後にだけ実施します。

接続が復旧した場合は、再取得したsnapshotをruntime再評価へ渡してMinecraft chatへ結果を返します。再接続上限へ到達した場合はchat transport自体が利用できないため、`RECONNECT_RETRY_EXHAUSTED`と`connectionState=failed`をローカルの構造化logまたはlive E2E evidenceで確認します。未送信のchat報告を送信済みとして扱いません。

## 実環境受け入れ

実 Minecraft と実 OpenAI API の E2E 手順・事前条件・証跡境界は [testing.md](testing.md#実環境-e2e) を正本とします。資格情報または server 操作の許可がないときは、実 E2E を未実施として記録し、模擬環境の結果を置き換えません。
