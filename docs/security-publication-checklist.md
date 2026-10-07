# 公開安全性のrepository固有例

この文書は、Minecraftコンパニオンの公開物から除外する情報と、公開用に一般化できるevidenceを示します。共通の公開作業手順は実行環境の指示に従います。

## 公開物へ含めない情報

- API key、token、Cookie、認証header、private key、credential file
- 氏名、mail address、連絡先などの個人情報
- Minecraft username、UUID、IP address、server address、world seed、私的な座標
- 会話全文、LLMへの入力・出力、永続記憶の実内容
- 実環境log原文、完全なquery、正確なhost・process情報
- request、trace、job、session、playerなどを追跡できるID
- 攻撃に直接使える未修正脆弱性の詳細な再現情報
- local absolute path、credential store、認証状態の詳細

必要な事実は、識別子や私的内容を含めずに一般化します。再現用sampleやfixtureは架空の最小データを使います。

## Minecraft実環境evidence

公開時に使える情報は、証跡の種別、一般化した環境区分、時間範囲、公開可能な観測結果、判断への影響です。server、player、world、memoryを追跡できる値やraw logは転載しません。

## artifact固有の注意

screenshot、video、trace、artifactは表示範囲外、metadata、file名にも実識別子や機密が含まれないよう扱います。判断が不明な値は公開可能な要約へ置き換えます。
