# Minecraft Java 26.3 へ既存 world と AI 記憶を引き継ぐ手順

この文書は、現在使っている world と Bot の継続性を保ちながら、Minecraft Java Edition 26.3 のサーバー構成を複製上で評価する手順と、確認済み範囲の結果をまとめます。空の world を作って置き換える手順ではありません。旧環境を継続し、比較後の Paper 26.3 検証 copy は停止済みです。別途確認した 26.3 client と旧版 Paper の接続経路は、Paper 26.3 server の受け入れを示しません。実 world への切替と server の全受け入れ条件は未完了です。

## 対象と版

| 項目                   | この手順で固定する内容                  | 確認と境界                                                                                                                                                       |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minecraft Java Edition | 26.3 正式版                             | 2026-09-15 公開。クライアント版と Paper の状態は別々に確認します。                                                                                               |
| Paper                  | 26.3 BETA build 143                     | 2026-10-03 時点の複製検証候補。BETA は安定版として扱いません。                                                                                                   |
| Java                   | Java 25（既存 runtime は 25.0.1）       | 複製環境で起動時の版を確認します。個人環境のインストール先は記録しません。                                                                                       |
| Via plugins            | ViaVersion 5.12.0 + ViaBackwards 5.12.0 | Paper 26.3 上で旧版 Bot を受け入れる構成を試します。組み合わせの個別動作は未確認です。                                                                           |
| Bot                    | Mineflayer 4.39.0、候補接続版 26.1      | 固定 package は公式 4.39.0 release。既定 `MINECRAFT_VERSION=1.21.11`は維持し、26.1 候補は複製で明示設定します。26.3 への直接対応と候補の実環境動作は未確認です。 |

版の根拠と実行前確認は次のとおりです。

