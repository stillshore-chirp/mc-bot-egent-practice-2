# 管理画面

起動中の read-only 管理画面は、コンパニオンの接続、現在の目標と操作、記憶、LLM利用量、最近のエラーを表示します。データは現在の `ConnectionManager`、`CompanionRuntime`、`CompanionStore` から取得します。ゲーム内操作、設定変更、trace保存、replayはありません。

既定の接続先は `http://127.0.0.1:4310/` です。`DASHBOARD_ENABLED=false` で無効化できます。管理画面はloopback interfaceにのみbindでき、`DASHBOARD_AUTH_TOKEN` を設定してもLAN interfaceへの公開は拒否します。tokenは任意で、設定する場合は32文字以上にしてください。状態データは保護されたAPIから取得し、tokenは `Authorization: Bearer` headerで送ります。画面を閉じるとtokenは破棄されます。tokenをURL、query string、ログ、共有画面へ含めないでください。

画面の記憶・エラー・目標は、ゲーム内での達成証明ではありません。操作の成功は [PlayerBodyの実結果](player-body.md) とMinecraft側の観測で判断します。LLM使用量はResponses APIが返したtoken件数の累積です。usageを返さない応答がある場合、token総数は不完全として扱われます。
