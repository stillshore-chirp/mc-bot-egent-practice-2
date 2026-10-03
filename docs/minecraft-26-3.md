# Minecraft Java 26.3 へ既存worldとAI記憶を引き継ぐ手順

この文書は、現在使っているworldとBotの継続性を保ちながら、Minecraft Java Edition 26.3のサーバー構成を複製上で評価する手順です。空のworldを作って置き換える手順ではありません。移行作業そのものはまだ実施していません。

## 対象と版

| 項目                   | この手順で固定する内容                  | 確認と境界                                                                             |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| Minecraft Java Edition | 26.3正式版                              | 2026-09-15公開。クライアント版とPaperの状態は別々に確認します。                        |
| Paper                  | 26.3 BETA build 143                     | 2026-10-03時点の複製検証候補。BETAは安定版として扱いません。                           |
| Java                   | Java 25（既存runtimeは25.0.1）          | 複製環境で起動時の版を確認します。個人環境のインストール先は記録しません。             |
| Via plugins            | ViaVersion 5.12.0 + ViaBackwards 5.12.0 | Paper 26.3上で旧版Botを受け入れる構成を試します。組み合わせの個別動作は未確認です。    |
| Bot                    | Mineflayer 4.37.1、接続版1.21.11        | lockfileの固定を維持し、ViaBackwards経由で試します。26.3への直接接続対応は未確認です。 |

版の根拠と実行前確認は次のとおりです。

