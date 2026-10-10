# PlayerBody

`PlayerBody`は、コンパニオンruntimeと接続中のMinecraftプレイヤーの間にある操作・観測境界です。`MineflayerClient.createPlayerBody()`がインスタンスを返し、`observe()`、`execute(operation, signal?)`、`knowledge(query)`、`onEvent(listener)`、`stop()`を提供します。公開契約と実装は[player-body.ts](../src/minecraft/player-body.ts)、操作入力の検証は[player-body-schema.ts](../src/minecraft/player-body-schema.ts)、観測は[player-body-observation.ts](../src/minecraft/player-body-observation.ts)、registry知識は[player-body-knowledge.ts](../src/minecraft/player-body-knowledge.ts)が正本です。

## 対応操作

操作名の正本はschemaにある31種類です。

- 移動・視線: `move_to`、`move_relative`、`look`、`look_sweep`、`control`
- 装備・interaction: `equip`、`use`、`attack`
- ワールド変更: `dig`、`place`、`craft`
- 画面・inventory: `open_window`、`window_click`、`window_transfer`、`window_close`、`consume`、`toss`、`transfer`
- 収集・活動: `collect_item`、`fish`、`sleep`、`wake`、`mount`、`dismount`、`move_vehicle`、`elytra_fly`、`trade`、`enchant`、`anvil`、`write_book`、`update_sign`

いずれも通常プレイヤーの能力であり、対象の可視性、所持品、protocol対応、Minecraftの物理挙動、server権限に従います。任意command、shell、server管理、credential、権限迂回は公開しません。旧Bot専用の木材・建築・action-ledger制限も適用しません。

## 結果と停止

`execute()`は入力を検証し、実行前の観測を記録して、上限付きの操作を実行します。結果`PlayerOperationResult`にはoperation ID、時刻、実行前後の観測、状態が含まれます。

- `successful`: 観測したワールド状態、または必要な状態変化と一致するserver eventで効果を確認した。
- `failed`: 操作を実行できなかった。一部の既知のinventory・registry上の失敗には安定した`failureReason`が付く。
- `interrupted`: 確認前にcancelされた、またはBotのlife・接続が変化した。
- `unverified`: 要求は処理されたが、利用できる証拠では効果を確認できなかった。

Mineflayerの呼び出しが受理されたことだけでは成功としません。たとえばitem収集は対象一致のpickup eventとinventory増加の両方を確認し、攻撃命中と対象の死亡も別の結果として扱います。`sameLife`がある結果では、操作中にBotのlifeが維持されたかを示します。cancel後もMineflayerの処理が残る場合は`recoveryRequired: true`を返してrecovery eventを発行し、処理が完了するか再接続するまで次の操作を開始しません。

`stop()`は待機中のadmissionと実行中の操作をcancelし、移動などの入力を解除して、開いている画面を閉じます。実行中の操作だけを止める`stopActiveOperation()`もあります。ownerによるruntimeの停止・再開と永続停止ラッチは[自律プレイヤー](autonomous-player.md)を参照してください。

## 観測の範囲

観測はMineflayerが受信した情報と、Bodyが返す上限付きの可視subsetを表します。blockやentityが含まれないことは、存在しない証拠にはなりません。近くの敵対entityの集計も、clientが受信した範囲内の値であり、world全体の不在を示しません。不明な値は`null`で返し、ownerの座標は呼び出し元が明示的にowner-position例外を指定した場合だけ含めます。`knowledge(query)`はversion付きregistryの事実と推論を分けて返し、server内部の一括取得には使えません。

操作対応は、任意のserverやprotocolで成功する保証ではありません。runtimeはBodyの結果と再観測をもとに次の判断を行います。local testはコード契約を確認し、Minecraft内での受け入れは要求した効果を別途観測して判断します。
