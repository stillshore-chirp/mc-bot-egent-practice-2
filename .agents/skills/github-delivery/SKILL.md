---
name: github-delivery
description: "リポジトリ変更を、主Issue、専用branch、論理的なcommit、push、非ドラフトPR、latest headのCI・review・thread・mergeability確認まで安全に配送する時に使う。"
---

# GitHub配送Skill

## 発動条件

製品code、test、script、workflow、schema、挙動を変える設定に加え、gitへ入る文書、rule、Skill、adapter、templateの追加・変更・削除で使います。read-onlyの調査や相談だけでは発動しません。

## 1. 開始前

- ルートと変更対象に最も近い `AGENTS.md` を読む。
- repository、remote、default branch、現在branch、未commit差分、直近履歴をread-onlyで解決する。
- 無関係な差分の所有者と範囲を確認し、巻き込まない。
- 編集前に、依頼を完全に含む主Issueを検索し、Issue品質ゲートを確認する。
- 該当する既存Issueがなければ、Issue品質ゲートを満たす主Issueを編集前に作成する。
- default branchの最新状態から専用branchを作る。ユーザー指定または既存PRのbranchを優先し、それ以外の標準名は `agent/<purpose>` とする。
- detached HEADでは編集せず、既存PRを継続する場合はIssue・branch・PRが同じ作業を指すことを確認する。

## 2. Issue

- 主Issueは一つに絞り、背景、根拠、現在と目標、範囲、非対象、受け入れ条件、検証、公開安全性、riskを記録する。
- 外部の正本を参照する場合は、repository、branchまたはversion、commit SHA、確認日を記録する。
- 既存Issueの不足は編集前に本文または追跡可能なcommentへ補う。
- 作業中に範囲、判断、確認済み事実が変わった場合は、PRだけに閉じ込めずIssueへ反映する。

## 3. 実装とcommit

- 真のblockerがない限り、調査、実装、検証、配送を同じtaskで継続する。
- 目的を満たす最小十分な差分を作り、非対象を先行実装しない。
- commitは独立してreview・revertできる一つの論理的責務または受け入れ条件の単位にする。関連test、文書、schema、生成物は同じcommitへ含める。
- `git add .` と `git add -A` を使わず、stageするpathを明示する。
- commit前にstaged file名、staged diff、`git diff --check`、secret・実データ・無関係差分の不在を確認する。
- commit messageは変更の責務を短く表す。

## 4. pushとPull Request

- remote、base、head、主Issueを再確認してからpushする。
- 同じheadの既存PRがあれば更新し、重複PRを作らない。
- 通常配送では非ドラフトPRを作成または更新する。Draftはユーザーが明示した場合、または未完成設計の早期確認が必要な場合だけ使う。
- 主Issueを完全に解決し、merge時のcloseを意図する場合は `Closes #N`、部分対応または関連付けは `Refs #N` とする。
- PR本文には変更、保持した状態、検証、未実行項目、公開安全性、CI・review欄、残るrisk、外部正本のcommit SHAを記録する。

## 5. CIとreview

- latest headに紐づくpush CIとpull_request CIを確認する。失敗時はlogから原因を特定し、修正、commit、push、再確認する。
- CI成功後、latest meaningful changeに対するGitHub上で確認可能な自動または人間のreview、review comment、review threadを確認する。
- actionableな指摘は一つのreview cycleでまとめて確認し、修正を責務単位のcommitへ分けてpushした後、latest headで関連CIと該当reviewを再確認する。
- 対応済みthreadは、修正がlatest headへpushされ、関連検証が成功した後だけ、根拠を返信してGraphQL thread IDで解決する。
- latest meaningful changeに対するclean reviewが1回得られ、actionableな未解決threadがなく、GitHubのmergeabilityがcleanならreviewを収束する。同一headでclean結果を増やすためだけの再reviewを行わない。
- reviewが提供されない場合、自己reviewを補助証跡として行い、GitHub上のreview確認の代替にはしない。

## 6. 権限境界と終了

- ソースコード変更依頼は、Issue作成・更新、branch、commit、push、非ドラフトPR、CI再実行、review修正・返信、対応済みthread解決、mergeability確認までの通常配送を許可する。
- merge、Issue・PRのclose、release、deploy、force-push、公開済み履歴の書換え、破壊的操作は、対象を特定した別の明示指示がある場合だけ行う。
- blockerでは、失敗しているcheckまたは操作、証跡、試した対応、未完了範囲、次の最短actionを報告する。
- 最終報告にはIssue、branch、commit、PR、local verification、CI、review、thread、mergeability、remaining riskのうち関係するものを示す。
