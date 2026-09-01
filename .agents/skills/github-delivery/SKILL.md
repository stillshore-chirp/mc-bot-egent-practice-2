---
name: github-delivery
description: "ソースコード変更とIssue、branch、commit、push、PR、CI、review準備をIssueからマージ可能な状態まで配送するときに使う。latest headとmergeabilityを確認し、merge/closeは別の明示指示が必要。"
---

# GitHub配送 Skill

## 発動条件

製品コード、test、script、workflow、schema、挙動を変える設定の追加・変更・削除では、大小を問わず必ず発動します。ソースコード変更依頼は、IssueからGitHub上のマージ可能状態まで通常配送する依頼を兼ねます。read-only調査や回答だけでは発動しません。

## 1. 開始前

- ルート `AGENTS.md` と変更対象に最も近い `AGENTS.md` を読む。
- 現在のdefault branch、作業branch、未commit差分、直近履歴を確認する。
- 無関係な差分の所有者と範囲を確認し、巻き込まない。
- ソースコード編集前に主Issueと専用branchを確定する。detached HEADでは編集せず、既存PRを継続する場合はIssue・branch・PRが同じ作業を指していることを確認する。
- 利用可能で認証済みのGitHub clientを使い、同等clientの利用を妨げない。

## 2. Issue

- 既存Issueを検索し、依頼を完全に含むものがあれば使う。
- ソースコード変更は規模や種類にかかわらず主Issueを必須とし、既存Issueがなければ編集前に作成する。同一PR内のreview修正は、そのPRの主Issueを継続して使う。
- ソースコードを含まない文書やメタデータだけの軽微な変更でIssueを省略する場合は、PR本文へ短い理由を書く。
- [`docs/ai-governance/14-issue-quality-gate.md`](../../../docs/ai-governance/14-issue-quality-gate.md)に従い、理由、根拠、現在と目標、範囲、非対象、受け入れ条件、検証、リスクを書く。
- Issue本文の各受け入れ条件は、対応するテスト、画面、ログ、文書、手動確認などの証拠と照合し、確認できた条件だけを `[x]` に更新する。未確認または未達の条件は `[ ]` のまま残し、理由、影響、次に確認する方法をIssueへ記録する。本文を変更できない事情がある場合は、その事情を示して同じ内容をIssueコメントへ記録する。
- 受け入れ条件のチェック更新は証拠の記録であり、merge / closeの権限または判断を拡張しない。merge / closeは「6. 権限境界と終了」に従い、対象と権限が明示された場合だけ行う。
- Issueのタイトルと本文は日本語を原則とし、タイトルは対象と変更または問題が判別できる具体的な日本語にする。固有名詞、製品名・ライブラリ名、code identifier、version/path、GitHub構文は正本の例外に従って維持できる。
- レビュー結果を主因として別Issue化する場合は、正本の `[レビュー指摘]` title、`レビュー指摘` label、由来・severity・観測事実・影響・別追跡理由・UX・scope・acceptance・verification・公開安全性を満たす。根拠不足のレビュー起因分類や、同一PRの主Issueからの分離はしない。

## 3. Branch、実装、commit
<!-- agent-harness:delivery-stack:start -->

