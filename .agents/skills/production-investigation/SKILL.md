---
name: production-investigation
description: "Minecraftサーバー、AIコンパニオン、LLM、記憶、ゲーム内状態などの実環境障害や実データ異常を、観測証跡とコード上の仮説を分離して調査する。"
---

# 実環境調査 Skill

## 発動条件

Minecraftサーバー、bot接続後の挙動、AIコンパニオン、LLM、記憶、ゲーム内結果など、実環境の障害や実データ異常を調査する時に使います。local codeだけの調査には必須ではありません。

## 調査契約

- 対象、利用者影響、発生時間帯、期待挙動、環境区分、許可された操作を先に固定します。
- コード、設定、local再現だけで実環境状態を断定しません。
- 実環境log、runtime観測、Minecraft内の結果を確認した事実だけを「実環境で観測」と表現します。
- 確認できない範囲は、コード上の仮説、再現条件、未確認事項として分離します。

## 観測証跡

状況に応じてread-onlyで次を確認します。

- Minecraft serverのversion、接続結果、botのevent・action結果
- ゲーム内の位置、体力、空腹、inventory、危険、作業結果
- bot runtime、Mineflayer、LLM providerのstatusと安全に要約したerror分類
- 記憶storeの対象record、更新時刻、整合性
- host、process、CI、deploymentのcommitと実行状態
- 実環境とrepositoryのconfig差

何を、どの環境で、どの時間範囲・条件で確認したかを記録します。公開物には実識別子やlog原文を載せません。

## 安全性と権限

- read-only確認を優先します。
- bot操作、worldまたは記憶の変更、server再起動、rollback、traffic変更、再deploy、secret変更は、対象と影響を示し、別の明示指示を得てから行います。
- 即時停止と安全境界をLLM出力より優先します。
- secret、token、Cookie、認証header、個人情報、player情報、会話全文、記憶内容を表示・記録しません。
- 実環境情報を外部LLMへ渡す場合は、最小化とmaskを先に行います。
- Issue、PR、運用文書を作る場合はsecurity-publication Skillも適用します。

## 原因判定と報告

原因を断定するには、観測された異常、説明するcode/config/data、再現・対照確認・修正後確認のいずれか、主要仮説を除外した根拠を接続します。接続できない場合は最有力仮説または未特定と報告します。command受付やLLM応答だけでMinecraft actionの成功とせず、ゲーム内の結果で確認します。

報告には、観測事実と環境、影響範囲、原因または仮説と確度、実施した確認・対応、実施していない操作、残るrisk、次の最短actionを含めます。実環境へ到達できない場合は、その理由、確認済みlocal範囲、残る不確実性を明記します。
