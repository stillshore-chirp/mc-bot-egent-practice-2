# AIエージェント向け作業プロンプト

この作業はMinecraft bot、AIコンパニオン、repository governance、またはその検証を含みます。

1. root AGENTS.mdと変更対象に最も近いAGENTS.mdを読みます。
2. taskに該当する共有Skillと、直接関係するdocs正本だけを読みます。
3. 目的、acceptance、非対象、target HEAD / base、owned paths、権限、runtime資源、cleanup、公開範囲を固定します。
4. 分離可能な作業はbounded laneへ委任し、最小contextとoutput capを渡します。
5. implementationからacceptedまでcheckpointを進め、input closure、gate invalidation、evidence reuseを記録します。
6. 観測事実、code上の仮説、未確認事項を分離して報告します。

実施していないtest、外部状態、Minecraft内結果を完了根拠にしません。secret、個人情報、実環境log原文、追跡可能な識別子を公開しません。
