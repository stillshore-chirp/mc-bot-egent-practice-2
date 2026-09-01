---
name: security-publication
description: "gitへpushされる文書、Issue・PR、ログ要約、sample、fixture、証跡を作成・更新する時に、秘密情報、個人情報、実環境情報の露出を防ぐ。"
---

# 公開安全性 Skill

## 発動条件

gitへ入る文書、Issue / PR本文、運用記録、調査レポート、sample、fixture、screenshot、trace、artifactを追加・更新する時に使います。詳細正本はdocs/security-publication-checklist.mdです。

## 棚卸しと最小化

- 公開先と追加・更新する全file、本文、添付物を列挙し、source、generated artifact、log、sample dataを区別します。
- secret、API key、token、Cookie、認証header、private key、credentialを残しません。
- 氏名、mail address、Minecraft username、UUID、IP、server address、world seed、私的座標を残しません。
- 会話全文、LLM入力・出力、永続記憶の実内容、実環境log原文、追跡可能なrequest・trace・job・session・player IDを残しません。
- 必要な事実だけを一般化またはmaskして記載し、sample / fixtureは架空の最小データにします。

## 検査

差分と新規fileを目視し、git diff --check、secret scanner、UTF-8、不可視文字、Markdown linkなど利用可能な検査を実行します。screenshot、trace、video、artifactは画面外、metadata、file名も確認します。公開判断が不明な値は掲載せず、安全な要約へ置き換えます。

## 漏洩時と報告

漏洩を見つけたら追加の公開・pushを止め、値を再掲せず、credentialならrotate / revokeを優先します。履歴、cache、artifact、forkへの残存範囲を評価し、file修正だけで完了扱いにしません。PRには確認対象、実行した検査、一般化した情報、検出結果、未確認項目、残るriskを記録します。