- [Mojangの26.3正式リリース](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3)。
- Paperの[Java要件](https://docs.papermc.io/paper/getting-started/)、[Downloads Service](https://docs.papermc.io/misc/downloads-service/)、[26.3 build一覧API](https://fill.papermc.io/v3/projects/paper/versions/26.3/builds)。実行直前にbuild番号・`BETA` channel・配布artifactのSHA-256を照合し、一致しなければ起動しません。
- [Paper 26.3の告知](https://papermc.io/news/26-3/)は、26.3へ保存したworldを旧版へ戻せないと案内しています。
- ViaBackwardsの[5.12.0 release](https://github.com/ViaVersion/ViaBackwards/releases/tag/5.12.0)は26.3 server supportを記載しています。ViaBackwardsはViaVersionを必要とします（[ViaVersion 5.12.0](https://github.com/ViaVersion/ViaVersion/releases/tag/5.12.0)）。
- Mineflayerの[4.37.1 release](https://github.com/PrismarineJS/mineflayer/releases/tag/4.37.1)を維持します。上流[4.39.0 README](https://github.com/PrismarineJS/mineflayer#features)の対応表は26.1までです。26.3対応の[PR #4125](https://github.com/PrismarineJS/mineflayer/pull/4125)、[PR #4128](https://github.com/PrismarineJS/mineflayer/pull/4128)、[PR #4130](https://github.com/PrismarineJS/mineflayer/pull/4130)は2026-10-03時点で未マージでした。
- 26.3で追加されたblock等が1.21.11 Botへどう変換・表示されるかは未検証です。接続や一部の観測が成功しても、新要素を完全に認識できたとは扱いません。

Paper build 143は、まず複製worldの評価に使います。PaperがBETAであることを適用判断のriskとして記録します。複製の受け入れ、復旧可能性、対象と影響範囲への明示許可を確認した後に、実worldへ適用するか判断します。

## 作業開始前の条件

1. 「先週使ったworld」などの説明だけで選ばず、読み取り専用の一覧から対象server instanceとそのworldを一意に特定します。対象ID、現行版、設定、永続データの保存先は手元の非公開作業記録だけに置きます。特定できるまでは停止・コピー・起動を行いません。
2. 対象worldを停止する権限、停止時間、複製検証で影響するファイルとBot状態を確認します。対象と影響範囲に対する明示許可がそろうまで停止しません。
3. ownerによる再利用の明示許可が確認済みの場合に、既存のOpenAI API keyを複製Botでも再利用します。承認済みの秘密管理経路からプロセスへ渡し、値を文書、コマンド出力、ログ、Issue、PRへ出しません。公開記録には実APIを使ったかと成功・失敗だけを書きます。既存keyを使えない場合は別keyを無断で作りません。
4. 複製環境は元serverと別のディレクトリ、別のloopback port、別のdatabaseにします。元serverと複製でworld、SQLite、pluginの書込み先を共有しません。

## 旧環境を保全して復元を確かめる

1. 読み取り専用の棚卸しで、`server.properties`のworld設定、実際に使われている全world directory、Paper/Bukkit/Spigot設定、plugin一覧と設定、権限・whitelist設定を対応づけます。Paperで別directoryに置いたNetherやEndなどのdimensionも対象に含めます。設定値の実データは公開しません。
2. 許可された保守時間にBotを通常停止し、続けてserverを通常停止します。両方の書込みが完全に止まったことを確認してからbackupを取ります。稼働中のworld directoryをコピーしません。
3. world directoryを丸ごと複製し、`region`、`entities`、`poi`、`playerdata`、`stats`、`advancements`、`data`（mapを含む）、`datapacks`、level metadata、chestやentityのデータを保全します。dimensionを分けている場合はその全directoryも同じsnapshotに含めます。`server.properties`、ops・whitelist等のアクセス設定、Paper/Bukkit/Spigot設定、plugin JARとplugin設定も、同じ時点の組み合わせで保管します。
4. Botの有効設定で参照される`DATABASE_PATH`を確認します。現行実装ではMemoryStore、PlayerMindStore、trace、McSkillRepositoryのDBが同じSQLite databaseを使います。SQLiteのWALを含む整合したsnapshotを取るため、database本体と`-wal` / `-shm`を別々にファイルコピーせず、[SQLite Online Backup API](https://www.sqlite.org/backup.html)を使います。保存された人格設定`PERSONA_PATH`と、McSkillRepositoryのexchange directory（通常はdatabase directory内の`mc-skills`。実際の設定を優先）も保全します。
5. privateな保管先でbackup file一式のhash一覧を作り、復元後に照合します。hashや対象pathをrepositoryへ載せません。バックアップを旧版の複製環境へ復元し、SQLiteの整合性検査、worldのdimension・playerdata・map・chestの確認、Botの記憶とskill読込を行います。元serverの再開後に接続と保存状態を確認してから、次へ進みます。

## 複製worldを26.3で確認する

1. 復元済みbackupからさらに検証用copyを作り、Paper 26.3 BETA build 143とJava 25を使います。起動前にPaperMC Fill APIのmanifestでbuild ID・channel・SHA-256を照合し、選んだartifactと一致しなければ停止します。`server.properties`のportやbind先は複製専用にし、公開ネットワークへ接続できない状態にします。
2. ViaVersionとViaBackwards 5.12.0を導入します。元serverのpluginと設定を複製へ引き継ぎ、TreeGuardを含む各pluginの起動・権限・world保護が26.3上で機能するか確認します。非互換やデータ移行エラーがあれば、設定変更を広げずその検証を中断します。
3. 26.3クライアントとBotを同じ複製worldへ接続します。Bot設定はMineflayer 4.37.1、`MINECRAFT_VERSION=1.21.11`を保ち、ViaBackwards経由で接続します。オンライン認証ではownerとBotに別々のMinecraft identityを使い、同じidentityの二重接続で片方を切断させません。認証設定を変更して接続成功とみなすことはしません。
4. server logや接続受付だけで成功判定せず、ゲーム画面と複製Botの観測で確認します。既存landmarkと複数dimension、playerdata、map、chest・entityが移行前と対応し、読み書きできることを確認します。26.3の新要素を旧版Botが扱えるかは、個別に観測できた範囲だけ記録します。
5. 複製databaseでSQLite整合性・schema読込を確認し、永続化済みの人格設定・関係、MindStoreの目的・停止状態、MemoryStoreの記憶、McSkillRepositoryのskillとreceiptが参照できることを確認します。直近の会話履歴はプロセス内の`PlayerConversationAgent.#history`にあり、再起動時にリセットされます。これは移行対象の永続データに含めず、引継ぎ受け入れ条件にしません。実記憶や会話を公開せず、項目別の成否だけを残します。
6. 同じ複製環境で日本語会話、短いゲーム内動作、その実動作中の即時停止、Bot切断・再接続、再起動後の停止状態と記憶の維持を確かめます。操作依頼やLLMの返答だけで成功とせず、ゲーム内変化を観測します。

## 適用と失敗時の戻し方

複製確認の完了は、実worldへの適用許可を意味しません。適用判断では、対象server ID、停止・再開、更新対象のデータ、作業時間を明示した許可に加え、複製の受け入れと復旧可能性を確認します。PaperのBETA状態は判断材料として記録します。

実際に切り替える場合は、Botを通常停止してからserverを正常停止し、その時点で新しいoffline backupを作成します。練習用copyをそのまま昇格させず、最新のbackupから切替用copyを作り、同じ選定buildで更新します。

複製検証に失敗した場合は、複製serverとBotだけを停止し、失敗したcopyを隔離します。元worldは変更せず、複製検証用backupで上書きしません。

実worldへ切り替えた後に問題が起きた場合は、新serverとBotを停止し、切替直前に取得した整合backupから旧版環境を復旧します。26.3で保存したworld directoryを旧版Paperで開きません。切替後に追加・変更されたworldとAI記憶のデータは、切替前backupとの差分が失われる可能性があります。旧worldへ戻す前に、可能な範囲を非公開の保管先へ別backupとして保全し、保持・復元できる範囲と失われる可能性をownerに説明して扱いを決めます。

## 証跡と現在の状態

この手順書は移行作業の記録ではありません。実際のworld、database、接続先、username、seed、会話、API key、ログ原文、private pathを公開しません。検証を行った場合は、非公開のartifactにsnapshot、選択buildとchannel、検査条件、pass/fail、失敗分類を残し、公開記録には必要な成否と未実施項目だけをまとめます。
