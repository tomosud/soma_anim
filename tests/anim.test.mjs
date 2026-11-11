// Mirror, natural posing and in-betweens on the real database.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import { SomaRig, MotionDB } from '../src/motiondb.js';
import { SomaToManny, queryFromRig } from '../src/retarget.js';
import { RigFitter } from '../src/fit.js';
import { Naturalizer } from '../src/natural.js';
import { Physical } from '../src/physical.js';
import { Inbetweener } from '../src/inbetween.js';
import * as M from '../src/m4.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new BnsRig(JSON.parse(read('../assets/bns_rig.json')));
const cases = JSON.parse(read('../rigspec/bns_rig_cases.json')).cases;
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const re = new SomaToManny(rig, soma, JSON.parse(read('../assets/retarget_cal.json')).joints);
const fitter = new RigFitter(rig);
const physical = new Physical(rig);
const nat = new Naturalizer(rig, db, re, fitter, physical);
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

const start = rig.vectorFromValues(JSON.parse(read('../assets/start_pose.json')).values);
const FEET = ['L_Foot_trans', 'R_Foot_trans', 'L_Foot_rot', 'R_Foot_rot', 'L_Toe_rot', 'R_Toe_rot'];
const edit = (v, values) => { const out = v.slice(); for (const [k, x] of Object.entries(values)) out[rig.channelIndex.get(k)] += x; return out; };
/** A limb as the body sees it (relative to the hips). */
const rel = n => M.sub(jp(n), jp('pelvis'));

test('natural pose: the edited control stays, the other hand is left alone', () => {
  const v = edit(start, { 'R_Hand_trans.ty': 70, 'R_Hand_trans.tz': 25 });
  const pins = new Set(['R_Hand_trans', ...FEET]);
  rig.setVector(start).evaluate(); const before = rel('hand_l'), feet = ['foot_l', 'foot_r'].map(jp);
  const t0 = performance.now();
  const r = nat.naturalize(v, pins, 0.8, { before: start, touched: ['R_Hand_trans'], held: pins });
  console.log('natural:', r.match?.clip, (performance.now() - t0).toFixed(1), 'ms');
  for (const k of ['R_Hand_trans.tx', 'R_Hand_trans.ty', 'R_Hand_trans.tz']) assert.equal(r.vector[rig.channelIndex.get(k)], v[rig.channelIndex.get(k)]);
  rig.setVector(r.vector).evaluate();
  assert.ok(M.dist(rel('hand_l'), before) < 12, 'the other hand moved ' + M.dist(rel('hand_l'), before).toFixed(1));
  ['foot_l', 'foot_r'].forEach((n, i) => assert.ok(M.dist(jp(n), feet[i]) < 1, 'feet stay ' + M.dist(jp(n), feet[i]).toFixed(2)));
  assert.ok(r.vector.every(Number.isFinite));
});

test('natural pose: lowering the hips brings the body along', () => {
  const v = edit(start, { 'Hip_trans.ty': -35 });
  rig.setVector(start).evaluate(); const hand = rel('hand_l'), head = rel('head');
  const r = nat.naturalize(v, new Set(['Hip_trans', ...FEET]), 0.8, { before: start, touched: ['Hip_trans'] });
  assert.equal(r.vector[rig.channelIndex.get('Hip_trans.ty')], v[rig.channelIndex.get('Hip_trans.ty')]);
  rig.setVector(r.vector).evaluate();
  // (left where they were in the world the hands would now be 35 cm higher on the body)
  assert.ok(M.dist(rel('hand_l'), hand) < 20, 'hand ' + M.dist(rel('hand_l'), hand).toFixed(1));
  assert.ok(M.dist(rel('head'), head) < 20, 'head ' + M.dist(rel('head'), head).toFixed(1));
  // follow() alone (what a drag shows) is rigid
  rig.setVector(nat.follow(v, new Set(['Hip_trans', ...FEET]), start)).evaluate();
  assert.ok(M.dist(rel('hand_l'), hand) < 3, 'follow: hand ' + M.dist(rel('hand_l'), hand).toFixed(1));
});

test('natural pose: what a body cannot hold is put right', () => {
  // a foot lifted forward: the weight goes over the standing foot
  let v = edit(start, { 'R_Foot_trans.ty': 45, 'R_Foot_trans.tz': 40 });
  rig.setVector(v).evaluate();
  assert.ok(physical.offBalance() > 5);
  let r = nat.naturalize(v, new Set(FEET), 0.8, { before: start, touched: ['R_Foot_trans'] });
  rig.setVector(r.vector).evaluate();
  assert.ok(physical.offBalance() < 1.5, 'off balance ' + physical.offBalance().toFixed(1));
  // a foot put under the floor comes up, a foot out of reach brings the hips
  v = edit(start, { 'L_Foot_trans.ty': -15 });
  rig.setVector(physical.fix(v, new Set()).vector).evaluate();
  assert.ok(jp('foot_l')[1] > physical.floor.foot_l - 0.1);
  v = edit(start, { 'L_Foot_trans.tz': 85 });
  r = nat.naturalize(v, new Set(FEET), 0.8, { before: start, touched: ['L_Foot_trans'] });
  rig.setVector(r.vector).evaluate();
  assert.ok(M.dist(jp('foot_l'), M.pos(rig.controlWorld('L_Foot_trans'))) < 0.5, 'the foot reaches its control');
  // balance off: nothing is corrected
  r = nat.naturalize(edit(start, { 'R_Foot_trans.ty': 45, 'R_Foot_trans.tz': 40 }), new Set(FEET), 0, { before: start, touched: ['R_Foot_trans'], balance: false });
  rig.setVector(r.vector).evaluate();
  assert.ok(physical.offBalance() > 5);
});

