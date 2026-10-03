# Minecraft Java 26.3 へ既存 world と AI 記憶を引き継ぐ手順

この文書は、既存 world と Bot の継続性を保つための移行手順と確認記録です。Gate1 の copy 評価は記録時点の証拠であり、16.297 秒の観測で native 26.3 client と既定 application Bot の同時参加を確認した限定結果です。2026-10-04時点では、既存環境へ Paper 26.3 BETA build 143、Java 25 SerialGC、ViaVersion / ViaBackwards 5.12.0、Mineflayer 4.39.0（Bot protocol 26.1）を適用し、既定 application を稼働しています。既存 world・persona・記憶の保存先を維持して適用し、利用承認済みの既存 API 認証設定を再利用しました。既存データの構造・代表データ・永続記憶と通常保存後の再起動を確認しました。全world内容・全mob identity・長期安定性は未検証です。配送の最終判断は [Issue #126](https://github.com/stillshore-chirp/mc-bot-egent-practice-2/issues/126) と [PR #127](https://github.com/stillshore-chirp/mc-bot-egent-practice-2/pull/127) を参照してください。

## 対象と版

| 項目                   | この手順で固定する内容                  | 確認と境界                                                                                                                          |
| ---------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Minecraft Java Edition | 26.3 正式版                             | 2026-09-15 公開。クライアント版と Paper の状態は別々に確認します。                                                                  |
| Paper                  | 26.3 BETA build 143                     | 既存環境へ適用済みです。BETA は安定版として扱わず、長期安定性は未検証です。最終配送判断は Issue #126 / PR #127 を参照してください。 |
| Java                   | Java 25 SerialGC                        | 現適用 Paper 用の runtime です。切替前の構成は Java 21 でした。長時間安定性は未確認です。                                           |
| Via plugins            | ViaVersion 5.12.0 + ViaBackwards 5.12.0 | 現適用 Paper でロードしています。旧 Bot の限定接続を確認しましたが、全機能の互換性は未確認です。                                    |
| Bot                    | Mineflayer 4.39.0 / protocol 26.1       | 既定 application で稼働中です。切替前の構成は 4.37.1 / 1.21.11 でした。26.3 への直接対応や全機能は未確認です。                      |

版の根拠と実行前確認は次のとおりです。

- [Mojang の 26.3 正式リリース](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3)。
- Paper の[Java 要件](https://docs.papermc.io/paper/getting-started/)、[Downloads Service](https://docs.papermc.io/misc/downloads-service/)、[26.3 build 一覧 API](https://fill.papermc.io/v3/projects/paper/versions/26.3/builds)。実行直前に build 番号・`BETA` channel・配布 artifact の SHA-256 を照合し、一致しなければ起動しません。
- [Paper 26.3 の告知](https://papermc.io/news/26-3/)は、26.3 へ保存した world を旧版へ戻せないと案内しています。
- ViaBackwards の[5.12.0 release](https://github.com/ViaVersion/ViaBackwards/releases/tag/5.12.0)は 26.3 server support を記載しています。ViaBackwards は ViaVersion を必要とします（[ViaVersion 5.12.0](https://github.com/ViaVersion/ViaVersion/releases/tag/5.12.0)）。
- Mineflayer は[公式 4.39.0 release](https://github.com/PrismarineJS/mineflayer/releases/tag/4.39.0)に固定します。公式[対応表](https://github.com/PrismarineJS/mineflayer#features)が示す候補は 26.1 までで、26.3 への直接対応を示していません。関連する[PR #4125](https://github.com/PrismarineJS/mineflayer/pull/4125)、[PR #4128](https://github.com/PrismarineJS/mineflayer/pull/4128)、[PR #4130](https://github.com/PrismarineJS/mineflayer/pull/4130)の内容はこの release に含まれるとみなしません。
- protocol 775 では`tick_end`が必要です。Paper 26.3 copy と Mineflayer 4.39.0 / 26.1 protocol の API 不使用 component probe で、158 tick に 158 marker と 11 movement packet を観測しました。これは単独 idle component の結果で、既定 application の移動や受け入れを証明しません。
- 既定の接続版は`MINECRAFT_VERSION=1.21.11`のままです。26.1 候補を検証する複製だけで`MINECRAFT_VERSION=26.1`を明示し、ViaBackwards 経由で別 profile として試します。公式[CI run 34038030872](https://github.com/PrismarineJS/mineflayer/actions/runs/34038030872)には 1.21.11 の chest close timeout があり、4.39.0 の既定版への後方互換も未実証です。
- 26.3 で追加された block 等を複製上で利用できるかは一部だけ確認中です。item の利用可能性は GUI 表示、配置、生成 terrain、全新要素への対応を証明しません。

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

26.3 copy の保存構造は `dimensions/minecraft/{overworld,the_nether,the_end}/region/` と `players/` です。root 全体と相対階層を保ち、旧版の dimension 配置を前提に一部 directory だけを移動しません。非公開の metadata 比較では 3 dimension の seed・generator・関連 flag が一致しました。これは保存 metadata の保持を示しますが、新 terrain の生成や長期プレイを確認した結果ではありません。

1. 復元済み backup からさらに検証用 copy を作り、Paper 26.3 BETA build 143 と Java 25 を使います。起動前に PaperMC Fill API の manifest で build ID・channel・SHA-256 を照合し、選んだ artifact と一致しなければ停止します。`server.properties`の port や bind 先は複製専用にし、公開ネットワークへ接続できない状態にします。
2. ViaVersion と ViaBackwards 5.12.0 を導入します。元 server の plugin と設定を複製へ引き継ぎ、TreeGuard を含む各 plugin の起動・権限・world 保護が 26.3 上で機能するか確認します。非互換やデータ移行エラーがあれば、設定変更を広げずその検証を中断します。
3. 26.3 クライアントと Bot を同じ複製 world へ接続します。lockfile の Mineflayer 4.39.0 を使い、既定`MINECRAFT_VERSION=1.21.11`の fallback と、複製だけで`MINECRAFT_VERSION=26.1`を明示する candidate を別 profile として ViaBackwards 経由で試します。Gate1 では明示 26.1 candidate の同時参加と 16.297 秒・4 回の位置/spawn/body 観測が成立しましたが、26.3 の直接対応や全機能を証明しません。オンライン認証では owner と Bot に別々の Minecraft identity を使い、同じ identity の二重接続で片方を切断させません。認証設定を変更して接続成功とみなすことはしません。
4. server log や接続受付だけで成功判定せず、独立したゲーム内または server 観測と複製 Bot の観測を組み合わせて確認します。GUI を確認できない場合は未確認と記録します。既存 landmark と複数 dimension、playerdata、map、chest・entity が移行前と対応し、読み書きできることを確認します。26.3 の新要素を旧版 Bot が扱えるかは、個別に観測できた範囲だけ記録します。
5. 複製 database で SQLite 整合性・schema 読込を確認し、永続化済みの人格設定・関係、MindStore の目的・停止状態、MemoryStore の記憶、McSkillRepository の skill と receipt が参照できることを確認します。直近の会話履歴はプロセス内の`PlayerConversationAgent.#history`にあり、再起動時にリセットされます。これは移行対象の永続データに含めず、引継ぎ受け入れ条件にしません。実記憶や会話を公開せず、項目別の成否だけを残します。
6. 同じ複製環境で日本語会話、短いゲーム内動作、その実動作中の即時停止、Bot 切断・再接続、再起動後の停止状態と記憶の維持を確かめます。操作依頼や LLM の返答だけで成功とせず、ゲーム内変化を観測します。

### 今回の観測結果

- offline backup と復元 copy の全 254 file で、各 file の SHA-256 とサイズが一致しました（合計 1.418 GB）。旧 Paper/Bot 環境は再起動後も稼働し、dashboard HTTP 200、Bot 接続、memory 利用可能を確認しました。
- Paper 26.3 BETA build 143・Java 25・ViaVersion/ViaBackwards 5.12.0・TreeGuard の copy はロードしました。3 dimension の region/chunk/POI/entity-region 件数、既存 6 人分の Identity・Inventory・EnderItems、代表 3 chunk の blockstate と収納 3 件が旧 backup と一致しました。初回のデータ照合時点では SQLite 両方の`quick_check`が`ok`で、9 table の既存 primary key を保っていました。episodes は 14570 から 14571 へ増加し、内容不変は未照合です。
- 非公開 metadata 比較では 3 dimension の seed・generator・関連 flag が一致しました。これは保存値の保持であり、新 terrain の生成確認ではありません。copy の保存先は `dimensions/minecraft/{overworld,the_nether,the_end}/region/` と `players/`を含み、root 全体の階層を保ちます。
- probe4 の 26.3 copy 当該セッションでは、独立した Paper/DB 観測で owner 入力、日本語の Bot 返信、`say`完了を確認しました。probe 側の受信 receipt は取りこぼしましたが、日本語入出力自体は実証済みです。複合受け入れは未達述語があるため pass ではありません。
- `poplar_planks` は 26.3 copy 上で利用可能で、検証後の cleanup を確認しました（API 0・RCON 6）。native owner は接続中でしたが GUI は未確認です。配置、生成 terrain、他の新要素や Bot の意味理解は未検証です。
- Gate1 は Paper 26.3 BETA build 143 copy、native 26.3 client、既定 application Bot（Mineflayer 4.39.0 / `MINECRAFT_VERSION=26.1`）で同時参加しました。16.297 秒に 4 回の位置・spawn・body 観測が成立し、API 2・RCON 9 でした。default application は終了を確認しましたが、これは Paper の正常停止を意味しません。複合受け入れは false で、移動・owner stop・Paper 正常停止後の保存・再起動後の永続性・reconnect は未達です。
- Java 25 の candidate 8 は SerialGC で起動し、world load error は観測していません。過去の G1 candidate 7 の起動後 fatal は履歴上の失敗で、原因は未確定です。長時間安定性は未確認です。
- Gate2 run 2 は 51.095 秒で`JAPANESE_CHAT_NOT_OBSERVED`を返しました（API 4・RCON 4）。接続、runtime closure、copy guard、server version は通過しています。同じ run の約 52 秒の独立 Paper 観測（API 0）では owner の日本語入力と Bot の日本語返信を各 1 件確認し、kick・disconnect・error はありませんでした。receipt 判定はこの player-chat を取りこぼしており、イベント形式の原因は未確定です。日本語入出力は実証済みですが、移動・owner stop・再起動・reconnect は未到達で、複合受け入れは未完了です。run 2 の`memory baselineCount=0`は未設定の receipt 値で、記憶消失の証拠ではありません。
- 以前の probe3–5、protocol-only idle probe、旧 Paper 1.21.11 copy の native client 接続は歴史的な候補評価です。これらは現在の Gate1 結果へ加算せず、Bot 4.37.1 / fallback 1.21.11 の観測と 4.39.0 / 26.1 candidate の観測を区別します。実 API HTTP 呼び出し累計は 15 件、provider usage は`partial_or_unknown`です。
- 元 runtime は旧環境で継続中です。実 world と本番 database は切り替えておらず、検証 copy の world/DB も昇格させません。Issue #126 は未完了です。

## 適用と失敗時の戻し方

複製確認の完了だけで自動的に切り替えず、対象 server、停止・再開、更新するデータ、作業時間が既存の移行依頼と一致すること、複製の受け入れと復旧可能性を照合します。既存 world の 26.3 化と新要素利用は依頼の目的です。Paper の BETA 状態は risk として記録し、対象照合・復旧可能性・段階的適用を踏まえて依頼範囲内で判断します。危険な項目を安全に特定できない場合や、範囲外の不可逆損失が判明した場合はその工程を保留し、安全な独立作業を続けます。追加確認を再開条件にしません。

切替前に read-only で対象、更新後の source・設定、人格・database・skill の保存先、新しい guarded launcher の内容と旧 launcher の退避先を照合します。旧 launcher は旧 source・作業 directory・人格設定を使うため、切替後の再起動に使わず backup に保全します。新 launcher は実 server の永続 working directory を使い、検証済み backup と同じ人格 file を server 内の絶対 path で参照する設定にします。旧 backup helper は stale PID を使うため再利用しません。Bot を通常停止してから server を正常停止し、書込み停止を確認して fresh offline backup を取り、別の復元 copy との照合を行います。その後に初めて新 launcher を配置・登録し、検証済み source と既存の人格・database・skill・owner-stop 状態を引き継ぎます。既に許可された API key は既存の秘密管理経路から process に渡し、値を表示・保存しません。検証 copy の world/DB は昇格させません。

複製検証に失敗した場合は、複製 server と Bot だけを停止し、失敗した copy を隔離します。元 world は変更せず、複製検証用 backup で上書きしません。

実 world へ切り替えた後に問題が起きた場合は、新 server と Bot を停止し、切替後の world と AI 記憶のデータを非公開の保管先へ別 backup として保全してから、切替直前の整合 backup を使う復旧を選びます。26.3 で保存した world directory を旧版 Paper で開きません。切替後に追加・変更された world と AI 記憶は切替前 backup との差分があり、旧 world へそのまま戻せないデータや失われる可能性があります。保持・復元できる範囲と失われる可能性を記録し、別 backup を保全したうえで安全な復旧方法を自律的に選びます。復旧不能な差分は捨てず、復旧対象と分けて保持します。

## 証跡と現在の状態

実際の world・database path、接続先、username、seed、会話内容、API key、ログ原文、player ID は公開しません。検査の snapshot、hash 一覧、詳細 log は非公開 artifact に保管し、公開記録には上記の集約結果、未確認範囲、未実施項目だけを記載します。PR #127 は部分参照の`Refs #126`のままです。
