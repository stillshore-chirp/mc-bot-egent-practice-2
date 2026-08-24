---
name: security-publication
description: "gitへ入る文書、Issue・PR本文、log要約、sample、screenshot、証跡を作成・更新する時に、秘密情報、個人情報、実環境情報の露出を防ぐ。"
---

# 公開安全性Skill

## 発動条件

gitへ入るfile、Issue・PR本文、comment、log要約、sample、screenshot、trace、artifactの追加・更新で使います。判定基準は [`docs/security-publication-checklist.md`](../../../docs/security-publication-checklist.md) を正本とします。

## 1. 棚卸し

- 公開先と、追加・更新する全file、本文、添付物を列挙する。
- source、generated artifact、log、screenshot、sample dataを区別する。
- 外部入力や実データをそのまま転載していないか確認する。

## 2. 最小化

- secret、credential、個人情報、実環境log原文、追跡可能なIDを掲載しない。
- Minecraft username、UUID、server address、IP、world seed、私的座標を掲載しない。
- 会話全文、LLM入力・出力、永続記憶の実内容を掲載しない。
- 必要な事実だけを要約し、識別子は一般化またはmaskする。
- sampleとfixtureは架空の最小データを使う。

## 3. 検査

- unstaged、staged、commit予定の差分と新規fileを目視する。
- secret scan、不可視文字、`git diff --check`、link検査など利用可能な確認を実行する。
- screenshot、trace、video、artifactは画面外、metadata、file名も確認する。
- 公開判断が不明な値は掲載せず、安全な要約へ置き換える。

## 4. 漏洩時

- 追加のcommit、push、commentを止める。
- 値を回答やIssueへ再掲しない。
- credentialはrotateまたはrevokeを優先する。
- 履歴、cache、artifact、fork、外部共有先への残存範囲を評価する。
- file修正だけで完了扱いにしない。

## 5. 報告

確認した対象、実行した検査、一般化した情報、検出結果、未確認項目、残るriskをPRへ記録します。公開禁止値そのものは報告へ含めません。
