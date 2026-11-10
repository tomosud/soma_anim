# Rig_Manny_BNS の仕組み（Web で再現するための仕様）

書き出し元: `Rig_Manny_BNS.ma`。
実装の正本は、リグを組む Maya モジュール（mgear_bns_rig）の `solver.py`。
このフォルダのファイルは `mgear_bns_rig\tools\export_spec.py` で作り直せます。

| ファイル | 中身 |
|---|---|
| `bns_rig_spec.json` | 静止状態のリグ全部（コントロール 66、リグ内の全ノード 345、バインド骨格 89、コンストレイント 89、IK 4、指の式 2、ツイスト骨 8 組） |
| `bns_rig_cases.json` | 検証用 88 ケース: コントロール値 → バインド骨格 89 個とコントロール 66 個のワールド行列 |
| `manny_bind.fbx` | メッシュ（スキン付き）＋バインド骨格だけ。リグなし、Maya の Y-up シーンから書き出し |
| `bns_rig_solver.md` | この文書 |

## 0. 約束ごと（最初に必ず読む）

- 単位 cm、**Y-up**、右手系、キャラクターは **+Z を向く**。L はキャラクター自身の左（+X 側）。
- 行列は 16 個・行優先・**行ベクトル**（`world = local * parent`、平行移動は要素 12,13,14）。three.js は列ベクトルなので、`Matrix4.fromArray()` にそのまま渡すと転置の関係でちょうど合います（three の `elements` は列優先 = この並びと同じ）。
- 回転は度。回転順 `xyz` は「X を先に回す」（行ベクトルで `R = Rx * Ry * Rz`）。three.js の `Euler(x, y, z, 'XYZ')` は列ベクトルで `Rx * Ry * Rz`（Z を先に適用）なので、**Maya の `xyz` は three の `'ZYX'`、`zyx` は `'XYZ'`、`xzy` は `'YZX'`、`zxy` は `'YXZ'`** に当たります。ここは必ずケースで確かめてください。
- ジョイントのローカル行列は `S * R(rotate, 回転順) * R(jointOrient, xyz) * T(translate)`。この骨格の `jointOrient` は全部 0 で、静止姿勢は `rotate` に入っています。
- **コントロールの値はすべて静止からの差分で、静止値は 0** です（このリグは。元の BNS は `_trans` の静止値が 0 でない＝ワールド座標そのものでしたが、こちらはコントロールの親 `ik_cns` が静止位置を持つので 0 始まり）。`spec.controls[].channels[].rest` に入れてあります。
- バインド骨格の `root` は `SKM_Manny_Simple`（X に −90°）の下にあります。ワールド行列で扱えば気にしなくて構いません。

## 1. 全体の流れ

```
コントロール（66 個）
   └→ 補助ノード（bns_* の null・aim・IK ハンドル。spec.nodes / spec.constraints）
        └→ drv_ 骨格（バインド骨格と同じ階層・同じローカル値の写し。bns_drv_skeleton の下）
             └→ バインド骨格（root は drv_root にワールドで一致、ほかは translate / rotate を drv_ からそのまま接続）
```

バインド骨格の各ジョイントのワールド行列は、対応する `drv_` と**完全に同じ**です。Web では `drv_` を解いた結果をそのままバインド骨格に入れてください。

コントロールの親子（`spec.controls[].parent_control`）:

```
world_ctl
 ├ Hip_trans ─ Hip2_rot
 ├ Spine_trans
 ├ Spine_rot            （ik_cns が bns_spine_rollbase に追従）
 ├ Neck_rot ─ Head_rot  （Neck_rot の ik_cns が胸 drv_spine_05 に追従）
 ├ Head_trans
 ├ L/R_Shoulder_rot     （ik_cns が胸に追従）
 ├ L/R_elbow_pv         （ik_cns が胸に追従）
 ├ L/R_Hand_trans
 ├ L/R_Hand_rot         （ik_cns が前腕 drv_lowerarm に追従）
 │   └ finger_base_OFFSET ─ finger_base_ROT, finger_ratio_TRN, Thumb1-2-3, Index1-2-3, Middle0-1-2-3, Ring0-…, Pinky0-…
 ├ L/R_knee_pv          （ik_cns が bns_spine_base の「位置だけ」に追従）
 ├ L/R_Foot_trans
 └ L/R_Foot_rot ─ Toe_rot（Foot_rot の ik_cns は足首 drv_foot の「位置だけ」に追従。向きは world_ctl のまま）
```

