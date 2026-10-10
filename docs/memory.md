# 人格と記憶

人格設定は `PERSONA_PATH` のJSONから読み、コンパニオンの名前、話し方、価値観、行動原則、禁止事項を提供します。人格とownerとの関係は別の保存状態です。

`CompanionStore` は `DATABASE_PATH` のSQLiteに一つのruntime snapshot、意味検索用の記憶、owner/companion会話、Body結果の上限付きjournalを保存します。snapshotには停止ラッチ、目標、計画、次回判断時刻、進行中操作、直近結果、関係概要、関心が含まれます。記憶は種類、由来、状態、重要度、作成・更新時刻を持ちます。

起動時に既存DBを開く際、Storeは対象ownerの既存状態を新しいschemaへ取り込みます。`OWNER_USERNAME` をStoreへ渡し、別のownerの記憶を混在させません。移行前に既存DBとpersona設定を通常の停止後にバックアップしてください。入力DBを直接書き換える移行が失敗した場合、元ファイルを保全して原因を確認します。

Agentへ渡す記憶と会話は検索と件数で制限されます。ownerが明示した発言の証拠だけをowner発の記憶として扱い、モデルの推測を観測済み事実へ変換しません。journalは上限を持ち、生の会話を無制限に保管しません。

管理画面は現在の目標、記憶、履歴から安全な表示項目だけを読み出します。tokenやcredentialを記憶・画面へ出しません。運用手順は [operations](operations.md)、画面の認証は [dashboard](dashboard.md) を参照してください。
