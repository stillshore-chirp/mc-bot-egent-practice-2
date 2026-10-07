# Minecraft実環境の観測境界

この文書は、Minecraft bot、AIコンパニオン、記憶、外部serviceに関するrepository固有の観測境界を定義します。共通の作業手順と権限判断は実行環境の指示に従います。

## 実環境の状態

- local code、config、fixture、unit testだけではMinecraft serverやproductionの状態を事実として報告できません。
- ゲーム内actionはcommand受付やLLM応答だけで成功とせず、位置、health、inventory、危険、作業結果など、実際に観測した状態で判断します。
- 観測事実、ユーザーからの報告、code・configからの仮説、未確認事項を区別します。
- 実環境の証跡を記す場合は、環境区分、対象、時間範囲、観測方法を示し、確認していない範囲を成功扱いしません。

## 公開できる証跡

実環境の結果をIssue、PR、文書へ載せる場合は、username、UUID、server address、座標、world seed、会話全文、記憶内容、log原文、追跡IDを含めず、公開可能な要約にします。[公開安全性checklist](../security-publication-checklist.md)に詳細例があります。
