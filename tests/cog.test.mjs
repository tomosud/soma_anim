// COG_ctl put at the hips leaves every bone where it was (the recipe of the rig's maker, src/cog.js).
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import { cogTo, cogOffset } from '../src/cog.js';

const rig = new BnsRig(JSON.parse(readFileSync(new URL('../assets/bns_rig.json', import.meta.url))));
const bones = () => rig.joints.map(j => Array.from(rig.jointWorld(j.name)));
const poses = [
  { 'COG_ctl.ty': 40, 'COG_ctl.tz': 15, 'Hip_trans.ty': -30, 'Hip_trans.tx': 12, 'Spine_trans.tz': 8, 'L_Hand_trans.ty': 20 },
  { 'COG_ctl.ty': 60, 'COG_ctl.rx': 120, 'COG_ctl.ry': 35, 'Hip_trans.tz': -20, 'Hip2_rot.ry': 20, 'Head_trans.tx': 10, 'R_Foot_trans.ty': 15 },
  { 'COG_ctl.tx': -25, 'COG_ctl.rz': 30, 'Hip_trans.ty': 18, 'Spine_rot.ry': 25, 'Neck_rot.rx': 10, 'L_Foot_rot.follow': 2, 'R_Hand_rot.follow': 1 },
];

for (const [i, values] of poses.entries()) {
  test(`COG to the hips keeps the bones (pose ${i})`, () => {
    rig.setValues(values); rig.evaluate();
    const v = rig.getVector(), before = bones();
    const w = cogTo(rig, v);
    const after = (rig.setVector(w).evaluate(), bones());
    let worst = 0;
    before.forEach((m, j) => { for (const k of [12, 13, 14]) worst = Math.max(worst, Math.abs(m[k] - after[j][k])); });
    assert.ok(worst < 1e-6, `bones moved ${worst} cm`);
    const off = cogOffset(rig, w);
    assert.ok(Math.hypot(...off) < 1e-6, `COG not at the hips: ${off}`);
  });
}
