# Issue #149: コンパニオン経路の簡素化

## 基準

静的基準snapshotは `e8aaded66196ca2e668b8c663a0386069451aa40`（2026-10-10）。tracked filesの拡張子別 `splitlines()` 集計で、実動作や実利用の証明ではありません。生成物・vendorは除外しています。

| 範囲                     | ファイル数 |    LOC |
| ------------------------ | ---------: | -----: |
| `src/**/*.ts`            |         99 | 50,377 |
| `tests/**/*.{ts,tsx,py}` |        151 | 87,994 |
| `scripts/`               |          7 |  1,361 |
| `docs/**/*.md`           |         34 |  2,769 |
| `src/minecraft`          |         15 | 12,251 |
| `src/player`             |          7 | 11,049 |
| `src/app`                |          7 |  5,027 |
| `src/memory`             |          4 |  4,114 |
| `src/tools`              |          6 |  4,097 |
| `src/agent`              |          7 |  3,126 |

依存基準: root npm runtime 12 / dev 21、lockfile 379 entries、tree-guard Maven 2、Python harness 4。

## 実装後の静的集計

2026-10-10の作業ツリーを基準と同じ拡張子別 `splitlines()` で数えました。生成物・vendorは除外しています。これはコード量の比較であり、機能・品質・実利用の証明ではありません。

| 範囲                     | ファイル数 |    LOC |
| ------------------------ | ---------: | -----: |
| `src/**/*.ts`            |         27 | 13,105 |
| `tests/**/*.{ts,tsx,py}` |         24 | 11,292 |
| `scripts/`               |          8 |  1,551 |
| `docs/**/*.md`           |         22 |    539 |

依存はroot npm runtime 9 / dev 10、lockfile 287 entriesです（基準は12 / 21、379）。server/tree-guard（Maven直接依存2件）は撤去し、Python harnessの4要件は維持しています。

## 承認済み目標設計

既定の知能経路を `CompanionAgent → serialized CompanionRuntime → observed PlayerBody` に統合する。CompanionRuntimeが一つの行動権限者となり、短い1〜3手の検証可能な計画を各手ごとのLLM呼出しなしで進める。ownerメッセージ、被ダメージ、観測不一致は中断・再判断の契機とする。質問はBodyのregistry knowledgeへ接続する。汎用tool roundtrip、二重agent、CASによる判断確定を置かない。

CompanionStoreは単一writerの小さな永続状態とし、意味記憶・メッセージ・行動結果journalを保持する。persona、owner認証、永続停止、実観測による結果確認を維持する。旧データからの一度限りの追加migrationでは原本tableを書き換えず、停止状態と不確実な中断操作を保全し、自動再実行しない。PlayerBodyだけがゲーム操作・結果確認を担い、Connectionはtransportに限定する。

## 整理する機能

旧app/agent/tools/skills/reflexes/learning/mc-skillsとPlayerBody内の自律reflex行動を撤去し、通常のゲーム操作レパートリーは維持する。管理画面は残し、認証付きのplain HTML+HTTP read-only画面へ簡素化して、目的・行動・記憶・LLM利用状況・エラーを表示する。3D DAG、replay、大規模trace backendと関連する依存・設定・テストは中核価値が小さいため撤去する。利用状況は表示するが、累積API利用上限は設けない。

## 受け入れ

ローカル自動検証は全件成功しました: Vitest 209 tests / 18 files、governance 91 checks、format、lint、typecheck、build。各行でこの証拠と隔離・実環境の証拠を区別します。

| 条件                               | 根拠                                                                                                                                                                                                         | 状態            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| 会話から自律行動まで一つの直列経路 | 同一runtimeの会話・判断・Body実行をlocal / fake testsで確認。Vitest 209 / 18 files合格。                                                                                                                     | local確認       |
| 1〜3手計画と割込み                 | 各手の観測、message・damage・mismatchによる中断と再判断をtestsで確認。実serverでは未確認。                                                                                                                   | local確認       |
| persona・記憶・停止・認証の継続    | backup copy: 39 tables / 309,025 rows unchanged; 55,970 memories（active 54,528、quarantine 0、credential flags 0）; 2回目openで重複なし、quick_check・owner stop・relationship/interests fingerprints安定。 | copy確認        |
| world結果とBody知識                | Body観測結果の分類とregistry質問の経路をtestsで確認。隔離Minecraftは起動できず、server readbackを未実施（`SERVER_INPUT_REQUIRED`）。                                                                         | 一部確認        |
| 管理画面                           | 認証付きread-only画面。HTTP 8 tests、config 5 tests合格。非loopback bindを拒否する。ブラウザーでの描画は検証ツール制約により未確認。                                                                         | HTTP確認        |
| API利用に累積上限なし              | 製品コードに累積call・token・費用quotaなし。実APIは合成入力で2 calls、input 6,279 / output 488 tokens。これは上限なしの運用保証や価格評価ではない。                                                          | 実API限定確認   |
| 簡素化と通常操作維持               | src 99→27 files / 50,377→13,105 LOC、tests 151→24 / 87,994→11,292 LOC、scripts 7→8 / 1,361→1,551 LOC、docs 34→22 / 2,769→539 LOC。npm runtime/dev 12/21→9/10。通常操作はlocal regression testsで確認。       | 静的・local確認 |

実APIの2 callsは限定した合成入力の観測値で、費用・token上限の検証ではありません。Minecraft実worldの受入れは未達・未検証であり、local testsやBody内の観測をserver側の独立確認として扱いません。ブラウザー描画も未確認です。Issue #149の実world受入れ完了は主張しません。

copy datasetにはactive operationがなかったため、再起動時の中断操作回復はsynthetic store testsでのみ確認しています。
