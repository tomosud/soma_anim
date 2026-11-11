// Calibration of rig -> SOMA: the roll of the limb bones.
// The rig's IK decides how a thigh, shin or arm is rolled about its own length; the SOMA skeleton has its own
// convention for the same pose.  Going SOMA -> rig the roll does not matter (IK ignores it), but going back the
// model would be shown limbs rolled 20-30 degrees from anything it has seen.  This measures, over poses of the
// reference motion put on the rig, the constant that takes the rig's joint rotation to the SOMA one.
//   node tools/make_retarget_cal.mjs      -> assets/retarget_cal.json
import { readFileSync, writeFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import { SomaRig, MotionDB, qmul, qinv } from '../src/motiondb.js';
import { SomaToManny } from '../src/retarget.js';
import { RigFitter } from '../src/fit.js';
import * as M from '../src/m4.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new BnsRig(JSON.parse(read('../assets/bns_rig.json')));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const re = new SomaToManny(rig, soma, null), fitter = new RigFitter(rig);
const names = ['spine_02', 'spine_03', 'spine_05', 'neck_01', 'neck_02', 'head', ...['l', 'r'].flatMap(s => ['clavicle_' + s, 'upperarm_' + s, 'lowerarm_' + s, 'thigh_' + s, 'calf_' + s])];
const acc = Object.fromEntries(names.map(n => [n, { sum: [0, 0, 0, 0], all: [] }]));
let count = 0;
for (let c = 0; c < db.clips.length; c++) {
  if (['fall', 'getup', 'hit'].includes(db.clips[c].tag)) continue;
  for (let f = 5; f < db.clips[c].frames; f += 40) {
    const p = db.pose(c, f), placed = soma.place(p, -soma.heading(soma.positions(p)), 0, 0);
    if (placed.root[1] < 0.6) continue;
    rig.setVector(new Float64Array(rig.channelKeys.length));
    fitter.fit(re.targets(placed));
    for (const n of names) {
      const j = re.joints.find(x => x.name === n);
      // c' with q_soma = R_rig * inverse(c')
      let q = qmul(qinv(soma.rot(placed, j.s)), M.toQuat(M.rotation(rig.jointWorld(n))));
      const a = acc[n];
      if (a.all.length && q[0] * a.all[0][0] + q[1] * a.all[0][1] + q[2] * a.all[0][2] + q[3] * a.all[0][3] < 0) q = q.map(x => -x);
      a.all.push(q); for (let k = 0; k < 4; k++) a.sum[k] += q[k];
    }
    count++;
  }
}
const out = {};
for (const n of names) {
  const a = acc[n], l = Math.hypot(...a.sum), mean = a.sum.map(x => x / l);
  const ang = a.all.map(q => 2 * Math.acos(Math.min(1, Math.abs(q[0] * mean[0] + q[1] * mean[1] + q[2] * mean[2] + q[3] * mean[3]))) * 57.3).sort((x, y) => x - y);
  const j = re.joints.find(x => x.name === n);
  const was = 2 * Math.acos(Math.min(1, Math.abs(j.c[0] * mean[0] + j.c[1] * mean[1] + j.c[2] * mean[2] + j.c[3] * mean[3]))) * 57.3;
  console.log(n.padEnd(12), 'constant differs from the rest-pose one by', was.toFixed(1), 'deg;  left over: median', ang[ang.length >> 1].toFixed(1), ' 90%', ang[Math.floor(ang.length * 0.9)].toFixed(1), ' max', ang[ang.length - 1].toFixed(1));
  out[n] = mean.map(x => +x.toFixed(6));
}
console.log(count, 'poses');
writeFileSync(new URL('../assets/retarget_cal.json', import.meta.url), JSON.stringify({ about: 'rig -> SOMA rotation of the limb bones (tools/make_retarget_cal.mjs)', joints: out }));
