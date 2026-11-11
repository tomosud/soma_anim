// The pose a new scene starts in: a relaxed stand from the reference motion (not the rig's A-pose, which no
// motion model has ever seen anybody move out of), feet flat on the floor.  node tools/make_start_pose.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import { SomaRig, MotionDB } from '../src/motiondb.js';
import { SomaToManny } from '../src/retarget.js';
import { RigFitter } from '../src/fit.js';
import { FootReset } from '../src/feet.js';
import { Physical } from '../src/physical.js';
import { Naturalizer } from '../src/natural.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new BnsRig(JSON.parse(read('../assets/bns_rig.json')));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const [name, frame] = [process.argv[2] ?? 'standard_idle', +(process.argv[3] ?? 10)];
const clip = db.clips.findIndex(c => c.name.startsWith(name));
const pose = db.pose(clip, frame);
const placed = soma.place(pose, -soma.heading(soma.positions(pose)), 0, 0);
const re = new SomaToManny(rig, soma, JSON.parse(read('../assets/retarget_cal.json')).joints), fitter = new RigFitter(rig);
rig.setVector(new Float64Array(rig.channelKeys.length));
fitter.fit(re.targets(placed));
const fitted = rig.getVector();
// feet flat on the floor where they stand, the hips only as much lower as the legs need, and the rest of the
// body brought along with the hips (hands and head are controls in the world: they would stay behind)
const flat = new FootReset(rig).apply(fitted), v = fitted.slice();
const FEET = [];
rig.channelKeys.forEach((k, i) => { if (/_(Foot_trans|Foot_rot|Toe_rot)[.]/.test(k)) { v[i] = flat[i]; FEET.push(k.split('.')[0]); } });
const fixed = new Physical(rig).fix(v).vector;
const nat = new Naturalizer(rig, db, re, fitter, null);
const out = nat.follow(fixed, new Set(['Hip_trans', ...FEET]), v);
rig.setVector(out).evaluate();
for (const s of 'lr') console.log('foot_' + s, 'reaches its control within', Math.hypot(...[12, 13, 14].map(k => rig.jointWorld('foot_' + s)[k] - rig.controlWorld(s.toUpperCase() + '_Foot_trans')[k])).toFixed(2), 'cm; pelvis', rig.jointWorld('pelvis')[13].toFixed(1));
// how the model will see it, against the pose it was made from
const back = re.fromRig(rig), diff = [];
for (let j = 0; j < soma.n; j++) {
  const a = soma.rot(placed, j), b = soma.rot(back, j), ang = 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 57.3;
  if (ang > 4) diff.push(soma.names[j] + ' ' + ang.toFixed(0));
}
console.log('joint rotations that differ from the reference pose (deg):', diff.join(', '));
const values = Object.fromEntries(Object.entries(rig.valuesFromVector(out)).map(([k, x]) => [k, +x.toFixed(3)]).filter(e => e[1] !== 0));
writeFileSync(new URL('../assets/start_pose.json', import.meta.url), JSON.stringify({ about: `relaxed stand: ${db.clips[clip].name} frame ${frame}`, values }, null, 1));
console.log(Object.keys(values).length, 'channels');
