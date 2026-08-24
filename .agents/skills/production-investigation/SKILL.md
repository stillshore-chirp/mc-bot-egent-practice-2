---
name: production-investigation
description: "Minecraftサーバー、AIコンパニオン、LLM、記憶、ゲーム内状態などの実環境障害や実データ異常を、観測証跡とcode上の仮説に分けて調査する時に使う。"
---

# 実環境調査Skill

## 発動条件

利用者が実環境の障害、実データ異常、接続後のbot挙動、ゲーム内結果を調査するよう求めた場合に使います。local codeだけの調査には必須ではありません。

## 1. 調査契約

- 調査対象、利用者影響、発生時間帯、期待挙動、対象環境、許可された操作を特定する。
- code、config、local再現だけで実環境状態を断定しない。
- 実環境log、実データ、Minecraft内の観測を確認した事実だけを「実環境で観測」と表現する。
- 確認できない範囲は、code上の仮説、再現条件、未確認事項として分離する。

## 2. 証跡

存在する構成と依頼範囲に応じて、次をread-onlyで確認します。

- Minecraft serverの状態、version、接続結果、安全に要約したlog
- bot runtimeまたはMineflayerの接続・event・action結果
- game内で観測した位置、体力、空腹、inventory、危険、作業結果
- LLM providerのstatus、error分類、安全に要約した相関情報
- 記憶storeの対象record、更新時刻、整合性
- host、process、CI、deploymentのcommitと実行状態
- 実環境とrepositoryのconfig差

何を、どの環境区分で、どの時間範囲・条件で確認したかを残します。公開物には実識別子やlog原文を載せません。

## 3. 安全性と権限

- read-only確認を優先する。
- bot操作、worldまたは記憶の変更、server再起動、rollback、traffic変更、再deploy、secret変更は、対象と影響を示し、別の明示指示を得てから行う。
- 即時停止と安全境界をLLM出力より優先する。
- secret、token、Cookie、認証header、個人情報、player情報、会話全文、記憶内容を表示・記録しない。
- 実環境情報を外部LLMへ渡す場合は、最小化とmaskを先に行う。
- Issue、PR、運用文書を作る場合は公開安全性Skillも適用する。

## 4. 原因判定

原因を断定するには、次を接続します。

1. 実際に観測された失敗または異常
2. 失敗を説明するcode、config、data、外部状態
3. 再現、対照確認、修正後確認のいずれか
4. 他の主要仮説を除外した根拠

接続できない場合は、最有力仮説または未特定と報告します。ゲーム内actionはcommand受付やLLM応答だけで成功とせず、Minecraft内の結果で確認します。

## 5. 報告

- 観測事実と対象環境
- 影響範囲
- 原因または仮説と確度
- 実施した確認と対応
- 実施していない操作
- 残るriskと次の最短action

実環境へ到達できない場合は、到達不能の理由、確認済みのlocal範囲、残る不確実性を明記します。
