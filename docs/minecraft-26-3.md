# Minecraft版変更と既存world保全

既存worldへ版変更を適用する前に、対象serverと永続データをread-onlyで相関し、別copyで復旧可能性と必要な操作を確認します。worldやDBの移動・起動・上書きは、それを含む依頼の範囲内で行います。既存環境のID、path、接続先、account、会話、secretを公開文書へ記録しません。

## 保全手順

1. server instance、実際の全dimension、server properties、plugin/configuration、owner playerdata、persona、`DATABASE_PATH`をread-onlyで対応づけます。対象が曖昧な場合は停止・copy・起動を保留します。
2. Botを通常停止し、その後serverを通常停止します。全writerが終了したことを確認してから整合したbackupを取得します。稼働中worldをファイル単位でコピーしません。
3. 全world directoryとserver設定・pluginを同じ時点のbackupへ保存します。SQLiteはOnline Backup APIなど整合性を保つ手段で取得し、DB本体・WAL・SHMを個別にコピーしません。人格JSONも保全します。
4. backupから別directoryへ復元し、worldのdimension、owner playerdata、SQLite integrity、停止状態、目標と記憶を確認します。original world/DBへcopyを昇格させません。
5. Paper/Minecraft、Mineflayer、protocol bridge、Java、各pluginの互換性を個別に確認します。protocol bridgeで接続できるclientとBotの直接protocol対応を同一視しません。
6. 起動後はserver listener、Bot接続、ownerの別identity、PlayerBody操作、server側の実状態、通常停止を別々に確認します。失敗時はcopy上で停止し、originalを保全します。

## 記録済みの限定結果

2026-10-04の記録では、複製環境でPaper 26.3 BETA build 143、Java 25、ViaVersion / ViaBackwards 5.12.0とMineflayer 4.39.0を組み合わせ、限定的な接続・保存構造の確認を行いました。これは全world、全plugin、全操作、長期安定性、現行HEADの実利用を証明しません。既存の配送記録は [Issue #126](https://github.com/stillshore-chirp/mc-bot-egent-practice-2/issues/126) と [PR #127](https://github.com/stillshore-chirp/mc-bot-egent-practice-2/pull/127) にあります。

本リポジトリの既定Mineflayer接続版は `MINECRAFT_VERSION=1.21.11` です。Mineflayerの依存版はlockfileが正本です。26.3 serverへの直接Bot接続と全PlayerBody操作の互換性を、この過去記録から推測しません。現在の製品検証境界は [testing](testing.md)、安全なcopy評価の考え方は [ai-player-e2e](ai-player-e2e.md) を参照してください。