- default branchの最新状態から作業branchを作る。標準名は `agent/<purpose>` とし、既存branchやユーザー指定がある場合はそれを尊重する。
- 複数工程でも、真のblockerがない限り調査、実装、検証、配送まで継続する。
- 実装前に、受け入れ条件と依存関係から予定commitの責務、関連test・文書、実装順序を決める。責務の境界が実装中に変わった場合は、次の編集前に計画を更新する。
- 実装後は `focused_verification → code_freeze → measurement → publication_freeze → external_gate → review_fix → accepted` のcheckpoint順で進める。各段階の開始・終了条件、snapshot、入力閉包、未確認範囲を記録し、詳細なstate契約は [`docs/agent-harness.md`](../../../docs/agent-harness.md) を参照する。
- full suite、coverage、外部CI、包括reviewなどの高コストgateは、code・測定scope・公開境界・再取得条件をfreezeした後に開始する。変更種別ごとの既存gate mapを使い、回数を固定する追加ルールは設けない。
- stacked PRでは、親PR・子PRのbaseと依存順を記録し、親PRの最終HEADをmerge前に確定して、そのmergeを検証の境界として扱う。親merge前の子PRは変更に対応するfocused testに留め、親merge後に子PRを更新されたbaseへ統合する。
- commitは独立してreview・revertできる一つの論理的責務または受け入れ条件の単位にする。関連するtest、文書、schema・client等の生成物は同じcommitへ含める。
- 一つの責務の実装・関連test・文書・検証が完了したら、次の独立責務を編集する前にstage確認とcommitを完了する。複数責務を共有作業ツリーへ蓄積し、最後に全差分を再読して後付け分解しない。
- サブエージェントの完了報告を受けたら、実装・focused verification・review fixはsubagent-firstで担当する。メインは担当fileと差分をreviewし、責務単位でcommitへ回収する。他担当の差分はstageしない。
- 作業時間、行数、担当者だけを理由にcommitを分割または一括化しない。
- `git add .`と`git add -A`を使わず、stage対象のpathを明示する。commit前にstaged file名、staged diff、`git diff --cached --check`、working treeの`git diff --check`、secret・実データ・無関係差分の不在を確認する。
- commit messageは変更の責務を短く表す日本語にする。
- ソースコード変更依頼はcommit、push、非ドラフトPR作成・更新、CI再実行、reviewへの返信・修正、対応済みthreadの解決までを許可する。これらの通常配送について追加の包括確認を求めない。
<!-- agent-harness:delivery-stack:end -->

## 4. PR

- ソースコード変更では非ドラフトPRを作成または更新し、GitHub上の完了ゲートまで継続する。
- 主Issueは1つに絞る。完全解決は`Closes #123`、部分対応は`Refs #123`を使う。
- PRのタイトルと本文も日本語を原則とし、Issue欄、変更理由、検証、未実行項目、リスクを日本語で記録する。自動生成bot PRは作成時の完全な日本語化を制御できない場合があるため、agentが更新または配送する前にタイトルと本文を正規化し、未正規化範囲を明記する。
- PR本文には、変更内容、保持した挙動、検証、未実行項目、対象面の証跡、公開安全性、残るリスクを書く。
- 公開物では公開安全性Skillの成果を反映し、Minecraft実環境調査では実環境調査Skillの観測境界を守る。

## 5. CIとreview
<!-- agent-harness:delivery-review:start -->

