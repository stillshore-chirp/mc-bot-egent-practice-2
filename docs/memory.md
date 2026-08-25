# 人格と記憶

人格の安定した部分と、利用中に変化する記憶を分けます。安定した人格は repository 管理の JSON 設定、利用者との関係・世界の事実・作業履歴は SQLite に保存します。生の会話履歴を無制限に保存または LLM へ再投入することは記憶の実装として扱いません。

## PersonaCore

[config/persona.example.json](../config/persona.example.json) は次を定義します。

- 名前、話し方
- 価値観と行動原則
- 操作上の禁止事項

人格設定は version を持ち、利用者固有の関係情報と混ぜません。設定の更新は repository の変更として review し、実際の player 名、会話、API key を含めません。

## SQLite の論理モデル

| 状態                | 保存する内容                                               | 信頼性・更新の扱い                                            |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `RelationshipState` | 利用者の基本情報、信頼・親密度、既知情報、共有体験への参照 | 利用者ごとに分離し、変更時刻を残す                            |
| `LifeState`         | 現在の関心、長期目標、拠点、観測した所持品                 | companion全体の一つの現在状態として更新する                   |
| `PlayerFact`        | 利用者が明示的に教えた事実                                 | sourceを`player_stated`として記録し、訂正・削除を優先する     |
| `Location`          | 名前、用途、座標・dimension、登録根拠                      | 実 server の座標や名称を Issue・PR へ転載しない               |
| `Commitment`        | 約束、型付き履行条件、進捗、阻害要因、完了状態             | owner確認または同一tool loopの検証済みreceiptを完了根拠にする |
| `Episode`           | 行動、結果、重要度、共有体験                               | 会話全文ではなく要約と観測根拠を保存する                      |
| `WorldMemory`       | 資源、危険地点、構造物、観測時刻                           | Minecraft 観測と LLM 推測を区別する                           |
| `WorkResult`        | task、checkpoint、観測済みoutput、failure detail、相関ID   | 観測できない完了を成功として保存しない                        |

事実とWorldMemoryはsource、active / superseded / retracted、作成・更新時刻を持ちます。Episodeもsourceと観測時刻を持ちます。LifeStateはsingletonの現在状態、Locationは同一利用者・同一名の更新、Commitmentはactive / completed / cancelledと完了根拠で履歴を表します。同じ事実の重複は正規化または統合し、矛盾は新しい根拠と更新時刻を伴うrecordとして解決します。訂正・撤回済みのFactとWorldMemoryはretrieval対象から除外します。

## 保存と訂正

1. tool または Minecraft 観測が新しい事実を得ます。
2. schema validation と source 分類を通過した値だけを SQLite transaction で保存します。
3. 既存 record と重複・矛盾を照合し、必要なら superseded / deleted 状態へ遷移させます。
4. 変更後の record と更新時刻を確認し、利用者へ確認済み範囲だけを報告します。

API key、token、認証 header、会話全文、不要な個人情報は保存しません。ログには memory 本文を出さず、必要な場合でも record 種別・処理結果・相関 ID の安全な要約に限ります。

## 検索と context

初期版の検索はSQLiteの構造化queryとFTS5全文検索を使います。LifeState、発話に関連するWorldMemory、直近task、現在の利用者に紐づく事実・場所・約束・Episodeを優先し、合計を`MEMORY_CONTEXT_LIMIT`以内に制限します。embedding searchやvector databaseは、検索不足を実測してから追加を判断します。

LLM へ渡す context には、record の source と観測時刻を含めます。これにより「利用者が明示した事実」「Minecraft で観測した事実」「未確認の推測」を区別して応答できます。

## 再起動とバックアップ

SQLite migrationはversion管理し、v1からLifeState / WorldMemoryを加えたv2へ既存recordを保持して前方更新します。graceful shutdownはtaskをsuspendedへ遷移し、checkpointとmemoryの書込み完了後に終了します。再起動後は人格設定、利用者情報、場所、約束、Episode、WorldMemory、直近の作業結果・failure reasonを復元し、未確認taskを自動でcompletedにしません。

バックアップはアプリケーション停止後、または SQLite の backup API を使って整合した snapshot を取得します。WAL を利用する database を単純な file copy で保全する運用は避け、復元演習では本番の記憶を上書きしません。具体的な運用手順は [operations.md](operations.md#sqliteのバックアップと復元確認) を参照してください。

## 検証境界

unit / integration test は保存、検索、訂正、削除、矛盾、migration、再起動復元を test database で検証します。2026-08-25の実環境E2Eでは、実Minecraft chatと実LLMを通じて利用者が明示した情報を構造化保存し、application再生成・Minecraft再接続後に同じSQLiteから復元して応答へ利用できることを確認しました。実内容、player情報、会話、追跡IDは公開証跡へ保存していません。
