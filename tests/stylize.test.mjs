// The anime style: the time warp keeps the length and the anchors, and on a kick of the reference
// motion the strikes are found, the limbs get faster, the feet stay planted, and with everything off the motion
// comes back as it was.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { ControlRig } from '../src/rig.js';
import { SomaRig, MotionDB } from '../src/motiondb.js';
import { SomaToManny } from '../src/retarget.js';
import { RigFitter } from '../src/fit.js';
import { stylize, analyse, lockedWarp, STYLE_JOINTS } from '../src/stylize.js';
import * as M from '../src/m4.js';

test('time warp: the anchors stay, time only goes forward, the holds stop it', () => {
  const n = 61, rate = Float64Array.from({ length: n }, (_, f) => (f > 20 && f < 30 ? 3 : 0.5));
  const times = lockedWarp(n, rate, [0, 40, 60], [{ at: 25, len: 4 }]);
  assert.equal(times.length, n);
  for (const a of [0, 40, 60]) assert.ok(Math.abs(times[a] - a) < 1e-9, `anchor ${a}: ${times[a]}`);
  for (let f = 1; f < n; f++) assert.ok(times[f] >= times[f - 1] - 1e-9);
  // (a hold: several output frames on about the same source time)
  let flat = 0;
  for (let f = 1; f <= 40; f++) if (times[f] - times[f - 1] < 0.05) flat++;
  assert.ok(flat >= 3, `held frames ${flat}`);
});

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new ControlRig(JSON.parse(read('../assets/rig.json')));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const re = new SomaToManny(rig, soma, JSON.parse(read('../assets/retarget_cal.json')).joints);
const fitter = new RigFitter(rig);
const c = db.clips.findIndex(x => x.name.includes('mma_high_kick'));
const frames = [];
for (let f = 0; f < db.clips[c].frames; f++) { rig.setVector(new Float64Array(rig.channelKeys.length)); fitter.fit(re.targets(db.pose(c, f, false))); frames.push(rig.getVector()); }
const positions = fr => fr.map(v => { rig.setVector(v).evaluate(); return Object.fromEntries(STYLE_JOINTS.map(([j]) => [j, M.scl(M.pos(rig.jointWorld(j)), 1 / rig.scale)])); });

test('stylize: everything off gives the motion back', () => {
  const r = stylize(rig, fitter, frames, 30, { strength: 0, strikeSpeed: 1, keyHoldF: 0, strikeHoldF: 0, limbHoldF: 0, footLock: false });
  const a = positions(frames), b = positions(r.frames);
  let err = 0;
  for (let f = 0; f < a.length; f++) for (const j in a[f]) err = Math.max(err, M.dist(a[f][j], b[f][j]));
  assert.ok(err < 2, `${err.toFixed(2)} cm`);
});

test('stylize: same length and anchors, faster strikes, planted feet, the keys kept', () => {
  const keys = [0, 30, 60];
  const r = stylize(rig, fitter, frames, 30, { anchors: keys });
  assert.equal(r.frames.length, frames.length);
  assert.ok(r.report.strikes >= 1);
  assert.ok(r.report.anchorError < 1e-6, String(r.report.anchorError));
  for (const k of keys) assert.ok(Math.abs(r.times[k] - k) < 1e-6, `key ${k}: ${r.times[k]}`);
  assert.ok(r.report.contacts >= 1);
  assert.ok(r.report.footSlip < 2 && r.report.footSlip < r.report.footSlipBefore, `${r.report.footSlipBefore} -> ${r.report.footSlip}`);
  assert.ok(analyse(positions(r.frames), 30).vmax > analyse(positions(frames), 30).vmax * 1.2);
  for (const v of r.frames) assert.ok(v.every(Number.isFinite));
});