- [Mojang の 26.3 正式リリース](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3)。
- Paper の[Java 要件](https://docs.papermc.io/paper/getting-started/)、[Downloads Service](https://docs.papermc.io/misc/downloads-service/)、[26.3 build 一覧 API](https://fill.papermc.io/v3/projects/paper/versions/26.3/builds)。実行直前に build 番号・`BETA` channel・配布 artifact の SHA-256 を照合し、一致しなければ起動しません。
- [Paper 26.3 の告知](https://papermc.io/news/26-3/)は、26.3 へ保存した world を旧版へ戻せないと案内しています。
- ViaBackwards の[5.12.0 release](https://github.com/ViaVersion/ViaBackwards/releases/tag/5.12.0)は 26.3 server support を記載しています。ViaBackwards は ViaVersion を必要とします（[ViaVersion 5.12.0](https://github.com/ViaVersion/ViaVersion/releases/tag/5.12.0)）。
- Mineflayer は[公式 4.39.0 release](https://github.com/PrismarineJS/mineflayer/releases/tag/4.39.0)に固定します。公式[対応表](https://github.com/PrismarineJS/mineflayer#features)が示す候補は 26.1 までで、26.3 への直接対応を示していません。関連する[PR #4125](https://github.com/PrismarineJS/mineflayer/pull/4125)、[PR #4128](https://github.com/PrismarineJS/mineflayer/pull/4128)、[PR #4130](https://github.com/PrismarineJS/mineflayer/pull/4130)の内容はこの release に含まれるとみなしません。
- 既定の接続版は`MINECRAFT_VERSION=1.21.11`のままです。26.1 候補を検証する複製だけで`MINECRAFT_VERSION=26.1`を明示し、ViaBackwards 経由で別 profile として試します。公式[CI run 34038030872](https://github.com/PrismarineJS/mineflayer/actions/runs/34038030872)には 1.21.11 の chest close timeout があり、4.39.0 の既定版への後方互換も未実証です。
- 26.3 で追加された block 等が Bot へどう変換・表示されるかは未検証です。接続や一部の観測が成功しても、新要素を完全に認識できたとは扱いません。

Paper build 143 は、まず複製 world の評価に使います。Paper が BETA であることを risk として記録し、複製の受け入れと復旧可能性、対象 world と影響範囲を照合して、既存の移行依頼の範囲で実 world へ適用するか判断します。BETA であることだけを理由に一律禁止とはしません。

## 作業開始前の条件

1. 「先週使った world」などの説明だけで選ばず、読み取り専用の一覧・既存資料・実環境を照合して対象 server instance とその world を一意に特定します。対象 ID、現行版、設定、永続データの保存先は手元の非公開作業記録だけに置きます。特定できない間は停止・コピー・起動を保留し、確認質問への返答待ちにせず read-only の照合作業を続けます。
2. 依頼・既存設定・read-only 観測から停止対象、影響するファイルと Bot 状態、保守時間を確定し、依頼範囲内の手順として Bot と server を停止します。範囲や安全な停止対象を資料と観測から決められない場合は危険操作だけを保留し、原本を維持して安全な独立作業を続けます。工程ごとの再確認は求めません。
3. この依頼では既存の OpenAI API key 再利用許可が確認済みなので、同じ許可を再取得せず複製 Bot でも再利用します。承認済みの秘密管理経路からプロセスへ渡し、値を文書、コマンド出力、ログ、Issue、PR へ出しません。公開記録には実 API を使ったかと成功・失敗だけを書きます。既存 key を使えない場合も別 key は作らず、AI を使う検査は未実施として記録して他の検証を続けます。
4. 複製環境は元 server と別のディレクトリ、別の loopback port、別の database にします。元 server と複製で world、SQLite、plugin の書込み先を共有しません。

## 旧環境を保全して復元を確かめる

1. 読み取り専用の棚卸しで、`server.properties`の world 設定、実際に使われている全 world directory、Paper/Bukkit/Spigot 設定、plugin 一覧と設定、権限・whitelist 設定を対応づけます。Paper で別 directory に置いた Nether や End などの dimension も対象に含めます。設定値の実データは公開しません。
2. 依頼と既存の稼働状況から定めた保守時間に Bot を通常停止し、続けて server を通常停止します。両方の書込みが完全に止まったことを確認してから backup を取ります。稼働中の world directory をコピーしません。
3. world directory を丸ごと複製し、`region`、`entities`、`poi`、`playerdata`、`stats`、`advancements`、`data`（map を含む）、`datapacks`、level metadata、chest や entity のデータを保全します。dimension を分けている場合はその全 directory も同じ snapshot に含めます。`server.properties`、ops・whitelist 等のアクセス設定、Paper/Bukkit/Spigot 設定、plugin JAR と plugin 設定も、同じ時点の組み合わせで保管します。
4. Bot の有効設定で参照される`DATABASE_PATH`を確認します。現行実装では MemoryStore、PlayerMindStore、trace、McSkillRepository の DB が同じ SQLite database を使います。SQLite の WAL を含む整合した snapshot を取るため、database 本体と`-wal` / `-shm`を別々にファイルコピーせず、[SQLite Online Backup API](https://www.sqlite.org/backup.html)を使います。保存された人格設定`PERSONA_PATH`と、McSkillRepository の exchange directory（通常は database directory 内の`mc-skills`。実際の設定を優先）も保全します。
5. private な保管先で backup file 一式の hash 一覧を作り、復元後に照合します。hash や対象 path を repository へ載せません。バックアップを旧版の複製環境へ復元し、SQLite の整合性検査、world の dimension・playerdata・map・chest の確認、Bot の記憶と skill 読込を行います。元 server の再開後に接続と保存状態を確認してから、次へ進みます。

## 複製 world を 26.3 で確認する

26.3 の停止済み copy では、設定された world root の下に `dimensions/minecraft/{overworld,the_nether,the_end}/region/` と `players/` がある構造を観測しました。実際の root とファイル一覧は公開しません。copy や切替では root 全体と相対階層を保ち、旧版の dimension 配置を前提に一部 directory だけを移動しません。seed や settings の新 schema との比較は未確認です。

1. 復元済み backup からさらに検証用 copy を作り、Paper 26.3 BETA build 143 と Java 25 を使います。起動前に PaperMC Fill API の manifest で build ID・channel・SHA-256 を照合し、選んだ artifact と一致しなければ停止します。`server.properties`の port や bind 先は複製専用にし、公開ネットワークへ接続できない状態にします。
2. ViaVersion と ViaBackwards 5.12.0 を導入します。元 server の plugin と設定を複製へ引き継ぎ、TreeGuard を含む各 plugin の起動・権限・world 保護が 26.3 上で機能するか確認します。非互換やデータ移行エラーがあれば、設定変更を広げずその検証を中断します。
3. 26.3 クライアントと Bot を同じ複製 world へ接続します。lockfile の Mineflayer 4.39.0 を使い、既定`MINECRAFT_VERSION=1.21.11`の fallback と、複製だけで`MINECRAFT_VERSION=26.1`を明示する candidate を別 profile として ViaBackwards 経由で試します。4.39.0 candidate は未検証で、26.1 接続も 26.3 への直接対応や新要素対応を証明しません。オンライン認証では owner と Bot に別々の Minecraft identity を使い、同じ identity の二重接続で片方を切断させません。認証設定を変更して接続成功とみなすことはしません。
4. server log や接続受付だけで成功判定せず、ゲーム画面と複製 Bot の観測で確認します。既存 landmark と複数 dimension、playerdata、map、chest・entity が移行前と対応し、読み書きできることを確認します。26.3 の新要素を旧版 Bot が扱えるかは、個別に観測できた範囲だけ記録します。
5. 複製 database で SQLite 整合性・schema 読込を確認し、永続化済みの人格設定・関係、MindStore の目的・停止状態、MemoryStore の記憶、McSkillRepository の skill と receipt が参照できることを確認します。直近の会話履歴はプロセス内の`PlayerConversationAgent.#history`にあり、再起動時にリセットされます。これは移行対象の永続データに含めず、引継ぎ受け入れ条件にしません。実記憶や会話を公開せず、項目別の成否だけを残します。
6. 同じ複製環境で日本語会話、短いゲーム内動作、その実動作中の即時停止、Bot 切断・再接続、再起動後の停止状態と記憶の維持を確かめます。操作依頼や LLM の返答だけで成功とせず、ゲーム内変化を観測します。

### 今回の観測結果

- probe3–5 は Mineflayer 4.37.1・`MINECRAFT_VERSION=1.21.11`で実施しました。native QuickPlay による旧版 Paper copy への接続と owner/Bot 同時接続も、この旧 fallback の履歴です。固定更新後の Mineflayer 4.39.0、および明示的な 26.1 candidate は実環境で未検証です。
- offline backup とその復元 copy の全 254 file で、対応する各 file の SHA-256 とサイズが一致しました。backup 総量は 1.418 GB です。旧 Paper/Bot 環境は再起動し、dashboard HTTP 200、Bot 接続、memory 利用可能を確認しました。
- Paper 26.3 BETA build 143・Java 25・ViaVersion/ViaBackwards 5.12.0・TreeGuard の複製構成はロードしました。正常停止後の比較では 3 dimension すべてで region/chunk/POI/entity-region 件数が一致し、既存 6 人分の Identity・Inventory・EnderItems も一致しました。代表 3 chunk の blockstate と収納 3 件も一致しましたが、これは全 world の意味的内容やゲーム機能の保証ではありません。
- 両 SQLite database の`quick_check`は`ok`、9 table の既存 primary key は維持されました。episodes は 14570 から 14571 へ増えましたが、内容不変は照合していません。
- 26.3 コピー環境の probe4 当該セッションでは、独立した Paper/DB 観測により owner 入力、日本語の Bot 返信、`say`完了を確認しました。receipt の`JAPANESE_CHAT_NOT_OBSERVED`は probe 側の受信取りこぼしとして調査中で、日本語述語の観測とは分けて扱います。複合受け入れは別の未達述語があるため pass ではありません。
- リスナーの最小修正と strict typepass 後の probe5 は 8.778 秒で`RCON_COMMAND_FAILED`となりました。失敗は RCON transport/auth ではなく、owner 生成前の Bot 位置応答に対する座標解析です。同時期に Paper の`invalid-move`拒否を 1 件観測しましたが、翻訳と physics のどちらが原因かは未確定です。owner 生成・日本語 listener 段階に届かず、listener 修正の効果も未確認です。API 1 件・RCON 5 件で後続検査に到達せず、movement、owner stop、再起動後の永続性、reconnect は`not_run`です。追加 probe は行いません。実 API の累計は 7 件、provider usage は`partial_or_unknown`です。
- probe5 後、copy の fresh PID を確認して通常の SIGINT 停止を行い、3 dimension の ChunkHolder save・RegionFile I/O 完了、port 解放、process 終了を確認しました。元 runtime は active・connected・memory available を維持しています。Paper 26.3 server での client 同時接続と GUI は未実証で、実 world 切替は未実施、Issue #126 の受け入れは未完了です。
- 公式 Minecraft 26.3 client JAR の SHA-1 は[Mojang version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)と一致しました。公式 QuickPlay CLI で immutable backup 由来の Paper 1.21.11 build 132・ViaVersion 5.12.0 の検証 copy に接続し、独立した fresh Paper log で owner の参加後、退出前に既定 `createApplication` Bot が参加したこと、Bot の spawn・body・connected を確認しました。これは旧版 Paper copy 上の client 接続経路と owner/Bot 同時接続の確認です。Paper 26.3 server への接続や 26.3 server 側の新機能は確認していません。
- 別の observer run 1 は 7.680 秒で`RCON_PROTOCOL_ERROR`となり、API 1 件・RCON 1 件を使用しました。位置・会話・移動・停止・再接続の検査には到達していません。この失敗は先の Paper log による同時接続確認とは別に扱います。実 API の累計は 8 件、provider usage は`partial_or_unknown`です。
- 1.21.11 検証 copy は SIGINT で正常停止し、保存処理・port 解放・process 終了を確認しました。QuickPlay client は既に終了しており、原 client・server・既定 Bot は変更していません。Paper 26.3 server 上の同時接続と GUI、実 world 切替は未実施で、Issue #126 の受け入れは未完了です。

## 適用と失敗時の戻し方

複製確認の完了だけで自動的に切り替えず、対象 server、停止・再開、更新するデータ、作業時間が既存の移行依頼と一致すること、複製の受け入れと復旧可能性を照合します。条件がそろえば依頼済みの適用範囲で切り替えます。対象や影響を安全に特定できない場合、または受入範囲外の不可逆なデータ損失が判明した場合は、その工程だけを保留して安全な独立作業を続けます。追加確認は再開条件にしません。Paper の BETA 状態は適用 risk として判断記録に残します。

実際に切り替える場合は、Bot を通常停止してから server を正常停止し、その時点で新しい offline backup を作成します。練習用 copy をそのまま昇格させず、最新の backup から切替用 copy を作り、同じ選定 build で更新します。

複製検証に失敗した場合は、複製 server と Bot だけを停止し、失敗した copy を隔離します。元 world は変更せず、複製検証用 backup で上書きしません。

実 world へ切り替えた後に問題が起きた場合は、新 server と Bot を停止し、切替後の world と AI 記憶のデータを非公開の保管先へ別 backup として保全してから、切替直前の整合 backup を使う復旧を選びます。26.3 で保存した world directory を旧版 Paper で開きません。切替後に追加・変更された world と AI 記憶は切替前 backup との差分があり、旧 world へそのまま戻せないデータや失われる可能性があります。保持・復元できる範囲と失われる可能性を記録し、別 backup を保全したうえで安全な復旧方法を自律的に選びます。復旧不能な差分は捨てず、復旧対象と分けて保持します。

## 証跡と現在の状態

実際の world・database path、接続先、username、seed、会話内容、API key、ログ原文、player ID は公開しません。検査の snapshot、hash 一覧、詳細 log は非公開 artifact に保管し、公開記録には上記の集約結果、未確認範囲、未実施項目だけを記載します。PR #127 は部分参照の`Refs #126`のままです。