各コントロールは `…_ik_cns`（静止位置を持つ親）→（指だけ `…_bnsdrv` など）→ コントロール、という DAG です。
「ik_cns が○○に追従」と書いたものは、ik_cns のワールド行列をコンストレイントで決めます（world_ctl の子としてのローカル値は使わない）。
書いていないものは普通の親子（world_ctl や親コントロールの子）です。

**かかとのロール・逆足・IK/FK 切り替え・伸縮（ストレッチ）はありません。** 元の BNS どおりです。

## 2. Maya のコンストレイントの計算（spec.constraints の読み方）

行ベクトル表記。`W(x)` は x のワールド行列、`P(x)` は x の親のワールド行列。

- **parentConstraint**（mo つき）: `W(driven) = Offset * W(target)`。`Offset` は `target_offsets[i]` の `translate` と `rotate`（回転順 xyz）から作る行列 `R * T`。driven のローカルは `W(driven) * inverse(P(driven))`。すべて target 1 個です。
- **pointConstraint**: driven のワールド位置 = target のワールド位置（複数なら重みつき平均）＋ `offset`。`offset` は **driven の親の空間**のベクトル（親の回転・スケールを掛けてから足す。`bns_world_follow` が回っていなければワールドと同じ）。回転は変えない。
- **orientConstraint**: driven のワールド回転 = `Roffset * blend(target のワールド回転)`。`Roffset` は `offset`（xyz）の回転、`blend` は重みつき（`interp_type` 2 = shortest = クォータニオンの球面補間。target 2 個で重み 0.5/0.5 は slerp(0.5)）。位置は変えない。
- **aimConstraint**: driven のワールド回転 `R` を、`aim_vector * R` が target の方向、`up_vector * R` が「上」にできるだけ近くなるよう決め、最後に `Roffset * R`（`offset` を xyz でローカル側に掛ける）。「上」は
  - `world_up_type: "object"` → `world_up_object` の**位置**へ向かう方向
  - `world_up_type: "objectrotation"` → `world_up_vector` を `world_up_object` のワールド回転で回した方向
  作り方: `a = normalize(target − driven位置)`、`u = normalize(up − a*(up·a))`、第 3 軸 = 外積で右手系に。`aim_vector` と `up_vector` がどのローカル軸かを見て行に並べる。
- **poleVectorConstraint**: IK ハンドルのポールベクトル = target のワールド位置 − 開始ジョイントのワールド位置。

`bns_setup` は `inheritsTransform` オフ（親の影響を受けない）、その下の `bns_world_follow` が `world_ctl` に parentConstraint で一致します。補助ノードと drv_ 骨格は全部この下なので、**world_ctl を動かすと全部が一緒に動きます**（world_ctl のスケールはロック）。

## 3. 解く順番（この順に計算すれば循環しない）

名前はすべて `spec.nodes` にあります。静止ワールド行列・親もそこから取ってください。

### 3.1 world_ctl と「移動だけ」のコントロール

`world_ctl`（回転順 zxy、移動＋回転）。`Hip_trans`、`Spine_trans`、`Head_trans`、`L/R_Hand_trans`、`L/R_Foot_trans` は world_ctl の子で、
ik_cns の静止ローカル行列 × コントロールのローカル移動、で位置が決まります（軸はワールド向き）。

### 3.2 腰

- `Hip2_rot` は `Hip_trans` の子（回転順 xzy、軸は X=後ろ(−Z)、Y=上、Z=左(+X)）。
- `drv_pelvis` ← parentConstraint ← `Hip2_rot`（位置も回転も）。

### 3.3 背骨（胸の的 + ひねり + 腰の半分追従）

