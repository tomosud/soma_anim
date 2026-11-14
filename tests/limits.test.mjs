// Joint limits: a pose outside what people do is brought inside, and a pose inside is left as it is.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import { RigFitter } from '../src/fit.js';
import { Limits } from '../src/limits.js';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const rig = new BnsRig(read('../assets/bns_rig.json')), fitter = new RigFitter(rig);
const L = new Limits(rig, fitter, read('../assets/limits.json'));
const pose = values => { rig.setValues(values); rig.evaluate(); return rig.getVector(); };

test('the start pose is inside every range', () => {
  const v = rig.vectorFromValues(read('../assets/start_pose.json').values);
  assert.deepStrictEqual(L.check(v), []);
  assert.strictEqual(L.apply(v), v);
});

for (const [name, values, joint] of [
  ['a wrist twisted past what a forearm turns', { 'L_Hand_rot.rx': 170 }, 'hand_l'],
  ['an ankle bent far back', { 'R_Foot_rot.rz': 95 }, 'foot_r'],
  ['a head turned round to look behind', { 'Head_trans.tx': 40, 'Head_trans.tz': -150 }, 'head'],
  ['a knee pointing backwards (the thigh turned over)', { 'L_knee_pv.tz': -140, 'L_Foot_trans.ty': 25 }, 'thigh_l'],
]) {
  test(`brought inside: ${name}`, () => {
    const v = pose(values);
    const before = L.check(v).find(x => x.joint === joint);
    assert.ok(before, `${joint} is not out of range to begin with: ${JSON.stringify(L.check(v))}`);
    const w = L.apply(v);
    const after = L.check(w).find(x => x.joint === joint);
    assert.ok(!after || after.by < before.by * 0.3, `${joint}: ${before.by} -> ${after?.by}`);
  });
}
