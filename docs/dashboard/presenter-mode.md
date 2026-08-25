# Presenter Mode

## 目的と表示境界

Presenter Mode は、保存済みまたは接続中の実 trace を画面共有するための overlay です。実際の event に基づく stage、status、summary を大きく表示し、独自の demo event、成功判定、固定 trace を作りません。

- run が `recorded` なら `Recorded real trace` と表示
- live run なら `Live real trace` と表示
- stage、status、結果 summary を表示
- 全画面 / 全画面終了を切り替え
- 内部 ID、token 詳細、raw payload、利用者名、座標、記憶本文を overlay に表示しない
- Presenter 中は Inspector の sequence、attributes、Raw DTO disclosure を閉じる / 非表示にする

Presenter の summary は `actualResult`、次に `summary` を使います。どちらも保存済み trace の値であり、未提供の判断理由や結果を生成しません。判断要約がない場合は `判断要約なし` として扱います。

## demo-safe workflow

Trace list の `Demo-safe 管理` で次の順に操作します。

1. 保存済み run を選択する。
2. 完了済みの run で `demo-safe にする` を実行する。
3. backend が全 persisted event 数、terminal status、redaction を確認し、`presenter-v1` manifest を保存する。
4. `export` を実行して `recorded-real-trace` JSON を取得する。
5. 別の dashboard で `import` を選び、demo-safe bundle を読み込む。

未完了 run、event count が一致しない run、manifest がない run、demo-safe でない bundle は export / import を拒否します。bundle を編集して成功 status や event を書き換える機能はありません。

## redaction

`presenterSafeEvent` は次を削除または置換します。

- event / span attributes
- span の input / output / memory references
- input / output token metrics
- `sensitive` な summary、decision、actual result、verification result
- summary に含まれる secret、IP、UUID、座標表現

Presenter UI の表示制限と demo-safe export は別の境界です。画面共有では overlay に表示する項目を制限し、持ち出す JSON は demo-safe 化を完了してから export します。公開物へ実 trace を転載せず、架空 fixture だけを sample として使います。

## 現在の証跡

browser test は fictional recorded fixture で Presenter Mode の表示境界を確認します。実 Minecraft / 実 OpenAI の latest-head trace を Presenter で再生した actual E2E は未実施です。