1. `bns_spine_base`（bns_world_follow の子、ワールド向き）← pointConstraint ← `Hip_trans`。**腰の移動だけ**受け取る（回転は受けない）。
2. `bns_spine_rollbase`（base の子、腰の位置）← aimConstraint → `Spine_trans`（aim=ローカル Y、up=ローカル Z を base の Z 方向へ、objectrotation）。腰から胸の的へ向く軸。
3. `Spine_rot` の ik_cns ← parentConstraint ← rollbase。`Spine_rot.ry` がこの軸まわりのひねり（キーは ry だけ）。
4. 的の点（すべて位置だけ使う）:
   - `bns_spine_chest_tgt`、`bns_spine_chest_up`: `Spine_rot` の子（胸の位置 = drv_spine_05、その後ろ 40cm）
   - `bns_spine_hip_tgt`、`bns_spine_hip_up`: `Hip2_rot` の子（静止では上と同じ場所）
   - `bns_spine_mid_tgt` = chest_tgt と hip_tgt の中点、`bns_spine_mid_up` = chest_up と hip_up の中点（pointConstraint、重み 1:1）
5. `bns_spine_seg1`（base の子、腰の位置）← aim → mid_tgt、up = mid_up の位置（object）。**下半分: 胸の的と腰の回転の中間を向く。**
6. `bns_spine_seg2`（seg1 の子、drv_spine_03 の位置）← aim → chest_tgt、up = chest_up の位置。**上半分: 胸の的を向く。**
7. 背骨の骨:
   - `drv_spine_01` の**位置** ← pointConstraint ← `bns_spine_root_pos`（seg1 の子）。背骨の根元は腰の回転で振られない。
   - 向き（orientConstraint、shortest）: `spine_01` = seg1、`spine_02` = seg1、`spine_03` = seg1 と seg2 の 0.5/0.5、`spine_04` = seg2、`spine_05` = seg2（`spec.spine_weights`）。
   - 位置は階層どおり（01 だけ上の pointConstraint）。骨の長さは変わりません。

胸 = `drv_spine_05`。以後「胸に追従」はこの骨への parentConstraint です。

### 3.4 首と頭

1. `Neck_rot` の ik_cns ← parentConstraint ← 胸。`Neck_rot` は回転順 xyz、軸 X=前、Y=左、Z=上、キーは rx（横に傾ける）と ry（前後）だけ。
2. `Head_rot` は `Neck_rot` の子（頭の骨の位置、同じ軸、キーは rx と ry。**ry は見た目に効きません**。元の BNS と同じ）。
3. `bns_head_aim`（Head_rot の子）← aim → `Head_trans`（aim=ローカル X、up=ローカル Z を `Head_rot` の Z 方向へ、objectrotation）。`Head_rot.rx` は「上」を傾けるので頭の傾げになる。
4. `drv_head` の向き ← orientConstraint ← `bns_head_aim`（位置は階層どおり）。
5. 首のひねり: `bns_head_aim` のローカル回転をオイラー（xyz）に分解した **rotateZ**（= 顔の左右の向き）を使い、
   `bns_neck_twist0.rotateZ = 0.2 * aim.rotateZ`（Neck_rot の子、drv_neck_01 の位置）、
   `bns_neck_twist1.rotateZ = 0.2 * aim.rotateZ`（twist0 の子、drv_neck_02 の位置）。合計 40%。
   `drv_neck_01` の向き ← twist0、`drv_neck_02` の向き ← twist1（orientConstraint）。

注意: aim.rotateZ は「オイラー分解した値」です。行列 → xyz オイラーの分解を Maya と同じ式でやること（`rz = atan2(m[0][1], m[0][0])`、行ベクトル・xyz 順）。

### 3.5 腕（左右）

1. `X_Shoulder_rot` の ik_cns ← parentConstraint ← 胸。`drv_clavicle` の向き ← orientConstraint ← `X_Shoulder_rot`。
   軸は X = 鎖骨の向き（**左右とも +X 側を向く**。R は骨と逆向き）、Y ≒ 上。