test('plain in-between with steps: meets the keys, feet do not slide', () => {
  const A = start, B = edit(start, { 'world_ctl.tz': 60 });
  const frames = inb.steps(A, B, 30);
  assert.equal(frames.length, 29);
  const seq = [A, ...frames, B];
  const pts = seq.map(v => { rig.setVector(v).evaluate(); return ['pelvis', 'foot_l', 'foot_r'].map(jp); });
  let maxStep = 0, still = 0;
  for (let k = 1; k < pts.length; k++) {
    for (let j = 0; j < 3; j++) maxStep = Math.max(maxStep, M.dist(pts[k][j], pts[k - 1][j]));
    for (let j = 1; j < 3; j++) if (M.dist(pts[k][j], pts[k - 1][j]) < 0.05) still++;
  }
  console.log('steps: largest move per frame', maxStep.toFixed(1), 'cm; frames a foot stands still', still);
  assert.ok(maxStep < 12);
  assert.ok(still > 15, 'each foot stands while the other steps');
  for (const v of frames) assert.ok(v.every(Number.isFinite));
});

test('whole-body control: poses move with it', () => {
  const A = rig.vectorFromValues({ 'R_Hand_trans.ty': 40 });
  const B = rig.vectorFromValues({ 'R_Hand_trans.ty': 40, 'world_ctl.tx': 80, 'world_ctl.tz': 50, 'world_ctl.ry': 90 });
  rig.setVector(A).evaluate(); const a = jp('hand_r'), pa = jp('pelvis');
  rig.setVector(B).evaluate(); const b = jp('hand_r'), pb = jp('pelvis');
  // the same pose, carried: the hand keeps its distance to the hips
  assert.ok(Math.abs(M.dist(a, pa) - M.dist(b, pb)) < 1e-6);
  assert.ok(M.dist(pa, pb) > 50);
  // natural posing under a moved whole-body control keeps it
  const n = nat.naturalize(B, new Set(['R_Hand_trans']), 1);
  assert.equal(n.vector[rig.channelIndex.get('world_ctl.tx')], 80);
  rig.setVector(n.vector).evaluate();
  assert.ok(M.dist(jp('pelvis'), pb) < 40);
});

test('foot reset: flat on the floor, where they were', async () => {
  const { FootReset } = await import('../src/feet.js');
  const fr = new FootReset(rig);
  const rest = n => rig.joints[rig.jointIndex.get(n)].rest[13];
  for (const values of [
    { 'L_Foot_trans.ty': 12, 'L_Foot_rot.rx': 30, 'L_Foot_rot.rz': -20, 'R_Foot_trans.ty': -6, 'R_Foot_rot.ry': 25, 'R_Toe_rot.rz': 30 },
    { 'Hip_trans.ty': 20, 'L_Foot_trans.tz': 40, 'R_Foot_trans.tx': -30, 'L_Foot_rot.rx': -40 },
    { 'world_ctl.tx': 100, 'world_ctl.ry': 70, 'L_Foot_trans.ty': 9, 'R_Foot_rot.rz': 35, 'L_knee_pv.tx': 60 },
  ]) {
    const v = rig.vectorFromValues(values);
    rig.setVector(v).evaluate();
    const before = ['foot_l', 'foot_r'].map(jp);
    rig.setVector(fr.apply(v)).evaluate();
    for (const [i, s] of ['l', 'r'].entries()) {
      const f = jp('foot_' + s), b = jp('ball_' + s);
      assert.ok(Math.abs(f[1] - rest('foot_' + s)) < 0.05, `ankle height ${f[1]}`);
      assert.ok(Math.abs(b[1] - rest('ball_' + s)) < 0.3, `ball height ${b[1]}`);
      assert.ok(Math.hypot(f[0] - before[i][0], f[2] - before[i][2]) < 0.05, 'stays in place');
      // the knee bends the way the foot points
      const k = jp('calf_' + s), h = jp('thigh_' + s), d = M.norm([b[0] - f[0], 0, b[2] - f[2]]);
      const mid = M.lerp(h, f, 0.5);
      assert.ok(M.dot(M.sub(k, mid), d) > -0.5, 'knee forward');
    }
  }
});

test('fbx: the file holds the animation of every bone', async () => {
  const { writeFbx, sampleJoints } = await import('../src/fbx.js');
  const A = new Float64Array(rig.channelKeys.length), B = rig.vectorFromValues({ 'R_Hand_trans.ty': 50, 'Hip_trans.ty': -20, 'world_ctl.tz': 30 });
  const text = writeFbx(rig, [A, ...inb.interpolate(A, B, 6).frames, B], 30);
  assert.equal((text.match(/Model: \d+, "Model::/g) || []).length, 89);
  assert.equal((text.match(/AnimationCurve: /g) || []).length, 89 * 6);
  assert.ok(text.includes('KeyTime: *7'));
  // local samples rebuild the world matrices
  rig.setVector(B).evaluate();
  const S = sampleJoints(rig), world = {};
  rig.joints.forEach((j, i) => {
    const l = M.compose(M.mul(M.euler(S[i].slice(3), 'xyz'), M.euler(j.orientEuler, 'xyz')), S[i].slice(0, 3));
    world[j.name] = world[j.parent] ? M.mul(l, world[j.parent]) : l;
    const w = rig.jointWorld(j.name);
    for (let k = 0; k < 16; k++) assert.ok(Math.abs(world[j.name][k] - w[k]) < 1e-3, j.name);
  });
});
