# 公開安全性チェックリスト

この文書は、gitへ入るfile、Issue・PR本文、comment、log要約、sample、screenshot、traceを安全に扱うための判定基準です。Private repositoryも将来の公開、共有、権限変更を前提に同じ基準で扱います。

## 対象の棚卸し

- 公開先と、追加・更新するfile、本文、添付物を特定する。
- source、generated artifact、log、screenshot、sample dataを区別する。
- 外部入力や実データをそのまま転載していないか確認する。

## commit・掲載しない情報

- API key、token、Cookie、認証header、private key、credential file
- 氏名、mail address、連絡先などの個人情報
- Minecraft username、UUID、IP address、server address、world seed、私的な座標
- 会話全文、LLMへの入力・出力、永続記憶の実内容
- 実環境log原文、完全なquery、正確なhost・process情報
- request、trace、job、session、playerなどを追跡できるID
- 攻撃に直接使える未修正脆弱性の過剰な再現情報
- local absolute path、credential store、認証状態の詳細

必要な事実だけを要約し、識別子は一般化またはmaskします。再現用のsampleは架空の最小データを使います。

## 検査

- unstaged、staged、commit予定の全差分と新規fileを目視する。
- `git diff --check`、secret scan、UTF-8、不可視文字、link検査を実行する。
- screenshot、video、trace、artifactは画面外、metadata、file名も確認する。
- dependency、lock file、generated fileにcredentialや実データが含まれないか確認する。
- 判断が不明な値は掲載を止め、安全な要約へ置き換える。

## 実環境調査の証跡

公開物には、確認した証跡の種別、環境の一般化した区分、時間範囲、公開可能な観測結果、判断への影響だけを記載します。原log、正確なserver情報、player情報、会話、記憶内容は転載しません。

## 漏洩を発見した場合

- 追加のcommit、push、commentを止める。
- 値を回答やIssueへ再掲しない。
- credentialはrotateまたはrevokeを優先する。
- git履歴、cache、artifact、fork、外部共有先への残存範囲を評価する。
- fileを削除しただけで完了扱いにしない。

## 報告

PRには、確認した対象、実行した検査、一般化またはmaskした情報、検出結果、未確認項目、残るriskを記録します。公開禁止値そのものは報告へ含めません。
