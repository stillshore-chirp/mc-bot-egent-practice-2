---
name: production-investigation
description: "Minecraftサーバー、AIコンパニオン、LLM、記憶、ゲーム内状態を扱う時、観測事実とcode上の仮説を分ける。"
---

# Minecraft実環境の観測基準

## 発動条件

Minecraft server、bot接続後の挙動、AIコンパニオン、LLM、記憶、ゲーム内結果など、実環境状態や実データを判断する作業で使います。local codeだけの作業には適用しません。

## 成功・失敗の根拠

- code、config、local再現だけでMinecraft実環境の状態を断定しません。
- 実環境log、runtime観測、Minecraft内の結果を確認した場合だけ「実環境で観測」と表現します。
- ゲーム内actionの成功は、command受付やLLM応答でなく、位置、体力、inventory、危険、採掘・建築などの結果で判断します。
- 調査対象に応じて、server version、接続状態、bot action、記憶storeの整合性、processの状態を証跡候補にします。
- ローカルprocessの状態確認には `npx tsx scripts/inspect-process.ts <PID>` を使います。出力はPID・親PID・stateだけで、argsや環境変数は含みません。
- 対象環境、観測時間・条件、実際に確認した状態を記し、code上の仮説と未確認事項を分けます。

## 製品の安全境界

ownerの永続停止、通常のBukkit・server権限、認証・認可、外部アクセス境界を守り、credential、shell、任意コード、server admin accessをLLMへ公開しません。実環境の識別子、会話、記憶、log原文を公開物へ含めません。詳細例は[公開安全性checklist](../../../docs/security-publication-checklist.md)を参照します。

このSkillは製品固有の観測基準を示します。共通の作業順序と権限判断は実行環境の指示に従います。
