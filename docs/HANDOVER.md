# 引継ぎ（2026-11-14）

SOMA Anim を続けるときは、まずこれを読む。仕組みの説明は [README](../README.md)、評価の経緯は [eval_2026-11-11.md](eval_2026-11-11.md)。

## いまの状態

- 公開: https://tomosud.github.io/soma_anim/ （`main` に push すると GitHub Actions が Pages に出す。版は `window.SOMA_ANIM_VERSION` = コミットの先頭 8 文字）
- リポ: `tomosud/soma_anim`（公開）。push は Alta で: `node D:/Work/Tool/to_gitdesktop_alta/tools/alta-mcp/alta-mcp.mjs call git.push '{"path":"D:/Work/Tool/soma_anim"}'`
- gh の既定アカウントは会社側なので、tomosud の API は `GH_TOKEN="$(gh auth token --user tomosud)" gh ...`
- 手元: `D:\Work\.claude\launch.json` の `soma-anim`（`node tools/serve.mjs 8931`）。Browser pane の `preview_start {name: "soma-anim"}`
- 試験: `node --test tests/`（99 件）

## 本人の方針（守ること）

- 返答は日本語。危険でない作業は聞かずに進めて報告。
- データの互換性は気にしなくてよい（2026-11-11）。
- 公開リポなので、社内のパス（`C:\MVS\…`）や会社の org 名を文面に書かない。
- 評価は自己完結で回す: 連番は **Manny のメッシュ**で描く。目視の検証は別のエージェントに分ける（判断が要るものは Opus、単純な確認は Sonnet）。
- 動きは「破綻が無い」だけでなく「動いているか」を見る（`src/evaluate.js` の `live`: still / snap / arc / overlap）。

## 評価の道具（ページ `?debug` の開発者コンソールで）

| 道具 | 使い方 |
|---|---|
| `tools/selftest.js` | `(await import('/tools/selftest.js')).run()`（18 場面）、`run({ set: STRESS })`（17 場面）→ `eval_out/strip_*.png`, `heat_*.png`, `selftest*.txt` |
| `tools/posetest.js` | `draw()` で自然化 27 件の絵。`node tools/posetest.js` で数値だけ |
| `tools/make_action_sample.js` | `make()` でサンプルを組み直し、`compare()` で補間と比べ、`dense(a, b, name)` で 1 フレームおきの連番 |
| `tools/mblab.js` | 素の MotionBricks を条件を変えて呼ぶ実験 |

ページの中の `window.app` に `rig`, `project`, `env`, `mb`, `shot`, `applyPose`, `recenter` などがある。

## 次にやること

### 1. リグを Maya の最新と一致させる（2026-11-14 済み）

- Maya リグのセッション（「IK/FK切り替え機能の検討」`local_778e9c6c-6190-41a7-a3b1-c151f7f7cfb0`）から受け取った資料は `rigspec/` に置いた。**このリポには上げない**（本人の指示 2026-11-14、`.gitignore`）。リグを変えたら、あちらに `export_spec.py` とピッカーの書き出しを頼み、`rigspec/` に置き直して `assets/bns_rig.json` にコピー、`node tools/make_picker.mjs`、`node tools/make_retarget_cal.mjs`、`node tools/make_start_pose.mjs`。分からない点はあちらに聞く。
- IK/FK は IK に固定（本人の指示）。IK の中の切り替えは使う（`src/switches.js`）。照合は IK のケース 132 件が全件 0.01 cm 未満。
- 残り: 骨格 → コントロール値（`src/fit.js`）が 1 回 10 ms（前は 2.6 ms。評価の回数が増えた）。Maya での一致の確認（`tools/maya_check.py`）は新しいリグでは未実施。サンプル（`assets/sample_action.json`）は古いリグで作ったまま。

### 2. 動きの質の残り

- 打撃の切れ（snap 1.8 → 実際の打撃は 2〜3）。
- 歩きの前傾・歩幅、後ろ歩きの歩幅のむら、しゃがんだままの移動（立ち上がる）、横歩き。
- キーの間で全身の輪（world_ctl）が体から最大 14 cm ずれる（キーの上では 0）。
- 手で直したキーは見本の「前後の動き」（`key.ref`）を失う。

## 仕組みの要点（README に無いこと）

- キー: `{frame, v, pins, ref}`。`ref = {clip, frame, mirror}` は見本から置いたキーで、MotionBricks に前後 3 フレームずつを渡す（`MotionBricks._around`）。
- 中割り: `src/motionbricks.js` の `_generate` が作り方の候補（歩行・小分け・1 回）を試し、`_score` で採点して選ぶ。5 フレーム以上の間隔は生成（17 未満は最短の動きを速める）。
- 見本: `tools/make_poses.mjs` → `assets/poses.json`（クリップと、拳が遠い・足が高いなどで選んだフレーム）。
- シェルの heredoc に長い Python を渡すと壊れることがある。Write でファイルにしてから実行する。
