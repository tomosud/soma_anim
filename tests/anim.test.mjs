// Mirror, natural posing and in-betweens on the real database.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import { SomaRig, MotionDB } from '../src/motiondb.js';
import { SomaToManny, queryFromRig } from '../src/retarget.js';
import { RigFitter } from '../src/fit.js';
import { Naturalizer } from '../src/natural.js';
import { Inbetweener } from '../src/inbetween.js';
import * as M from '../src/m4.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new BnsRig(JSON.parse(read('../assets/bns_rig.json')));
const cases = JSON.parse(read('../rigspec/bns_rig_cases.json')).cases;
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const re = new SomaToManny(rig, soma);
const fitter = new RigFitter(rig);
const nat = new Naturalizer(rig, db, re, fitter);
const inb = new Inbetweener(rig, db, re, fitter);
const jp = n => M.pos(rig.jointWorld(n));
const other = n => n.endsWith('_l') ? n.slice(0, -1) + 'r' : n.endsWith('_r') ? n.slice(0, -1) + 'l' : n;

test('mirror: the mirrored pose is the mirror image', () => {
  let worst = 0, name = '';
  for (const c of cases.filter(c => /random|sample|squat/.test(c.name))) {
    const v = rig.vectorFromValues(c.controls);
    v[rig.channelIndex.get('world_ctl.tx')] = 0; v[rig.channelIndex.get('world_ctl.ry')] = 0;
    rig.setVector(v).evaluate();
    const P = Object.fromEntries(rig.joints.map(j => [j.name, jp(j.name)]));
    rig.setVector(rig.mirrorVector(v)).evaluate();
    for (const j of rig.joints) {
      if (/^ik_|interaction|center/.test(j.name)) continue;
      const a = P[other(j.name)], b = jp(j.name), e = M.dist([-a[0], a[1], a[2]], b);
      if (e > worst) { worst = e; name = c.name + ' ' + j.name; }
    }
  }
  console.log('mirror worst', worst.toFixed(3), 'cm', name);
  assert.ok(worst < 0.5);
});

test('natural pose keeps the pinned controls', () => {
  const v = rig.vectorFromValues({ 'R_Hand_trans.ty': 55, 'R_Hand_trans.tz': 30, 'R_Hand_trans.tx': 10 });
  const pins = new Set(['R_Hand_trans', 'L_Foot_trans', 'R_Foot_trans']);
  const t0 = performance.now();
  const r = nat.naturalize(v, pins, 1);
  console.log('natural:', r.match, (performance.now() - t0).toFixed(1), 'ms');
  for (const k of ['R_Hand_trans.tx', 'R_Hand_trans.ty', 'R_Hand_trans.tz', 'L_Foot_trans.tx']) assert.equal(r.vector[rig.channelIndex.get(k)], v[rig.channelIndex.get(k)]);
  assert.ok(r.match);
});

test('in-between: meets the keys, moves like the reference', () => {
  const A = new Float64Array(rig.channelKeys.length);
  // B: a step forward, 70 cm ahead
  const B = rig.vectorFromValues({ 'Hip_trans.tz': 70, 'L_Foot_trans.tz': 95, 'R_Foot_trans.tz': 55, 'Spine_trans.tz': 72, 'Head_trans.tz': 72, 'L_Hand_trans.tz': 55, 'R_Hand_trans.tz': 85, 'L_knee_pv.tz': 70, 'R_knee_pv.tz': 70, 'L_elbow_pv.tz': 70, 'R_elbow_pv.tz': 70 });
  for (const n of [12, 30, 45]) {
    const t0 = performance.now();
    const r = inb.generate(A, B, n);
    const ms = performance.now() - t0;
    assert.equal(r.frames.length, n - 1);
    // step sizes: no jump at the keys
    const seq = [A, ...r.frames, B];
    let maxStep = 0, where = 0;
    const pts = seq.map(v => { rig.setVector(v).evaluate(); return ['pelvis', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'head'].map(jp); });
    for (let k = 1; k < pts.length; k++) for (let j = 0; j < 6; j++) { const d = M.dist(pts[k][j], pts[k - 1][j]); if (d > maxStep) { maxStep = d; where = k; } }
    console.log(`n=${n}: ${r.match.clip} f${r.match.frame}+${r.match.frames} x${r.match.speed.toFixed(2)} cost ${r.match.cost.toFixed(3)}, ${ms.toFixed(0)} ms, largest step ${maxStep.toFixed(1)} cm at ${where}`);
    assert.ok(maxStep < 25);
    for (const v of r.frames) assert.ok(v.every(Number.isFinite));
  }
});

test('whole-body control: poses move with it, in-betweens still meet the keys', () => {
  const A = rig.vectorFromValues({ 'R_Hand_trans.ty': 40 });
  const B = rig.vectorFromValues({ 'R_Hand_trans.ty': 40, 'world_ctl.tx': 80, 'world_ctl.tz': 50, 'world_ctl.ry': 90 });
  rig.setVector(A).evaluate(); const a = jp('hand_r'), pa = jp('pelvis');
  rig.setVector(B).evaluate(); const b = jp('hand_r'), pb = jp('pelvis');
  // the same pose, carried: the hand keeps its distance to the hips
  assert.ok(Math.abs(M.dist(a, pa) - M.dist(b, pb)) < 1e-6);
  assert.ok(M.dist(pa, pb) > 50);
  const r = inb.generate(A, B, 24);
  const seq = [A, ...r.frames, B];
  let maxStep = 0;
  const pts = seq.map(v => { rig.setVector(v).evaluate(); return ['pelvis', 'hand_r', 'foot_l', 'head'].map(jp); });
  for (let k = 1; k < pts.length; k++) for (let j = 0; j < 4; j++) maxStep = Math.max(maxStep, M.dist(pts[k][j], pts[k - 1][j]));
  console.log('world move: largest step', maxStep.toFixed(1), 'cm,', r.match.clip);
  assert.ok(maxStep < 30); // (94 cm and a quarter turn in 24 frames is a fast move)
  // natural posing under a moved whole-body control keeps it
  const n = nat.naturalize(B, new Set(['R_Hand_trans']), 1);
  assert.equal(n.vector[rig.channelIndex.get('world_ctl.tx')], 80);
  rig.setVector(n.vector).evaluate();
  assert.ok(M.dist(jp('pelvis'), pb) < 40);
});
