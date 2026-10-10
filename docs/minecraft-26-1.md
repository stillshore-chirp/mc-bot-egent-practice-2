# Minecraft 26.1 クライアント接続の歴史的記録

2026-09-21に、新規のローカルテストworldでMac版Minecraft Java 26.1クライアント、Paper 1.21.11、ViaVersion 5.12.0、本BotのMineflayer 4.37.1を組み合わせた限定確認を行いました。Botとowner clientの同時接続、日本語chat応答、owner stop、server切断時の有界reconnectを観測しました。実利用worldは変更していません。

この記録は旧実装と旧runnerの結果です。現行HEADの実ゲーム受け入れ、Minecraft 26.1 serverへの直接Bot接続、長期安定性を証明しません。現在のテスト範囲は [testing](testing.md)、実環境の確認境界は [ai-player-e2e](ai-player-e2e.md) を参照してください。
