# 引継ぎ（2026-11-14）

SOMA Anim を続けるときは、まずこれを読む。仕組みの説明は [README](../README.md)、評価の経緯は [eval_2026-11-11.md](eval_2026-11-11.md)。

## いまの状態

- 公開: https://tomosud.github.io/soma_anim/ （`main` に push すると GitHub Actions が Pages に出す。版は `window.SOMA_ANIM_VERSION` = コミットの先頭 8 文字）
- リポ: `tomosud/soma_anim`（公開）。push は Alta で: `node D:/Work/Tool/to_gitdesktop_alta/tools/alta-mcp/alta-mcp.mjs call git.push '{"path":"D:/Work/Tool/soma_anim"}'`
- gh の既定アカウントは会社側なので、tomosud の API は `GH_TOKEN="$(gh auth token --user tomosud)" gh ...`
- 手元: `D:\Work\.claude\launch.json` の `soma-anim`（`node tools/serve.mjs 8931`）。Browser pane の `preview_start {name: "soma-anim"}`
- 試験: `node --test tests/`（166 件）

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
| `tools/plainsweep.js` | 見本のポーズをランダムに置いたシーン（種で決まる）で、MotionBricks が作らなかった区間を数える。`run({ scenes: 6, tag })`、`run({ scenes: 3, first: 11, flow: true })` |

ページの中の `window.app` に `rig`, `project`, `env`, `mb`, `shot`, `applyPose`, `recenter` などがある。

## 次にやること

### 1. リグを Maya の最新と一致させる（2026-11-14 済み）

- Maya リグのセッション（「IK/FK切り替え機能の検討」`local_778e9c6c-6190-41a7-a3b1-c151f7f7cfb0`）から受け取った資料は `rigspec/` に置いた。**このリポには上げない**（本人の指示 2026-11-14、`.gitignore`）。リグを変えたら、あちらに `export_spec.py` とピッカーの書き出しを頼み、`rigspec/` に置き直して `assets/bns_rig.json` にコピー、`node tools/make_picker.mjs`、`node tools/make_retarget_cal.mjs`、`node tools/make_start_pose.mjs`。分からない点はあちらに聞く。
- IK/FK は IK に固定（本人の指示）。IK の中の切り替えは使う（`src/switches.js`）。照合は IK のケース 132 件が全件 0.01 cm 未満。
- 骨格 → コントロール値（`src/fit.js`）は 1 回 1.5 ms（2026-11-14。リグの評価を依存の順にして 10 → 1.5 ms、結果は 15 桁まで同じ。`node tools/bench_rig.mjs`）。Maya での一致の確認（`tools/maya_check.py`）は新しいリグでは未実施。

### 2. 動きの質の残り

- 打撃の切れ（snap 1.8 → 実際の打撃は 2〜3）。
- 歩きの前傾・歩幅、後ろ歩きの歩幅のむら、しゃがんだままの移動（立ち上がる）、横歩き。
- キーの間で全身の輪（world_ctl）が体から最大 14 cm ずれる（キーの上では 0）。
- 手で直したキーは見本の「前後の動き」（`key.ref`）を失う。

## 速さ（2026-11-14）

- サンプル 23 区間の生成: 8.8 秒 → 3.1 秒。ランダムな 9 シーン（`tools/plainsweep.js`）: 150 秒 → 56 秒、通過モード 6 シーン: 116 秒 → 45 秒。採点の平均は同じ（0.283 → 0.281、0.248 → 0.244）。
- 内訳（変更前のサンプル）: 当てはめ 4.6 秒、推論 2.9 秒、採点 0.3 秒。いまは推論（1 回約 90 ms、8 件まとめても同じ）が大半。
- まとめて推論すると数値がわずかに変わる（fp16）ので、区間の結果は前と完全には同じでない。品質は上の通り同じ。

## 仕組みの要点（README に無いこと）

