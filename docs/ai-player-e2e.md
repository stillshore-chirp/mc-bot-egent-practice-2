# 実Minecraftでの確認

この文書は現行の確認範囲と証拠境界を示します。過去のE2E runner、tool/skill runtime、trace artifactは削除済みで、過去runの結果は現行HEADの機能を証明しません。

## 現行の確認方法

- `npm test` はfake providerとfake Bodyを使うofflineのunit / integration testです。
- `npm run test:e2e` は専用のPaper server JARとEULAファイルを受け取り、一時directoryにloopback限定のserverを作って、MineflayerClientとPlayerBodyの限定操作を確認します。provider呼び出しは行いません。実行時の秘密出力やserverログ本文は報告せず、許可された一時作業領域だけで扱います。
- `npm run preflight:local` はowner identity、server mode、loopbackとport設定をread-onlyで確認します。
- 通常の `npm start` は実Minecraft接続とOpenAI Responses APIを使います。起動ログ、LLM応答、Body操作受付だけではゲーム内の成果を証明しません。

## 実環境の結果を記録する場合

対象server、world、database、owner identity、Bot identityをread-onlyで相関し、別の新規copyで試します。稼働中のworldやdatabaseをコピーせず、検証前後の通常停止と復旧可能性を確認します。実worldへ変更を加える場合は、依頼の対象・変更・復旧範囲に含まれる場合だけ進めます。

各シナリオで、次を別々に記録します。

1. serverがlistenし、Botが接続したこと
2. owner chatがRuntimeに認証されたこと
3. PlayerBodyの操作結果
4. Minecraft側の位置、状態、inventory、world readback
5. stopやshutdown後に入力・listener・owned processが終了したこと

実行したHEAD、world区分、操作名、観測値の集約、cleanup結果、未確認事項を記録します。アカウント名、座標、会話、接続先、seed、API key、raw logは公開artifactへ含めません。成功した局所シナリオを他の操作、別world、長期運用へ一般化しません。

current e2eとbody acceptanceの違いは [testing](testing.md)、実操作の成功条件は [PlayerBody](player-body.md) を参照してください。
