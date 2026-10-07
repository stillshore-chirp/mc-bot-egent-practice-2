---
name: github-delivery
description: "GitHubのIssue・PR・reviewを扱う時、リポジトリ固有のIssue根拠、Minecraft観測境界、公開安全性を参照する。共通の配送運用は実行環境の指示に従う。"
---

# GitHub成果物のrepository固有基準

## 発動条件

GitHubのIssue、PR、review内容を作成・更新・調査する作業で、製品固有の根拠や公開安全性を確認する時に使います。共通のbranch、commit、CI、review、merge、closeの運用は実行環境の指示を正本とします。

## Issueに記す製品根拠

[Issue品質基準](../../../docs/ai-governance/14-issue-quality-gate.md)に沿って、Minecraft製品の観測事実、ユーザー報告、code上の仮説、未確認事項を区別します。Issue本文へ載せる情報は[公開安全性checklist](../../../docs/security-publication-checklist.md)に沿って一般化します。

## PR・reviewの製品証跡

ゲーム内actionの結果を説明する場合は、command受付やLLM応答だけを根拠にしません。実際に観測したMinecraft状態と、観測できていない範囲を分けて記します。[実環境調査Skill](../production-investigation/SKILL.md)と[evidence境界](../../../docs/ai-governance/03-evidence-and-completion-gates.md)を参照します。

Issue、PR、comment、artifactでの識別子・実データの扱いは[security-publication Skill](../security-publication/SKILL.md)を参照します。
