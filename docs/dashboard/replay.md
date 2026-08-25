# Live と Replay

## 共通の event 適用

Live と Replay は別の表示用データを作りません。`traceReducer` の event 適用処理を共有し、span、link、result、progress、run status、sequence integrity を同じ規則で更新します。Replay は選択した保存 trace の detail と events を取得し、指定位置まで event を順に reducer へ渡します。

保存済み trace の `source` が `recorded` の場合、選択後の表示 mode は Replay になります。上部 status bar と controls に `Recorded / Replay` を表示し、Live の SSE 表示と区別します。

## Live

Live の初期化では health と trace list を取得し、最初の保存 run があれば detail / events を選択します。`/api/stream` は SSE で、接続状態を `connecting`、`connected`、`reconnecting`、`disconnected` として表示します。health は一定間隔で再取得し、API failure は `offline` または `観測性劣化` として扱います。

新しい SSE event が既知の trace に属する場合は一覧と選択中の state へ適用します。未知の trace は list を再取得し、保存されてから選択します。保存されていない event を UI の実行結果として生成しません。

SSE 再接続では server の `Last-Event-ID` backfill と browser 側の event ID / stream ID 検査を組み合わせます。重複、順序逆転、stream gap が見つかった場合は event を重複適用せず、integrity banner と `観測性劣化` を表示します。

## Replay controls

Replay では次の controls を使えます。

- `再生` / `一時停止`
- `戻る` / `進む` による 1 event 移動
- `0.25x`、`0.5x`、`1x`、`2x`、`4x`
- Timeline の range input による任意位置への seek
- 現在 event と original timestamp の表示

イベントが空の場合は Replay button を無効化します。表示される node、result、status は保存 event の prefix から計算し、実行していない成功や候補を補完しません。

## demo-safe recorded trace

Presenter 用の保存済み trace は [Presenter Mode](presenter-mode.md) の手順で demo-safe 化します。bundle を import した run は `source: recorded` となるため、通常の Live run と混ざって成功を装いません。bundle の内容、schema version、event count、末尾 root completion が検証されます。

## 限界

browser fixture による Replay は reducer と画面操作の検証です。実 Minecraft server の実 trace を現行 latest HEAD で Replay した actual E2E は未実施です。過去の別 HEAD で取得した trace を current completion evidence として扱いません。