2. `X_elbow_pv` の ik_cns ← parentConstraint ← 胸（肘の向きの的は胸と一緒に動く）。
3. IK（`bns_X_arm_ik`）: 開始 `drv_upperarm`、中間 `drv_lowerarm`、先端 `drv_hand`。
   ゴール = `X_Hand_trans` のワールド位置（pointConstraint。静止では手首と同じ位置）、ポール = `X_elbow_pv` の位置 − 上腕の位置。4 章のとおり解く。
4. `X_Hand_rot` の ik_cns ← parentConstraint ← `drv_lowerarm`（**IK を解いた後の前腕**）。手首は前腕についていく。
   `X_Hand_rot` は回転順 zyx、軸 X = 前腕の向き。`drv_hand` の向き ← orientConstraint ← `X_Hand_rot`。
5. 指のコントロールはすべて `X_Hand_rot` の子孫なので、手首と一緒に動く。

### 3.6 脚（左右）

1. `X_knee_pv` の ik_cns ← pointConstraint ← `bns_spine_base`（腰の**移動だけ**についていく。腰の回転にはつかない）。
2. IK（`bns_X_leg_ik`）: 開始 `drv_thigh`、中間 `drv_calf`、先端 `drv_foot`。ゴール = `X_Foot_trans`、ポール = `X_knee_pv`。
3. `X_Foot_rot` の ik_cns ← pointConstraint ← `drv_foot`（位置だけ。**足首の向きはワールド（world_ctl）のまま**で、脚の角度の影響を受けない）。
   回転順 xzy、ワールド軸。`drv_foot` の向き ← orientConstraint ← `X_Foot_rot`。
4. `X_Toe_rot`（Foot_rot の子、つま先の付け根の位置。軸 X=前、Y=下、キーは rz だけ）。`drv_ball` の向き ← orientConstraint ← `X_Toe_rot`。

### 3.7 指（左右）

階層（DAG）: `finger_base_X_OFFSET`（手の位置・手の軸）が親で、その下に `finger_base_X_ROT`、`finger_ratio_X_TRN`、各指の根元。
各指コントロールは `ik_cns → _bnsdrv → コントロール`（親指の 1 番だけ `ik_cns → _bnsopp_ofs → _bnsopp → _bnsopp_back → コントロール`）。

- **骨への接続**: `drv_<指の骨>` ← parentConstraint ← 対応コントロール（位置も回転も）。
  `Thumb1→thumb_01`、`Index1→index_01`、`Middle0→middle_metacarpal`、`Middle1→middle_01` …。`index_metacarpal` はコントロールが無いので `finger_base_X_OFFSET` に追従。
- **軸**: 手の軸（OFFSET・ROT・TRN・中手骨 `*0`）= X: 手首→中指付け根、Y: 掌の向き。指の関節（`*1`〜`*3`、親指）= X: その骨の向き、**rz のプラスで握る**、ry で横に開く、rx はひねり。
- **左手はミラー軸**: 左の指コントロール（OFFSET 以下すべて）はワールド行列の行列式が負（Z 軸が反転）です。`spec.controls[].mirrored_axes` が true。
  根元の `finger_base_L_OFFSET_L0_ik_cns` のローカル行列に負のスケールが入っており、その子孫はローカルでは普通の回転です。
  **spec のワールド行列／ローカル行列をそのまま使い、ローカルの回転値を普通に掛ければ**、左右に同じ値で左右対称になります（特別扱いは不要。three.js では Object3D の scale ではなく行列を直接持つのが安全）。
- **鏡像のコントロールから骨への parentConstraint（左手の指の骨）**: ターゲットが鏡像なので、
  `offset * W(target) * inverse(P(driven))` の 3x3 は行列式 −1 になります。Maya はこれを**スケール (−1, −1, −1)** として読み、
  **3x3 全体の符号を反転したもの**を関節の回転にします（Z 行だけを反転するのではない）。位置はそのまま。
  （Web 側の実装で 88 ケースと照合して確認された規則。2026-11-10、soma_anim `src/rig.js`）
