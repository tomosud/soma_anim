// The measures of the anime style on clips of the reference motion: the length, the anchors, the strikes,
// the feet.            node tools/style_check.mjs [clip-name-part ...]
import { readFileSync } from 'node:fs';
import { ControlRig } from '../src/rig.js';
import { SomaRig, MotionDB } from '../src/motiondb.js';
import { SomaToManny } from '../src/retarget.js';
import { RigFitter } from '../src/fit.js';
import { stylize, analyse, STYLE_JOINTS } from '../src/stylize.js';
import * as M from '../src/m4.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new ControlRig(JSON.parse(read('../assets/rig.json')));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const re = new SomaToManny(rig, soma, JSON.parse(read('../assets/retarget_cal.json')).joints);
const fitter = new RigFitter(rig);
const fps = db.fps || 30;

/** A clip of the database as rig poses. */
export function clipFrames(c) {
  const out = [];
  for (let f = 0; f < db.clips[c].frames; f++) { rig.setVector(new Float64Array(rig.channelKeys.length)); fitter.fit(re.targets(db.pose(c, f, false))); out.push(rig.getVector()); }
  return out;
}
const positions = frames => frames.map(v => { rig.setVector(v).evaluate(); return Object.fromEntries(STYLE_JOINTS.map(([j]) => [j, M.scl(M.pos(rig.jointWorld(j)), 1 / rig.scale)])); });

const want = process.argv.slice(2);
const picks = (want.length ? want : ['roundhouse', 'mma_high_kick', 'kicking_with_lead', 'jab', 'idle']).map(w => db.clips.findIndex(c => c.name.includes(w))).filter(i => i >= 0);
for (const c of picks) {
  const frames = clipFrames(c);
  const t = performance.now();
  // (all off: the fit back should give the same motion)
  const same = stylize(rig, fitter, frames, fps, { strength: 0, strikeSpeed: 1, keyHoldF: 0, strikeHoldF: 0, limbHoldF: 0, footLock: false });
  const P0 = positions(frames), Ps = positions(same.frames);
  let err = 0;
  for (let f = 0; f < frames.length; f++) for (const j in P0[f]) err = Math.max(err, M.dist(P0[f][j], Ps[f][j]));
  const r = stylize(rig, fitter, frames, fps, {});
  const ms = performance.now() - t;
  const a0 = analyse(P0, fps), a1 = analyse(positions(r.frames), fps);
  console.log(db.clips[c].name.slice(0, 40).padEnd(40), `n ${frames.length}->${r.frames.length}`, `same ${err.toFixed(2)}cm`,
    `strikes ${r.report.strikes}`, `anchors ${r.report.anchors} err ${r.report.anchorError.toFixed(3)}`,
    `limb max ${a0.vmax.toFixed(0)}->${a1.vmax.toFixed(0)} cm/s`, `feet ${r.report.contacts} slip ${r.report.footSlipBefore.toFixed(1)}->${r.report.footSlip.toFixed(1)} cm/s`, `${ms.toFixed(0)} ms`);
}
