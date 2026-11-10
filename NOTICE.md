# Notices

このリポジトリのコードは Apache License 2.0（[LICENSE](LICENSE)）です。次のものを含む・使います。

## NVIDIA MotionBricks（[NVlabs/motionbricks](https://github.com/NVlabs/motionbricks)、revision `54fc563`）

- **コード**（Apache-2.0）: `src/motionbricks.js` の入力のエンコード・出力のデコード・端点補正は、`motionbricks/model/soma/kernels.py` と `motionbricks/model/kernels.py` を JavaScript に移したものです（[soma-fighter-web](https://github.com/tomosud/soma-fighter-web) の `src/soma.js` 経由）。`src/mb_worker.js` は同リポジトリの `src/infer.worker.js` です。
- **モデルの重み**（[NVIDIA Open Model Agreement](https://github.com/NVlabs/motionbricks/blob/54fc563aeaaf819a753d72cc9fdc6713989cdd43/motionbricks/assets/onnx/LICENSE.md)）: このリポジトリには含めません。利用者のブラウザが NVIDIA の GitHub から `mmm_v6_soma_fp16.onnx` を直接ダウンロードします。Licensed by NVIDIA Corporation under the NVIDIA Open Model Agreement.

## 参考モーション DB（`assets/motiondb.json`, `assets/motiondb.bin`）

[soma-fighter-web](https://github.com/tomosud/soma-fighter-web) の `assets/fightdb.*` です。Mixamo（Adobe）のアニメーション 506 本を X Bot で書き出し、SOMA 骨格に移した姿勢データと、そこから計算した特徴量です。元の FBX は含みません。

## SOMA 骨格（`assets/soma_rig.json`、CC-BY-4.0）

[NVlabs/motionbricks](https://github.com/NVlabs/motionbricks) の `soma_base_skel_minimal_no_root.usd` から取り出した 30 関節のレスト姿勢です。© 2026 NVIDIA CORPORATION & AFFILIATES. 元のライセンス表記は [licenses/MotionBricks-LICENSE.txt](licenses/MotionBricks-LICENSE.txt)。

## リグ（`assets/bns_rig.json`, `rigspec/`）

mgear（Shifter）で UE5 マネキン骨格に組んだ `Rig_Manny_BNS` のノードグラフと検証ケースです。コントロールの名前と操作感は BNS FreeRIG（バンダイナムコスタジオ配布の練習用リグ）にならっています。BNS FreeRIG 本体は含みません。

## UE5 Manny

`assets/manny.json` と `assets/manny.bin` は UE5 マネキン（`SKM_Manny_Simple`）のスキンメッシュ、`assets/bns_rig.json` と `rigspec/` はその骨格の名前・階層・静止姿勢を含みます。UE5 マネキンは Epic Games のコンテンツで、Unreal Engine の使用許諾の条件に従います。このリポジトリの Apache License 2.0 はこれらには及びません。

## ライブラリ（CDN から読み込み）

- [three.js](https://github.com/mrdoob/three.js) 0.180.0 — MIT
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0 — MIT