- **まとめて動かす式**（`spec.expressions`、左右同じ式）。`b` = `finger_base_X_ROT` の回転、`t` = `finger_ratio_X_TRN` の移動:

```
tz = 1 + 0.1*t.tz      mtz = 1 + 0.035*t.tz     bx = 1 + 0.1*t.tx
rtz = 2 - tz           rmtz = 2 - mtz           bRxP = max(b.rx, 0)

Thumb1_bnsopp.rx  = b.rx                      （親指を掌・小指の方へ。軸は _bnsopp_ofs の X）
Index1_bnsdrv  : ry = -0.8*b.ry                rz = 0.95*b.rz*tz*bx
Index2_bnsdrv  : rz = b.rz*tz
Index3_bnsdrv  : rz = b.rz*tz*(2 - 0.95*bx)
Middle0_bnsdrv : rx = 0.2*bRxP   ry = 0.25*b.ry   rz = 0.05*b.rz
Middle1..3     : 上の Index と同じ形で tz → mtz（1 番の rx, ry は 0）
Ring0_bnsdrv   : rx = 0.4*bRxP   ry = 0.45*b.ry   rz = 0.15*b.rz + 0.35*bRxP
Ring1_bnsdrv   : rx = -0.1*b.rx  ry = 0.9*b.ry    rz = 0.95*b.rz*rmtz*bx     （2, 3 番は rmtz）
Pinky0_bnsdrv  : rx = 0.8*bRxP   ry = 0.75*b.ry   rz = 0.3*b.rz + 0.7*bRxP
Pinky1_bnsdrv  : rx = -0.3*b.rx  ry = 2.2*b.ry    rz = 0.95*b.rz*rtz*bx      （2, 3 番は rtz）
```

  `_bnsdrv` は回転順 xyz の null で、コントロールと同じ軸・静止で 0。指 1 関節の最終回転 = `_bnsdrv の回転` の上に `コントロールの回転`（親が _bnsdrv）。
- **OFFSET**: 指全体（親指も）を手首まわりに回す。**ROT.rx**: すぼめる（中手骨はプラスだけ、親指は対向）。**TRN**: 握るときの配分。
- **リミット**: `finger_ratio_TRN` tx, tz は ±10。中手骨 `Middle0` rx 0〜8 / ry −2〜4 / rz 0〜2、`Ring0` 0〜12 / −2〜3 / 0〜4、`Pinky0` 0〜20 / −2〜4 / 0〜6（`spec.controls[].channels[].limit`）。値はここで切ってから計算する。

### 3.8 ツイスト骨（`spec.twist_joints`）

drv_ の IK・手首・足首が決まった後に計算します。「X 軸まわりのひねり角」を取り出して、ツイスト骨の rotateX に足すだけです。

- ひねり角の取り出し: 回転 `D` をクォータニオン (x, y, z, w) にし、`(x, 0, 0, w)` を正規化、`angle = 2*atan2(x, w)`（度、−180〜180）。
- `mode: "child_in_parent"`（前腕・すね）: `D = inverse(手／足のジョイントの静止ローカル回転) * 現在のローカル回転`。
  `lowerarm_twist_01`（手首側）に 0.67、`_02` に 0.33。`calf_twist_01` 0.67、`_02` 0.33。
- `mode: "self_local"`（上腕・太もも）: `D = 現在のローカル回転 * inverse(静止ローカル回転)`。
  `upperarm_twist_01`（肩側）に −1.0、`_02` に −0.5。太ももも同じ。
- ツイスト骨の `rotateX = 静止の rotateX + weight * angle`。ほかのチャンネルは静止のまま。
- ローカル回転は「ジョイントのローカル行列の回転部分」。行ベクトルなので掛ける順に注意。

### 3.9 追従するだけの骨とバインド骨格

- `ik_foot_l/r` ← parentConstraint ← `foot_l/r`、`ik_hand_gun` ← `hand_r`、`ik_hand_l` ← `hand_l`、`ik_hand_r` ← `hand_r`（UE の IK 骨）。
- `ik_foot_root`、`ik_hand_root`、`interaction`、`center_of_mass` は root の子のまま動かない。
- バインド骨格 = drv_ 骨格（ワールド行列が同じ）。`root` は world_ctl についていく。

