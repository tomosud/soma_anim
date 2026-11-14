// How long the rig takes to evaluate and to fit a pose.     node tools/bench_rig.mjs
import { readFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import { RigFitter } from '../src/fit.js';

const spec = JSON.parse(readFileSync(new URL('../assets/bns_rig.json', import.meta.url)));
const rig = new BnsRig(spec), fitter = new RigFitter(rig);
let s = 7;
const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
const poses = Array.from({ length: 60 }, () => {
  const v = new Float64Array(rig.channelKeys.length);
  rig.channelKeys.forEach((k, i) => { if (!rig.channelStep[i] && !/follow|Follow|autoShoulder/.test(k)) v[i] = rnd() * (k.includes('.t') ? 20 : 60); });
  return v;
});
const time = (name, f, reps = 3) => {
  f(); const t = performance.now();
  for (let r = 0; r < reps; r++) f();
  const ms = (performance.now() - t) / reps / poses.length;
  console.log(name.padEnd(10), ms.toFixed(3), 'ms');
  return ms;
};
console.log('nodes', rig.nodes.length, 'passes', rig.passes, 'loop nodes', rig.loop?.length ?? '-');
time('evaluate', () => { for (const v of poses) rig.setVector(v).evaluate(); });
const T = poses.map(v => { rig.setVector(v).evaluate(); return Object.fromEntries(['pelvis', 'spine_05', 'neck_01', 'head', ...['l', 'r'].flatMap(x => ['clavicle_', 'upperarm_', 'lowerarm_', 'hand_', 'thigh_', 'calf_', 'foot_', 'ball_'].map(j => j + x))].map(j => [j, rig.jointWorld(j).slice()])); });
time('fit', () => { let i = 0; for (const t of T) { rig.setVector(new Float64Array(poses[i++].length)); fitter.fit(t); } });
// a check that the evaluation is the same as before: a fingerprint of every node
let sum = 0;
for (const v of poses) { rig.setVector(v).evaluate(); for (const n of rig.nodes) for (let i = 0; i < 16; i++) sum += n.world[i] * ((i + n.index) % 7 + 1); }
console.log('fingerprint', sum.toPrecision(15));
