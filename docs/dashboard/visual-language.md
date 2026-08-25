# ビジュアル言語

## 主表示

主表示は Three.js の `WebGLRenderer` と `EffectComposer` を使う 3D DAG です。`RenderPass`、`UnrealBloomPass`、`OutputPass`、`OrbitControls`、`Raycaster` を組み合わせ、実 trace state の span、result、link を scene へ同期します。文字情報は 3D scene に焼き込まず、DOM の Inspector と node list に置きます。

レイアウトは決定論的です。

- X 軸: span の sequence 順
- Y 軸: stage lane (`input`、`perception`、`memory`、`deliberation`、`tool`、`minecraft`、`verification`、`memory-write`、`response`、`safety`、`system`)
- Z 軸: parent span の深さ
- result: 関連 span の近傍へ配置し、result link で接続

同じ入力に対する layout は同じ座標を返します。未選択の node をランダムに発光させたり、未発生 event の pulse を生成したりしません。

## Node と result

stage に応じて geometry を変えます。

| 対象                                       | 表現                                       |
| ------------------------------------------ | ------------------------------------------ |
| 通常の span                                | sphere                                     |
| `tool`                                     | box                                        |
| `verification`                             | octahedron                                 |
| `reflex` / `recovery` / `cancellation`     | tetrahedron                                |
| `memory_read` / `memory_write` / `context` | icosahedron                                |
| result                                     | octahedron と結果色、DOM list では R shape |

親子 link は標準 edge、`interrupts` は赤系、result link は水色系で表示します。stage と result kind の色は `dashboard/src/trace/labels.ts` と scene の result color mapping が正本です。

## 状態表示

DOM の status symbol と 3D material は次の実装に対応します。

| status      | DOM 記号 | 3D 表現                                                   |
| ----------- | -------- | --------------------------------------------------------- |
| `queued`    | `○`      | 低い emissive と待機ラベル                                |
| `running`   | `●`      | emissive を強め、reduced motion でない場合は scale を拡大 |
| `waiting`   | `◌`      | status label と warning 系の表示                          |
| `succeeded` | `✓`      | 成功色と安定表示                                          |
| `failed`    | `!`      | danger 色と error 情報                                    |
| `cancelled` | `×`      | muted な状態表示                                          |
| `skipped`   | `—`      | 低 opacity と wireframe                                   |

色だけでは状態を判別せず、文字、記号、外周、形状、status label を組み合わせます。result の検証 summary は Inspector と Timeline から確認できます。

## Event pulse と camera

新しい sequence を同期したとき、親 span から子 span、または span から result へ短い sphere pulse を一つ生成します。pulse は event の更新に対応し、idle 時の装飾ではありません。node 選択時は該当 node へ camera focus し、OrbitControls を手動操作すると自動 focus を解除します。

## Reduced motion と資源管理

`prefers-reduced-motion: reduce` では Bloom、OrbitControls damping、scale の active animation、edge pulse を抑えます。CSS も transition / animation の時間を短縮し、状態は静的な色・記号・文字で伝えます。

scene は node、edge、pulse の geometry / material を明示的に dispose し、animation frame、ResizeObserver、context listener、OrbitControls を停止します。canvasには`renderer.info`由来のgeometry / texture / program / draw call数とscene object数を診断属性として出し、context lost testでdispose後のnode / edge / pulseが0になることを固定します。WebGL context lost は検出して 2D fallback へ切り替えます。

## 2D fallback と DOM 経路

WebGL 2 を取得できない、3D scene の dynamic import / 初期化に失敗した、または context lost が発生した場合、理由を status として表示し、同じ trace state を SVG 2D graph へ渡します。2D node と result は focus 可能で、`Enter` / `Space` で関連 span を選択できます。

3D canvas は唯一の情報経路ではありません。node list は `listbox` / `option` として存在し、`Tab`、矢印キー、`Home`、`End` で移動できます。Inspector、Timeline、Replay controls は通常の DOM form / button として操作できます。
