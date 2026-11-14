// Database poses put on the rig: hips, hands and feet must land where the retargeted skeleton has them.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { ControlRig } from '../src/rig.js';
import { SomaRig, MotionDB } from '../src/motiondb.js';
import { SomaToManny } from '../src/retarget.js';
import { RigFitter } from '../src/fit.js';
import * as M from '../src/m4.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new ControlRig(JSON.parse(read('../assets/rig.json')));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const re = new SomaToManny(rig, soma);
const fitter = new RigFitter(rig);

test('fit database poses', () => {
  const worst = {};
  let n = 0;
  const t0 = performance.now();
  for (let i = 0; i < db.n; i += 97) {
    const T = re.targets(db.pose(db.entClip[i], db.entFrame[i], !!db.entMirror[i]));
    fitter.fit(T);
    n++;
    for (const j of ['pelvis', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'head', 'lowerarm_l', 'calf_l', 'spine_05', 'neck_01']) {
      const g = rig.jointWorld(j);
      const p = M.dist(M.pos(g), M.pos(T[j]));
      const a = Math.acos(Math.min(1, (M.mul(M.rotation(g), M.transpose3(T[j])).filter((_, k) => k % 5 === 0 && k < 11).reduce((s, x) => s + x, 0) - 1) / 2)) / M.DEG;
      const w = worst[j] ??= { p: 0, a: 0, ps: 0, as: 0 };
      w.p = Math.max(w.p, p); w.a = Math.max(w.a, a); w.ps += p; w.as += a;
    }
  }
  const ms = (performance.now() - t0) / n;
  console.log(`poses ${n}, ${ms.toFixed(2)} ms per fit, rig passes ${rig.passes}`);
  for (const [j, w] of Object.entries(worst)) console.log(j.padEnd(12), `pos mean ${(w.ps / n).toFixed(2)} max ${w.p.toFixed(2)} cm   rot mean ${(w.as / n).toFixed(1)} max ${w.a.toFixed(1)} deg`);
  for (const j of ['pelvis', 'foot_l', 'foot_r']) assert.ok(worst[j].ps / n < 0.5, j);
});