## 4. IK の解き方（2 ボーン、伸びなし）

Maya の ikRPsolver（回転平面ソルバー）です。ハンドルの `twist` は 4 本とも 0、ストレッチなし、ゴールの回転は使いません（位置だけ）。

入力（ワールド）: 開始 `S`、ゴール `G`、ポール `P`（pv コントロールの位置）、静止の鎖（開始の親空間での 3 点 `s0, m0, e0` と各骨の静止ローカル回転）。

1. 骨の長さ `L1 = |m0 − s0|`、`L2 = |e0 − m0|`。`d = clamp(|G − S|, |L1 − L2| + ε, L1 + L2)`。
   届かないときは**伸びず**、腕（脚）がまっすぐゴールの方を向きます（先端はゴールに届かない。ケース `arm out of reach`）。
2. 中間ジョイントだけを曲げて先端までの距離を `d` にする。曲げる軸は静止の鎖の面の法線 `n0 = normalize((m0 − s0) × (e0 − m0))`（Manny は静止で少し曲がっているので定まる）。
   内角は余弦定理 `cos(θ) = (L1² + L2² − d²) / (2 L1 L2)`。静止の内角との差だけ、中間ジョイントを `n0` まわりに回す。
3. 開始ジョイントを回して、鎖全体をゴールとポールに合わせる。
   手順 2 の後の鎖で `x0 = normalize(e − s)`、`y0 = normalize((m − s) の x0 に垂直な成分)`。
   目標は `x1 = normalize(G − S)`、`y1 = normalize((P − S) の x1 に垂直な成分)`。
   枠 `[x0, y0, x0×y0]` を `[x1, y1, x1×y1]` に移す回転を、開始ジョイントに（ワールドで）掛ける。
4. 骨の長さ・ローカルの移動値は変えない。変わるのは開始と中間のジョイントの回転だけ。先端（手・足）の向きは 3.5 / 3.6 の orientConstraint で別に決まる。

静止姿勢ではポールが鎖の面内にあるので、値 0 で静止姿勢と一致します。
ポールがほぼ鎖の軸上に来ると不安定（Maya も同じ）。実装が合っているかは 5 章のケースで骨のワールド行列を比べてください（位置だけでなく向きも）。

## 5. 検証データ（bns_rig_cases.json）

`cases[]` の各要素: `controls`（`"コントロール.チャンネル": 値`。書いていないチャンネルは 0。リミット適用後の値）、
`bind_world_matrices`（バインド骨格 89 個）、`control_world_matrices`（コントロール 66 個）。

- `rest`、単一チャンネル 67 個、指の配分 3、届かない IK 1、複合 2、全チャンネル乱数 6、サンプルアニメのフレーム 8。
- まず `rest` と単一チャンネルを通し、次に乱数ケース、の順がおすすめです。許容は位置 0.01cm・軸 0.001 程度。
- ツイスト骨（`*_twist_*`）は別枠で比べると原因を切り分けやすいです。

## 6. メッシュ

- `sozai\SKM_Manny_Simple.FBX` は、**骨の名前・階層・静止姿勢がリグのバインド骨格と一致します**（Maya に読み込んで 89 個すべて誤差 0 を確認済み。リグ自体がこの FBX から作られています）。
- ただしこの FBX は UE 書き出し（Z-up）で、Maya は読み込み時に最上位ノードへ X −90° を入れて Y-up にしています。three.js の FBXLoader の軸の扱いに左右されないよう、
  **Maya の Y-up シーンから書き出した `manny_bind.fbx` を使うのをおすすめします**（中身は同じメッシュ・同じスキン・同じ骨格。`SKM_Manny_Simple`（X −90°）の下に `root`）。
  読み込んだら、骨のワールド行列が `spec.bind_skeleton[].world_matrix` と一致するか 1 回確かめてください。
