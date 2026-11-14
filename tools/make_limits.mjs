// How far each joint of a person turns, from the reference motion: every pose of the database (and its mirror
// image) put on the Manny skeleton, and for each joint its turn from the rest pose (relative to its parent),
// split into the twist about the bone and the swing of the bone (two angles).  The range kept is where nearly
// every pose is (0.5 - 99.5 %), a little widened.          node tools/make_limits.mjs   -> assets/limits.json
import { readFileSync, writeFileSync } from 'node:fs';
import { ControlRig } from '../src/rig.js';
import { SomaRig, MotionDB } from '../src/motiondb.js';
import { SomaToManny } from '../src/retarget.js';
import { jointTurn, LIMIT_JOINTS } from '../src/limits.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new ControlRig(JSON.parse(read('../assets/rig.json')));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const re = new SomaToManny(rig, soma, JSON.parse(read('../assets/retarget_cal.json')).joints);
const rest = Object.fromEntries(rig.joints.map(j => [j.name, j.rest]));

const vals = Object.fromEntries(LIMIT_JOINTS.map(j => [j.name, { twist: [], u: [], v: [] }]));
let n = 0;
for (let c = 0; c < db.clips.length; c++) {
  for (let f = 0; f < db.clips[c].frames; f += 3) {
    for (const mirror of [false, true]) {
      const T = re.targets(db.pose(c, f, mirror));
      for (const j of LIMIT_JOINTS) {
        const t = jointTurn(j, T[j.name], T[j.parent], rest);
        vals[j.name].twist.push(t.twist); vals[j.name].u.push(t.u); vals[j.name].v.push(t.v);
      }
      n++;
    }
  }
}
const pct = (a, p) => { const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
const out = {};
for (const j of LIMIT_JOINTS) {
  const r = {};
  for (const k of ['twist', 'u', 'v']) {
    const lo = pct(vals[j.name][k], 0.005), hi = pct(vals[j.name][k], 0.995), m = (hi - lo) * 0.05 + 3;
    r[k] = [+(lo - m).toFixed(1), +(hi + m).toFixed(1)];
  }
  out[j.name] = r;
  console.log(j.name.padEnd(12), 'twist', r.twist.join('..').padEnd(16), 'swing u', r.u.join('..').padEnd(16), 'v', r.v.join('..'));
}
writeFileSync(new URL('../assets/limits.json', import.meta.url), JSON.stringify({ about: 'how far each joint turns from rest, in degrees (tools/make_limits.mjs)', poses: n, joints: out }, null, 1));
console.log(n, 'poses');
