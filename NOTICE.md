# Notices

このリポジトリのコードは Apache License 2.0（[LICENSE](LICENSE)）です。次のものを含む・使います。

## 参考モーション DB（`assets/motiondb.json`, `assets/motiondb.bin`）

[soma-fighter-web](https://github.com/tomosud/soma-fighter-web) の `assets/fightdb.*` です。Mixamo（Adobe）のアニメーション 506 本を X Bot で書き出し、SOMA 骨格に移した姿勢データと、そこから計算した特徴量です。元の FBX は含みません。

## SOMA 骨格（`assets/soma_rig.json`、CC-BY-4.0）

[NVlabs/motionbricks](https://github.com/NVlabs/motionbricks) の `soma_base_skel_minimal_no_root.usd` から取り出した 30 関節のレスト姿勢です。© 2026 NVIDIA CORPORATION & AFFILIATES. 元のライセンス表記は [licenses/MotionBricks-LICENSE.txt](licenses/MotionBricks-LICENSE.txt)。

## リグ（`assets/bns_rig.json`, `rigspec/`）

mgear（Shifter）で UE5 マネキン骨格に組んだ `Rig_Manny_BNS` のノードグラフと検証ケースです。コントロールの名前と操作感は BNS FreeRIG（バンダイナムコスタジオ配布の練習用リグ）にならっています。BNS FreeRIG 本体は含みません。

## UE5 Manny

メッシュ（Epic Games のコンテンツ）は含みません。骨格の名前・階層・静止姿勢だけを、リグの定義として使っています。

## ライブラリ（CDN から読み込み）

- [three.js](https://github.com/mrdoob/three.js) 0.180.0 — MIT