- メッシュは LOD0〜2 の 3 つ（`SKM_Manny_Simple_LodGroup` の下）。Web では LOD0 だけで足ります。
- スキンに使う骨はバインド骨格（`root` 以下 89 個）。`drv_` 骨格は FBX に入っていません。

## 7. 逆方向（骨のポーズ → コントロール値）の注意

リグの自由度は骨格より少ないので、**どんなポーズでも厳密に戻せるわけではありません**。戻せるもの・近似になるものを分けます。

厳密に（解析的に）戻せるもの。**根元から順に**決めること（後のものは前の結果の上に乗る）:

1. `world_ctl`: 入力に root の動きがあるなら root に合わせる。無ければ 0。
2. `Hip_trans` = 骨盤のワールド位置（world_ctl 空間）− 静止位置。`Hip2_rot` = 骨盤のワールド回転から（parentConstraint のオフセットを外して、Hip_trans の子としてのローカル回転 → 回転順 xzy のオイラー）。
3. `X_Hand_trans` = 手首の位置 − 静止位置、`X_Foot_trans` = 足首の位置 − 静止位置（world_ctl 空間）。
4. `X_elbow_pv` / `X_knee_pv`: 肘（膝）の位置から面の向きを取り、`pv = 肘 + normalize(肘 − 肩と手首を結ぶ線への垂線の足) * 30cm`（膝は 50cm）。
   それを pv の親空間（肘: 胸に追従する ik_cns、膝: bns_spine_base の位置に追従する ik_cns）のローカル移動に直す。**腕・脚がほぼ伸びきっていると向きが定まらない**ので、前のフレームの値を引き継ぐ。
5. `X_Hand_rot`: 手のワールド回転 → orientConstraint のオフセットを外す → ik_cns（前腕に追従、**IK を解いた後の前腕**）のローカル回転 → 回転順 zyx のオイラー。
6. `X_Foot_rot`: 足のワールド回転から同様に（親の向きは world_ctl。回転順 xzy）。`X_Toe_rot.rz`: つま先の骨の、足に対する曲げ角（1 軸だけ）。
7. `X_Shoulder_rot`: 鎖骨のワールド回転から（ik_cns は胸に追従）。

近似になるもの:

- **背骨**: 骨 5 本に対して、コントロールは「胸の的の方向（2 自由度）＋ひねり 1 ＋腰」だけ。`Spine_trans` は「腰 → 胸（spine_05）の方向」に合わせ（的までの距離は自由。静止の距離を保つとよい）、`Spine_rot.ry` はその軸まわりの胸のひねり。背骨の丸まり方は再現できません。
- **首・頭**: `Head_trans` = 頭の位置 + 頭の前方向 × 80cm、`Head_rot.rx` = 頭の傾げ。首は rx, ry だけで、左右のひねりは「頭の向きの 40%」に固定。
- **指**: 第 2・第 3 関節は rz（曲げ）だけ、中手骨は数度のリミットつき。`finger_base_ROT` などは 0 にして、指 1 本ずつのコントロールで合わせるのが簡単。
- **骨の長さが入力と違う**と、手足の位置をそのまま入れても届かない／曲がりすぎます。位置は骨の長さの比で直してから入れる。
- ツイスト骨は出力なので、入力からは使いません（手首・足首の回転から自動で決まる）。

実装のすすめ: 上の解析解を初期値にして、順方向ソルバー（この文書の 3 章）との誤差を最小にする数値最適化（指標 = 主要な骨のワールド位置と向き）を数回まわすと、背骨・首の近似分まで含めてよく合います。順方向が `bns_rig_cases.json` で合っていることが前提です。

そのほか:

- オイラーに戻すときは各コントロールの回転順（`spec.controls[].rotate_order`）で。フレーム間で ±180° の飛びが出たら、前のフレームに近い方を選ぶ。
- 左手の指（ミラー軸）は、ワールド行列から `ローカル = ワールド * inverse(親ワールド)` を行列で計算すれば、普通の回転行列になります（負のスケールは根元の ik_cns にだけある）。
- mGear のミラー設定（左右の入れかえで符号を反転するチャンネル）は `spec.controls[].mirror`（`invTx`〜`invRz`）。
