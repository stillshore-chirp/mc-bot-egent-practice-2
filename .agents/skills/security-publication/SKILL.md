---
name: security-publication
description: "gitやGitHubへ掲載するMinecraftコンパニオンの文書・evidenceから、credential、個人情報、実環境の識別子や内容を除外する。"
---

# 公開安全性のrepository固有基準

## 発動条件

gitへ入る文書、Issue / PR、log要約、sample、fixture、screenshot、trace、artifactに、Minecraftコンパニオンや実環境の情報が含まれる時に使います。一般的な公開手順は実行環境の指示に従います。

## 製品固有の公開境界

- credential、username、UUID、IP、server address、world seed、私的な座標を含めません。
- 会話全文、LLMのraw入出力、永続記憶の内容、実環境log原文、追跡可能なIDを含めません。
- screenshot、trace、video、artifactの表示範囲外、metadata、file名にも実識別子がないか確認対象にします。
- 公開証跡は一般化した環境区分と、判断に必要な観測結果だけにします。

詳細な情報分類は[公開安全性checklist](../../../docs/security-publication-checklist.md)を参照します。
