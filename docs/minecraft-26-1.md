# Minecraft 26.1 クライアントと本 Bot の接続検証

この手順は、Mac 版 Minecraft Java Edition 26.1 の利用者と、本リポジトリの Bot が同じテストサーバーに入り、日本語の直接入力から実 OpenAI 応答のゲーム画面表示まで確認するためのものです。実利用サーバーへの適用記録ではありません。

## 採用構成と根拠

| 役割                  | この検証で使う版                                           | 根拠と境界                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mac クライアント      | Minecraft Java Edition 26.1、プロトコル 775                | [公式 26.1 リリースノート](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-1)は macOS の日本語入力 IME 表示に言及する。プロトコル番号は [PrismarineJS の版データ](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/common/protocolVersions.json)で確認する。 |
| テストサーバー        | Paper 1.21.11、プロトコル 774、Java 21                     | [Paper の起動要件](https://docs.papermc.io/paper/getting-started/)では 1.21.11 に Java 21、26.1 以降に Java 25 を指定する。テスト時に使用する build は [Paper 公式ダウンロード](https://papermc.io/downloads/paper)で確認する。                                                                  |
| サーバー側互換 plugin | ViaVersion 5.12.0                                          | [公式配布ページ](https://hangar.papermc.io/ViaVersion/ViaVersion)は新しい Java クライアントから古いサーバーへの接続を用途とし、[5.12.0 リリース](https://github.com/ViaVersion/ViaVersion/releases/tag/5.12.0)は 1.21.11→26.1 の変換修正を記載する。plugin は Paper の `plugins/` に入れる。     |
| 本 Bot                | このリポジトリに固定した Mineflayer 4.37.1、接続版 1.21.11 | [Mineflayer 4.37.1](https://github.com/PrismarineJS/mineflayer/releases/tag/4.37.1)とリポジトリの lockfile に合わせる。`MINECRAFT_VERSION` はサーバーへの Bot 接続版であり、クライアントの 26.1 ではない。                                                                                       |

ViaVersion は 26.1 クライアントの通信をサーバー側で変換します。Bot は同じ Paper に 1.21.11 として直接接続します。アプリケーションへ Paper plugin や Bridge を組み込む必要はありません。26.1 サーバーへ Bot が直接接続する構成は、Mineflayer と依存パッケージの更新、回帰試験、実接続を別途要します。

## テスト環境の準備

1. 既存 world と別のディレクトリに新規 Paper world を作り、公式配布物の版・ハッシュを確認する。Paper の Java 要件と Minecraft サーバー利用条件を満たす環境で起動する。
2. ViaVersion の配布 JAR をそのサーバーの `plugins/` に置き、サーバーを起動する。Paper と ViaVersion の起動完了を確認する。実利用中の server directory や world を再利用しない。
3. Mac の 26.1 クライアントと Bot を同じサーバーへ接続する。`MINECRAFT_VERSION=1.21.11`、`OWNER_USERNAME` は利用者のゲーム内名、`DATABASE_PATH` はテスト専用の保存先とする。接続情報と `OPENAI_API_KEY` は git の無視対象ファイルか安全な process 環境だけに置く。
4. `online-mode=true` のサーバーでは、利用者と Bot に別の Minecraft アカウントを用意する。同一アカウントを二重に使うと、後のログインで先の接続が切れる。アカウントを一つだけ使うローカル検証では、**loopback に限定した新規テストサーバーに限り** `online-mode=false` と `enforce-secure-profile=false` を使い、Bot に利用者と異なるテスト名を割り当てる。この設定を LAN や実利用サーバーへ転用しない。

## ゲーム内での受け入れ

1. Bot と 26.1 クライアントの両方が同じサーバーのゲーム画面に存在し、接続状態が維持されることを確認する。
2. クライアントのチャット欄で日本語を IME から直接入力・送信する。Bot 側が認可済み利用者の chat を受信し、実 OpenAI Responses API を経由した日本語応答をゲーム画面で確認する。発話全文や識別子は公開証跡へ残さない。
3. 利用者が追従などの継続動作を依頼し、ゲーム画面上の実動作を観測する。`停止`を送信し、LLM の応答を待たずに動作が止まり、task が `cancelled` として扱われることを確認する。停止 chat の受信と応答表示だけでは、動作停止の証拠にしない。
4. テストサーバーから Bot を切断し、再接続上限に達した場合は接続状態が `failed` になり、進行中 task が `completed` へ移らないことを確認する。クライアント側の切断表示だけでは Bot の task 状態を推定しない。

ログや runner の原文には接続先、アカウント、会話、相関 ID が含まれ得るため、repository、Issue、PR へ貼らない。公開するのは環境区分、版、各項目の成否、失敗分類、未実施項目だけとする。全12項目の製品 live E2E を行う場合は [別の事前条件と runner](testing.md#実環境-e2e)を使う。

## 実利用サーバーへの適用

この検証は実利用サーバーの更新を含まない。適用を決めた場合は、停止前に world と server 設定・plugin 一式を整合した形でバックアップし、別の復元先で復旧可能なことを確かめる。保守時間内に対象サーバーだけへ ViaVersion を導入し、再起動後に接続・日本語 chat・停止・切断を再確認する。失敗時はサーバーを停止し、plugin と設定を戻して旧構成で接続を確認する。認証方式の変更は、この互換構成の適用には含めない。
