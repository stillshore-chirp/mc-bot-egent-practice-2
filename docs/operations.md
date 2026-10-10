# 運用

## 設定と起動

Node.js 22.13以上を使います。`.env.example` を `.env.local` にコピーし、Minecraft接続、owner、OpenAI API key、persona、database pathを設定してから起動します。

```bash
npm ci
cp .env.example .env.local
npm run build
npm start
```

開発時は `npm run dev` を使います。`DATABASE_PATH` の親directoryは起動時に作られます。`MINECRAFT_USERNAME` と `OWNER_USERNAME` は異なるidentityにします。API keyと接続情報をGit、URL、ログへ含めません。

`DASHBOARD_ENABLED` は既定で有効です。loopbackの `DASHBOARD_HOST=127.0.0.1` と `DASHBOARD_PORT=4310` で管理画面を開けます。tokenの有無にかかわらずloopback以外へbindできず、reverse proxy経由の公開もサポートしません。`DASHBOARD_AUTH_TOKEN` はloopback画面のBearer認証に任意で使えます。設定時は32文字以上にし、URLやログへ含めません。詳細は [dashboard](dashboard.md) を参照してください。

接続には `CONNECT_TIMEOUT_MS` と `RECONNECT_*` の上限設定が適用されます。`MEMORY_CONTEXT_LIMIT` は各判断に渡す関連記憶の上限です。設定一覧は `.env.example` と [config schema](../src/config/schema.ts) が正本です。

## 停止と保存

`Ctrl-C` または `SIGTERM` で通常停止します。Applicationはチャット購読とRuntimeを止め、Minecraft接続を閉じ、最後にSQLite Storeを閉じます。停止ラッチは維持されます。ゲーム内の永続停止はowner chatの停止指示で行います。

## Database保全

Databaseを複製・移行する場合はBotを通常停止してから SQLite Online Backup API など整合性を保つ方法で取得します。稼働中のSQLite本体だけをコピーしません。復元先のcopyで `PRAGMA integrity_check` と停止状態・目標・記憶を確認してから運用へ使います。元Database、persona、worldは上書きせず、copy作業の結果を別保存先へ残します。

操作成功はdashboardやログの状態表示では確定しません。PlayerBodyの実結果とMinecraft側の観測を確認してください。
