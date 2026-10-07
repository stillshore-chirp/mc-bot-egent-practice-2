# Evidence境界

この文書はMinecraft製品の結果とrepository governance検査のevidence境界を定義します。一般的な作業手順と配送条件は実行環境の指示に従います。

## Minecraft製品の結果

- 受け入れ条件は、対応するコード・設定・testまたは実際のゲーム内観測のどれが根拠になるかを明示します。
- command受付やLLM出力はゲーム内actionの成功証拠になりません。位置、状態、inventory、危険、作業結果など独立した世界の観測を根拠にします。
- 実環境の観測を引用する場合、環境区分、条件、時間範囲を示し、識別子やraw logを公開しません。
- 実環境観測がない条件は未確認として扱います。code上の説明やisolated testの結果で置き換えません。

## Repository governance

rule、Skill、adapter、templateなどgovernance文書の形式・参照・frontmatter・task-state・instruction budgetは[validate_governance.py](../../scripts/validate_governance.py)で静的に確認します。validatorのPASSはtool discovery、Hook、権限、Minecraft runtime、外部サービスの成功を意味しません。

## 判定の限界

証拠は、対応する製品状態またはgovernance条件だけを裏付けます。対象範囲に観測がなければ、その結果は未検証として残します。
