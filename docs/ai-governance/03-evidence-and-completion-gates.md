# 証跡と完了ゲート

この文書は、リポジトリ変更を完了扱いするために必要な証跡と観測条件を定義します。

## 1. 証跡の原則

- 受け入れ条件ごとに、file差分、test、静的検査、CI、review、実環境観測などの対応する根拠を示します。
- 実行した検証と結果、実行していない検証と理由、残る不確実性を分けます。
- codeから導いた仮説と、Minecraft、外部service、GitHubで実際に観測した事実を混ぜません。
- secret、認証情報、個人情報、実環境log原文、追跡可能な実識別子を証跡に使いません。

## 2. 対象面

現段階の変更対象は主にREADME、repository rule、Issue・PR template、workflowなどのGitHub共同作業面です。次を確認します。

- 変更した文言、項目、順序、必須性、設定
- Markdown、YAML、frontmatterの構造
- link、command、参照先file
- 公開安全性
- previewまたはGitHub上の実表示確認が必要か

GitHubが所有し、このリポジトリが変更しないlayout、keyboard、focus、loading、permission stateへ、製品UIの証跡を要求しません。将来、リポジトリが製品UIを実装する場合は、対象画面、主要状態、操作、accessibility、前後差分に必要な検証を、その設計と同時に定義します。

## 3. 共通完了ゲート

- 依頼の成果と主Issueの受け入れ条件を満たしている。
- 変更対象と非対象が一致し、無関係な差分や製品codeを混入していない。
- 対象に対応するlocal verificationが最新差分で成功している。
- 文書参照、frontmatter、instruction budget、adapter、公開安全性を確認している。
- 実施していない確認を成功扱いしていない。
- 未実行検証、その理由、残るriskまたはblockerを示している。

## 4. Pull Request完了ゲート

PRをマージ可能な状態として報告するには、次をすべて満たします。

- 専用branchから非ドラフトPRが作成または更新されている。
- latest headについて、対象branchで定義されたpush CIとpull_request CIが成功している。
- latest meaningful changeに対するGitHub上で確認可能な自動または人間のreviewがcleanである。
- actionableな未解決review threadがない。
- GitHubのmergeabilityがcleanで、conflictまたはblocking conditionがない。
- PR本文に主Issue、変更、検証、未実行項目、公開安全性、残るriskを記録している。

reviewが提供されない場合、自己reviewは補助証跡に限り、GitHub上のreviewを確認した状態の代替にしません。同じheadでclean reviewを複数回集める必要はありません。指摘対応でheadが変わった場合だけ、関連CIと該当reviewを再確認します。

merge、Issue・PRのclose、release、deploy、force-push、公開済み履歴の書換え、破壊的操作は、対象を特定した別の明示指示がある場合だけ実行します。

## 5. 推奨検証

変更範囲に応じて、次から最小十分な組合せを選びます。

- syntax、lint、format、typecheck
- unit、integration、contract、E2E test
- Markdown相対link、YAML、frontmatter、UTF-8、trailing whitespace
- secret、実データ、無関係差分、禁止された製品固有情報
- 実環境のread-only観測

利用できない検証は、存在しない成果物として補わず、理由と影響を報告します。

## 6. 完了報告

変更内容と判断理由、受け入れ条件の根拠、local verification、Issue、branch、commit、PR、latest head、CI、review、未解決thread、mergeability、未実行検証、残るriskまたはblockerを、今回に関係する範囲で記録します。
