# テストと確認

## 現行ローカル検証

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:high
```

`npm test` はoffline unit / integration suiteです。`npm run test:e2e` は隔離されたローカルMinecraft server copyを使う確認を起動します。実ゲームでの観測がない場合、これらの結果を実Minecraft / OpenAIの成功証拠として扱いません。

`npm run preflight:local -- --server-dir <server-dir> --expected-mode survival --expected-difficulty normal` はloopback限定のserver設定とowner profile metadataをread-onlyで検査します。serverやworldを書き換えません。

## 証拠の境界

| 確認                    | 根拠になること                                               | 根拠にならないこと                        |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| unit / integration      | 型、store、runtime、接続、HTTP契約のコード動作               | 実Minecraftの到達性やLLMの結果            |
| build / typecheck       | 対象HEADがコンパイルできること                               | ゲーム内操作の成功                        |
| isolated acceptance     | 新規copyの限定シナリオでBodyの結果とserver状態を照合したこと | 元worldの安全性、長期安定性、全操作の成功 |
| live Minecraft / OpenAI | 実環境で明示的に確認した操作と観測                           | 未実施ケースや将来の無条件保証            |

ゲーム操作の成功は、PlayerBodyの結果とMinecraft側の状態で別々に確認します。LLMが計画したこと、chatを送ったこと、停止を受け付けたことだけでは完了しません。実環境の確認手順は [ai-player-e2e](ai-player-e2e.md) を参照してください。

## CI

変更pathは `scripts/classify_verification_inputs.py` で `product`、`governance`、`workflow_contract` に分類します。不明なpathはfail closedで全gateを選びます。Product gateはformat、lint、typecheck、テスト、build、high/critical dependency auditを実行します。CI成功はコード検証の証拠であり、Minecraft worldの証拠ではありません。