- latest headに紐づく対象branchのCIを確認し、成功後はlatest-head review、未解決thread、mergeabilityも確認する。失敗時は原因を特定し、修正、commit、push、再確認する。
- 開発中とreview修正中は変更pathに対応するfocused testを使い、最終HEAD確定前にfull gateを機械的に繰り返さない。
- 配送対象の最終HEADでは、変更範囲に必要な検証を入力閉包へ束縛して一度実行する。ガバナンス変更では `python3 scripts/validate_governance.py` を使い、同じsnapshot・条件の検査を重ねない。stacked PRは親merge後にbase統合、必要な検証、latest HEAD reviewを確認する。
- workflowまたは検証分類を変更した場合は、変更pathに対応するcontract test、YAML parse、`base...head` classification、latest Actionsを選択する。製品runtimeに影響しない場合、無関係なfull suiteや実環境操作を追加しない。workflow未変更のreview fixでは、既存のYAML証跡を保持する。
- gateの入力閉包は、変更path、関連設定、生成物、実行条件の集合とする。`gate / HEAD・base / input closure / conditions / result / artifact reference` をcompact ledgerへ記録し、失効時は `invalidation reason / reacquire scope`、判定不能時は `fallback reason` を残す。laneとevidence packageのschemaは [`docs/agent-harness.md`](../../../docs/agent-harness.md) を正本とする。
- measurement後にreportやPR本文を更新した場合は、測定scope外のpublication annotationとして扱うか、publication gateを別に記録する。更新後の内容を同じmeasurement evidenceへ黙って混ぜず、必要なら交差するgateだけを再取得する。
- 同じHEAD・入力閉包・条件で成功したgateは再実行しない。新commitだけではlocal full gateを一括失効させず、閉包と交差する変更だけを失効させる。閉包が同じ証跡を後続HEADで再利用する場合は、由来HEADと新しいHEADをledgerへ併記する。
- 同一HEADの再pushはlocal/full gate/review証拠を保持し、そのHEADで開始したCIだけ確認する。
- base変更・base統合ではbase依存のCI、review、thread、mergeabilityを失効させ、local gateは入力閉包が変わったものだけ再取得する。review threadの解決はthread状態だけを更新し、他の証跡を失効させない。判定不能時は理由付きで広いgateへfallbackし、skipしない。
- PR監視では各runの冒頭に`state`を含む軽量状態キー（`state`、`headRefOid`、`updatedAt`、`reviewDecision`、`mergeStateStatus`）を取得し、`state`を終端判定の最優先入力にする。`state`が`MERGED`または`CLOSED`なら、そのrunで監視を終了してscheduled taskを削除し、review本文・thread・CI・mergeabilityなどの詳細を取得しない。`mergeStateStatus=UNKNOWN`や`reviewDecision`の空値でも、終端`state`を覆さない。
- `state=OPEN`かつ外部待ちが必要な場合は監視を継続する。軽量状態キーに変化がない間は詳細照会をせず、イベントまたはbackoff付きの再待機だけを行う。
- 無変化の外部待ちでは固定timeout回数を完了条件にせず、logical checkpointまたはdeadlineで継続の必要性を再評価する。継続不要と判断した場合は監視とscheduled taskを停止し、停止理由と未確認範囲を通知する。
- 待機中に返すのはHEAD、success / failure / pending / skip count、changed checks、failure detailだけとし、TTYの全表再描画を流さない。状態キーが変わらない間は詳細を再取得せず、timeoutだけでは証拠を失効させない。failureまたはfinal時だけ詳細を取得する。
- read-only照会はbounded field、bounded result、小さい合計出力に限定し、PR本文と全check一覧を同じ結果へ詰め込まない。長いraw logは一時artifactへ退避し、成功時は全体結果・閾値・artifact参照だけ返し、file別coverageや反復行は返さない。
- actionableな指摘はまとめて修正し、正本のreview予算と限定条件に従って変更後の証拠を再確認する。
- 正本のreview収束条件を満たし、actionableな未解決threadがなく、GitHubのmergeabilityがcleanで、CIと必須条件を満たせばreviewを終了する。
- 変更のないheadでclean結果を増やすためだけの再レビューを行わない。
- ソースコード変更でコードレビューが提供されない場合、自己レビューは補助証跡に限り、完了条件の代替にしない。未完了のblockerとして報告する。
<!-- agent-harness:delivery-review:end -->

## 6. 権限境界と終了
<!-- agent-harness:delivery-exit:start -->

- merge直前は再確認済みの単一snapshotへlatest HEAD、base（親merge含む）、CI、latest-head review、未解決thread、mergeabilityを記録する。snapshot後にHEAD・base・CI・review状態が変わった場合は、該当証拠を失効して更新する。最終delivery judgmentはprimaryがacceptance、CI、review、thread、mergeabilityを照合して行う。
- merge、Issue / PRのclose、release、production deploy、破壊的変更は、対象を特定した別の明示指示がある場合だけ行う。
- blocker報告には、失敗しているcheckまたは操作、証跡、試した対応、未完了範囲、次の最短アクションを含める。
- 最終報告には、Issue、branch、commit、PR、local verification、CI、review、remaining risksのうち今回に関係するものを示す。
<!-- agent-harness:delivery-exit:end -->
