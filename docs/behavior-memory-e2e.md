# 行動記憶の受入 E2E

この手順は Issue #35 の行動記憶を、許可済みの隔離 test world で確認するための受入契約です。`#23` の会話履歴確定、`#29` の計画適用、`#20` の通知適用が同じ最新 HEAD に統合されてから実行します。現在の PR #37 には永続化・抽出・tool の単体および再起動テストがあり、この文書の Minecraft / 実 LLM E2E は未実施です。

## 実行境界

実行前に、次の条件を同じ run の preflight として確認します。

- 本番とは分離された test world、bot account、owner account、SQLite database path を使う。
- test world 内の資産、他の利用者、実サーバーの接続先を試験対象にしない。
- `LIVE_E2E_CONFIRMED=true`、接続資格情報、実 OpenAI API の利用権限、プロセス再起動と再接続の許可を確認する。未確認なら外部接続を開始しない。
- bot と owner が同じ test world に入り、owner の chat を画面で確認できる状態にする。
- run の開始時に database を新規作成または専用の空データへ戻す。既存の運用 database を流用しない。
- 受入結果として公開するのは項目ごとの `pass / fail / skip`、失敗分類、再起動・通知適用の成否だけにする。chat 本文、記憶の値、player 名、座標、server address、credential、SQLite 原文を保存・公開しない。

## シナリオ

各シナリオの owner chat は operator が Minecraft の画面で送り、送信後の bot の返答と行動を確認します。単に LLM の返答や chat acknowledgement が届いたことは成功根拠にしません。

| #   | owner の操作                                                                                               | ゲーム内で確認すること                                                                       | 自動観測点・受入条件                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 「今後は専門用語を避け、短く理由を一言添えて説明して」と送る                                               | bot が保存完了を返し、依頼に含まれない移動・採取を開始しない                                 | owner_message の bounded extraction が `owner_explicit` / `explicit` の active record を1件作る。raw message の列・全文は保存されず、同じ受理イベントの再処理でも record は増えない |
| 2   | 話題を unrelated なゲーム内依頼へ変更し、説明を求める                                                      | 話題をまたいで平易な説明と短い理由が反映される。元の好みを安全条件として扱わない             | context に `behavior_memory` の構造化 summary が入り、`memory_read → response` が記録される。同じ active record が検索され、新しい transcript record は増えない                     |
| 3   | 一時的な依頼（「今回はこの場所だけ」「今だけ詳しく」）と単なる質問（「専門用語って何？」）を送る           | 一時的な依頼や質問だけでは継続的な好みとして扱われない                                       | `extractBehaviorMemory` が空を返し、active record 数・対象 slot が変わらない                                                                                                        |
| 4   | 「また同じ確認をしないで」と送り、別の話題で同じ不満をもう一度伝える                                       | 1回目の不満だけで強制的な行動変更をせず、2回目の同じ傾向後に返答方針へ反映する               | 1回目は `owner_feedback` / `repeated_feedback`、2回目で `supportCount >= 2` / `corroborated`。安全・認証・停止判断には影響しない                                                    |
| 5   | bot を停止し、同じ専用 SQLite で application を再起動・再接続する                                          | 再接続後も通常の owner chat に応答し、保存した説明方針が話題変更後にも再適用される           | restart 前後で active record の id、category、slot、confidence、supportCount が一致する。再起動により重複 record や raw transcript は増えない                                       |
| 6   | 「覚えている行動の好みを一覧して」「この好みを、詳しく説明する方へ訂正して」「この好みを忘れて」と順に送る | 一覧、訂正、忘却の結果を bot が返し、忘却後の新しい依頼では旧方針が反映されない              | list は active の構造化 summary だけを返す。correct は旧 record を `superseded`、新 record を active にする。forget は hard delete せず `retracted` とし、通常 context から除外する |
| 7   | task 完了または失敗を、owner の通知が発生する安全な操作で作る                                              | 自動通知にも保存済みの文体方針が反映される。通知から新しい owner preference を勝手に作らない | 通知 context の `memory_read` が active record を読む。`runtime_reassessment` / 通知経路から `remember` / `correct` / `forget` が呼ばれない                                         |
| 8   | owner ではない test player から一覧・保存・訂正・忘却を試す                                                | 権限拒否を返し、既存の記憶・Minecraft 操作・安全境界が変わらない                             | 全 write / read が `REQUESTER_NOT_AUTHORIZED`。active record、superseded/retracted 状態、safety / authorization 設定に差分がない                                                    |

シナリオ 1〜4 は同じ application の会話で実施し、5 は process を実際に再生成します。6 と 7 は統合された自然言語 tool routing を確認します。複数件の active generic preference がある場合の訂正は、曖昧な自動選択をせず owner に対象を確認することが成功条件です。

## 自動観測点

既存の `tests/e2e/live.ts` の operator status に加え、統合後の runner は各入力直後と再起動直後に次の秘密を含まない summary を取得します。

```json
{
  "behaviorMemory": {
    "activeCount": 0,
    "confidenceCounts": {},
    "feedbackSupportCounts": [],
    "supersededCount": 0,
    "retractedCount": 0,
    "restartStable": null,
    "rawTranscriptStored": false
  }
}
```

この値は実際の記憶の `value`、`summary`、chat 本文、player 識別子、database path を出力しません。`activeCount` と confidence / support の変化は専用 SQLite の structured record を直接検査し、`restartStable` は再起動前後の active record の内部比較で算出します。公開用の結果には件数と pass / fail だけを残します。

trace では次の stage と request kind を確認します。

- owner の確定 chat からの自動学習: `memory_write`、`requestKind=owner_message`
- 同じ owner chat の retry: 同じ不透明な event key を使い、support count と active record 数が増えない
- 次の通常依頼・話題変更・自動通知: `memory_read`、該当する `response`
- runtime 再評価、停止、非 owner chat: 行動記憶の write span が存在しない
- 訂正・忘却: 旧 record の status 変更と新しい active record の生成が同じ transaction の結果として確認できる

Minecraft 側では、記憶を保存しただけで action task が開始されていないこと、topic change 後の応答が画面に届いたこと、再起動後に connection が `connected / spawned` へ戻ったこと、自動通知が実際に指定 owner へ届いたことを operator が確認します。保存・検索の成功だけではゲーム内 E2E の成功にしません。

## 失敗時の扱い

次のどれかが起きたらその項目を `fail` とし、同じ test world の状態を追加操作で埋め合わせません。

- 記憶の抽出は成功したが、owner chat と無関係な action task が開始された。
- 1回の質問・一時的な依頼が active preference になった。
- restart 後に record が消える、重複する、confidence / support が意図せず変わる。
- forget 後に旧 preference が通常 context または通知へ戻る。
- runtime reassessment、通知、非 owner chat が記憶を書き換える。
- raw transcript、個人情報、秘密、認証・安全・停止条件を記憶の値として保存・表示する。
- chat の返答だけが成功し、Minecraft の接続・task・通知・再起動状態を観測できない。

実施していない項目は `skip` とし、実施済みの項目だけで Issue の E2E 完了を主張しません。
