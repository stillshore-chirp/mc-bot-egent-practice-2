# Agent Principles

この文書はMinecraft AIコンパニオンの設計heuristicです。製品固有の境界は[AGENTS.md](../AGENTS.md)、共通の作業運用は実行環境の指示に従います。

## AIコンパニオンの設計

- Minecraftで継続する一人のAIプレイヤーとして、人格、関係、出来事、場所、約束の記憶を一貫させます。
- 人格、会話、記憶と、世界の観測、行動実行、外部接続を区別し、各情報の由来と確度を保ちます。
- 既定のAIプレイヤー／行動系GPTがゲーム内の危険、死亡、建築変更を含む行動を判断し、強いowner要求に応じて選択を変えられます。PlayerBodyは判断結果のゲーム操作を実行します。
- 既定経路は`src/app/application.ts`が`src/player/agent.ts`、`src/player/runtime.ts`、`src/player/store.ts`と`PlayerBody`を組み立てます。旧tool、skill、reflex、trace実装を別runtimeとして並行稼働させません。詳細は[自律プレイヤー](autonomous-player.md)と[PlayerBody](player-body.md)を参照します。
- 長時間または複数工程の行動は中断可能にし、失敗、再開、取消、重複実行を扱える境界を設計します。
- sessionをまたぐ同一性を、会話履歴だけに依存させず、明示的で検証可能な状態として設計します。

## KISS、YAGNI、DRY

- 要件を満たす最小の構造から始め、未使用の拡張点、provider抽象、汎用agent基盤を先行追加しません。
- 将来可能性だけを理由にinterface、factory、plugin、DSLを増やしません。
- 重複回数だけで共通化せず、変更理由、lifecycle、契約が同じかを確認します。
- 安全性、観測性、error処理、data整合性に必要な備えは、利用前でも設計します。

## SRP、SoC、依存方向

- file、class、function、componentの責務を、名前と公開契約から説明できる状態にします。
- 会話・計画、ゲーム観測、行動実行、記憶、外部接続の関心を区別し、一つの変更が無関係な領域へ波及しない構造を選びます。
- logging、metrics、retry、authorizationなどの横断的関心は、一貫して適用できる境界へ置きます。
- 分割は行数ではなく、独立して変更・評価できる責務で判断します。

## 外部統合と可観測性

- 外部API、LLM、Minecraft接続、storageの抽象化は、差替え、契約確認、障害分離に実益がある境界へ置きます。
- 想定可能な失敗にはretry、停止、fallback、利用者通知の方針を設計し、fallbackで不整合や設定不備を隠しません。
- 再実行される副作用ではidempotency、checkpoint、deduplicationを検討します。
- 原因判定では観測された失敗、説明するcode・config・data、再現または対照確認を接続します。

## Testと依存の設計

- unit testは判断logic、integration testは境界契約、E2Eは重要な会話・行動・停止・回復の流れに向けて設計します。
- 時刻、乱数、network、LLM、Minecraft server、storageなどの非決定要素は、再現性と原因の切り分けを助ける形で制御します。
- flaky testは再実行で隠さず、待機条件、競合、非同期、環境差など原因となる設計を見直します。
- 依存は最小限に保ち、標準機能や既存依存で十分な場合は追加しません。