- キー: `{frame, v, pins, ref}`。`ref = {clip, frame, mirror}` は見本から置いたキーで、MotionBricks に前後 3 フレームずつを渡す（`MotionBricks._around`）。
- 中割り: `src/motionbricks.js` の `_generate` が作り方の候補（歩行・小分け・1 回）を試し、`_score` で採点して選ぶ。5 フレーム以上の間隔は生成（17 未満は最短の動きを速める）。どれも良くなければ追加の候補（長さ違い・間のポーズで 2〜3 分割・止まった状態から・腰の行き先だけ・長さをモデル任せ）を試す。補間には落とさない（本人の指示 2026-11-14「飛んでもいいので埋める」）。崩れている（採点 1.0 超）か人に不可能な速さ（`src/why.js` の `infeasible`）のときは、一番よい生成を使い、`match.warn` に理由を入れる。タイムラインの帯の名前・ツールチップ・クリックで出る。2026-11-14 の結果: ランダム 43 区間で plain 11 → 1、通過モード 28 区間で 7 → 0、自己テスト 64 区間で 1 → 1（3 m を 15 f。理由「速すぎる」）、STRESS の点 30.74 → 29.89。同日、補間に落とすのをやめた後: ランダム 68 区間・通過モード 43 区間とも plain 0（採点 1.0 超は 5 と 2。注意つき）。
- 見本: `tools/make_poses.mjs` → `assets/poses.json`（クリップと、拳が遠い・足が高いなどで選んだフレーム）。DB に無い動き（ジャンプなど）は、Mixamo の FBX を soma-fighter-web の `tools/mixamo_clips.mjs` で JSON にして `node tools/add_clips.mjs <json> <tag> [名前…]` で足す。**MotionBricks 公式の BVH（乗り越え・椅子など）は NVIDIA Sample Data Evaluation License なので、公開リポには入れない。**
- キーごとの `natural` / `feet`（既定 true、false のときだけ保存）: 画面の 2 つのチェック。`feet` が false のキーは見本を床に下ろさない・全キーの接地の対象外。
- 中割りの使い回し: 区間の id に前の区間を含めず、作ったときの到着（前の区間の最後の 4 フレーム）を `seg.ctx` に持つ。今の到着と主な関節で 3 cm 以内なら作り直さない（`MotionBricks.sameContext`）。キーを 1 つ直しても作り直すのは 1〜3 区間。
- COG（`src/cog.js`）: 見本を置いたキーは COG を腰に合わせ、中割りでは COG と腰のずれを前後のキーのずれの間でなだらかに変える。手順はリグの作者に聞いたもの（`rigspec/cog_answer.md`）: COG の回転は変えず位置だけ動かし、Hip_trans・Spine_trans・Head_trans を元の世界の位置に戻す（骨は動かない。`tests/cog.test.mjs`）。リグは 2026-11-14 に COG の回転が背骨に効くよう直った版（コンストレイント 125 本。Maya 側の共有先への反映は本人の判断待ち）。地面の動きは COG 0 で Hip_trans、ジャンプ・空中は COG に放物線と回転、空中の追従先は脚 Hip・腕 Chest がおすすめ。
- 手首が半回転する（2026-11-14、本人の moto.json の 101・244・258）: 原因は (1) リグ → SOMA → リグの往復で肘が反対側に解けること（`fromRig` は較正値、`targets` は静止姿勢の値を使っていた。腕がまっすぐなキーで起きる）と、(2) 人の範囲を超えてねじったキー。(1) は両方向とも較正値にし、手足の曲がりが 1 cm 未満なら位置でなく骨の向きで肘・膝の向きを決める。(2) は関節の範囲（`src/limits.js`）。急な回転を数える道具は `tools/spikes.js`（ページで `file('/eval_out/x.json')`）。直す前 → 後: moto 7 → 1、サンプル 38 → 17、ランダム 6 シーン 18 → 9（残りは 5 フレーム間隔の速いパンチなど）。
- ドラッグ中は生成を止める（`mb.hold`）。生成の当てはめは 8 ms ごとに画面に譲る（`Inbetweener.finishAsync`）。ドラッグの更新は描画 1 回に 1 度（`dragUpdate`）。
- シェルの heredoc に長い Python を渡すと壊れることがある。Write でファイルにしてから実行する。
