// Test of natural posing: edits an animator makes, one control at a time, and what comes of them.
// Runs in node (node tools/posetest.js: the numbers) and in the page ((await import('/tools/posetest.js')).draw():
// eval_out/pose_*.png - per case the pose before, the bare edit, and the result).
import * as M from '../src/m4.js';
import { queryFromRig, rigHeading } from '../src/retarget.js';
import { poseWeights } from '../src/natural.js';

const FEET = ['L_Foot_trans', 'R_Foot_trans', 'L_Foot_rot', 'R_Foot_rot', 'L_Toe_rot', 'R_Toe_rot'];

/** from: a start ('stand' or [clip, frame]); edits: [[control, {channel: offset}], ...] one after another. */
export const CASES = {
  'hand up': { edits: [['R_Hand_trans', { ty: 75, tz: 20 }]] },
  'hand out to the side': { edits: [['R_Hand_trans', { tx: -45, ty: 45 }]] },
  'reach far forward': { edits: [['R_Hand_trans', { tz: 95, ty: 35 }]] },
  'hand to the floor': { edits: [['R_Hand_trans', { ty: -70, tz: 35 }]] },
  'both hands up': { edits: [['R_Hand_trans', { ty: 85, tz: 15 }], ['L_Hand_trans', { ty: 85, tz: 15 }]] },
  'hand behind back': { edits: [['L_Hand_trans', { tz: -30, tx: -20, ty: 10 }]] },
  'crouch': { edits: [['Hip_trans', { ty: -40 }]] },
  'deep squat': { edits: [['Hip_trans', { ty: -68 }]] },
  'hips far to the side': { edits: [['Hip_trans', { tx: 30 }]] },
  'hips far forward': { edits: [['Hip_trans', { tz: 45 }]] },
  'hips turned': { edits: [['Hip2_rot', { ry: 40 }]] },
  'foot lifted forward': { edits: [['R_Foot_trans', { ty: 45, tz: 40 }]] },
  'foot wide to the side': { edits: [['R_Foot_trans', { tx: -60 }]] },
  'foot back and up': { edits: [['R_Foot_trans', { tz: -50, ty: 30 }]] },
  'foot far forward (lunge)': { edits: [['L_Foot_trans', { tz: 85 }]] },
  'foot under the floor': { edits: [['L_Foot_trans', { ty: -15 }]] },
  'bow': { edits: [['Spine_trans', { tz: 40, ty: -15 }]] },
  'lean back': { edits: [['Spine_trans', { tz: -30 }]] },
  'look to the side': { edits: [['Head_trans', { tx: 80 }]] },
  'crouch, then reach': { edits: [['Hip_trans', { ty: -40 }], ['R_Hand_trans', { tz: 60, ty: 10 }]] },
  'hand up, then crouch': { edits: [['R_Hand_trans', { ty: 75, tz: 20 }], ['Hip_trans', { ty: -40 }]] },
  'five edits of one hand': { edits: [['R_Hand_trans', { ty: 30 }], ['R_Hand_trans', { tz: 30 }], ['R_Hand_trans', { tx: -20 }], ['R_Hand_trans', { ty: 30 }], ['R_Hand_trans', { tz: -20 }]] },
  'boxing stance: jab': { from: ['stance_boxing_idle', 20], edits: [['L_Hand_trans', { tz: 45, ty: 5 }]] },
  'crouched: hand up': { from: ['crouched_walk', 30], edits: [['R_Hand_trans', { ty: 60 }]] },
  'kick pose: other hand': { from: ['kick_mma_side_kick', 40], edits: [['L_Hand_trans', { ty: 30 }]] },
  'whole body moved': { edits: [['world_ctl', { tz: 120, ry: 45 }]] },
};

const LIMBS = ['hand_l', 'hand_r', 'head', 'foot_l', 'foot_r'];
const LIMB_OF = { hand_l: 'L_Hand', hand_r: 'R_Hand', head: 'Head', foot_l: 'L_Foot', foot_r: 'R_Foot' };

/** env: {rig, nat, db, re, fitter, physical, start}.  Returns [{name, steps: [{before, edit, result, ...numbers}]}]. */
export function runCases(env, names = Object.keys(CASES), { strength = 0.8, natural = null } = {}) {
  const { rig, nat, db, re, fitter, physical } = env, soma = db.rig, out = [];
  const body = () => { const h = rigHeading(rig), c = Math.cos(h), s = Math.sin(h), p = M.pos(rig.jointWorld('pelvis')), B = {}; for (const j of LIMBS) { const q = M.pos(rig.jointWorld(j)), dx = q[0] - p[0], dz = q[2] - p[2]; B[j] = [dx * c - dz * s, q[1] - p[1], dx * s + dz * c]; } return B; };
  const world = () => Object.fromEntries(LIMBS.map(j => [j, M.pos(rig.jointWorld(j))]));
  const ref = () => { const hit = db.nearest(queryFromRig(rig, re).q, poseWeights(new Set()), 1, nat.skip)[0]; return Math.sqrt(hit.cost) * 100; };
  for (const name of names) {
    const c = CASES[name];
    let v;
    if (c.from) {
      const clip = db.clips.findIndex(x => x.name.startsWith(c.from[0])), pose = db.pose(clip, c.from[1]);
      rig.setVector(new Float64Array(rig.channelKeys.length));
      fitter.fit(re.targets(soma.place(pose, -soma.heading(soma.positions(pose)), 0, 0)));
      v = rig.getVector();
    } else v = env.start.slice();
    const pins = new Set(), steps = [];
    for (const [ctl, off] of c.edits) {
      const before = v.slice(), edit = v.slice();
      for (const [ch, x] of Object.entries(off)) edit[rig.channelIndex.get(ctl + '.' + ch)] += x;
      pins.add(ctl);
      const eff = new Set([...pins, ...FEET]);
      rig.setVector(before).evaluate(); const B0 = body(), W0 = world(), off0 = physical.offBalance(), ref0 = ref();
      rig.setVector(edit).evaluate(); const offE = physical.offBalance(), refE = ref();
      const t0 = performance.now();
      const r = natural ? natural(edit, eff, before, [ctl]) : ctl === 'world_ctl' ? { vector: edit, notes: [] } : nat.naturalize(edit, pins, strength, { before, touched: [ctl], held: new Set([ctl, ...FEET]) });
      const ms = performance.now() - t0;
      rig.setVector(r.vector).evaluate();
      const B1 = body(), W1 = world();
      // the edited control stays put
      let kept = 0;
      for (const ch of Object.keys(off)) { const i = rig.channelIndex.get(ctl + '.' + ch); kept = Math.max(kept, Math.abs(r.vector[i] - edit[i])); }
      // how far the limbs nobody touched moved, as the body sees them (and feet in the world)
      const moved = {};
      for (const j of LIMBS) { if (ctl.startsWith(LIMB_OF[j])) continue; moved[j] = j.startsWith('foot') ? M.dist(W0[j], W1[j]) : M.dist(B0[j], B1[j]); }
      let reach = 0;
      for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
        reach = Math.max(reach, M.dist(M.pos(rig.jointWorld('foot_' + s)), M.pos(rig.controlWorld(S + '_Foot_trans'))), M.dist(M.pos(rig.jointWorld('hand_' + s)), M.pos(rig.controlWorld(S + '_Hand_trans'))));
      }
      const sink = Math.max(0, ...['l', 'r'].map(s => physical.floor['foot_' + s] - rig.jointWorld('foot_' + s)[13]));
      steps.push({ ctl, before, edit, result: r.vector, kept, moved, off0, offE, off1: physical.offBalance(), ref0, refE, ref1: ref(), reach, sink, notes: r.notes, match: r.match, ms });
      v = r.vector;
    }
    out.push({ name, steps });
  }
  return out;
}

export function table(results) {
  const pad = (s, n) => String(s).padEnd(n), f = x => (x === undefined ? '-' : x.toFixed(0));
  const lines = [pad('case', 28) + pad('edit', 14) + 'kept  bal: before>edit>after  ref: before>edit>after  unreached sink  moved: handL handR head footL footR   ms  notes'];
  let worst = { moved: 0, off: 0, reach: 0, kept: 0 };
  for (const r of results) for (const s of r.steps) {
    lines.push(pad(r.name, 28) + pad(s.ctl, 14) + pad(s.kept.toFixed(2), 6) + pad(`${f(s.off0)} > ${f(s.offE)} > ${f(s.off1)}`, 23) + pad(`${f(s.ref0)} > ${f(s.refE)} > ${f(s.ref1)}`, 23) + pad(s.reach.toFixed(1), 10) + pad(s.sink.toFixed(1), 6)
      + LIMBS.map(j => pad(f(s.moved[j]), 6)).join('') + pad(s.ms.toFixed(0), 5) + (s.notes || []).join(' / '));
    worst.off = Math.max(worst.off, s.off1); worst.reach = Math.max(worst.reach, s.reach); worst.kept = Math.max(worst.kept, s.kept);
  }
  lines.push('', `worst: off balance ${worst.off.toFixed(1)} cm, unreached ${worst.reach.toFixed(1)} cm, edited control moved ${worst.kept.toFixed(2)}`);
  return lines.join('\n');
}

/** In the page: the pictures. */
export async function draw(names = Object.keys(CASES), tag = '') {
  const { strip, savePng } = await import('./draw.js');
  const app = window.app, env = app.env;
  const results = runCases(env, names);
  const held = app.rig.getVector();
  const per = 4;
  for (let i = 0; i < results.length; i += per) {
    const rows = [];
    for (const r of results.slice(i, i + per)) {
      for (const view of [['front', 'front'], ['side', 'side']]) {
        const frames = [r.steps[0].before], labels = ['before'];
        for (const s of r.steps) { frames.push(s.edit, s.result); labels.push('edit ' + s.ctl, 'result'); }
        rows.push({ label: `${r.name}  (${view[0]})   ` + labels.map((l, k) => `${k}: ${l}`).join('   ') + '   ' + r.steps.map(s => (s.notes || []).join(', ')).join(' | '), frames, keys: frames.map((_, k) => k).filter(k => k && k % 2 === 0), [view[1]]: true });
      }
    }
    await savePng(strip(app.rig, env.physical.floor, rows, { per: 99, shot: app.shot }), `pose_${String(i / per).padStart(2, '0')}${tag}.png`);
  }
  app.rig.setVector(held).evaluate();
  const text = table(results);
  await fetch('/save/posetest' + tag + '.txt', { method: 'POST', body: text });
  return text;
}

// node tools/posetest.js
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('posetest.js')) {
  const { readFileSync } = await import('node:fs');
  const { ControlRig } = await import('../src/rig.js');
  const { SomaRig, MotionDB } = await import('../src/motiondb.js');
  const { SomaToManny } = await import('../src/retarget.js');
  const { RigFitter } = await import('../src/fit.js');
  const { Naturalizer } = await import('../src/natural.js');
  const { Physical } = await import('../src/physical.js');
  const read = p => readFileSync(new URL(p, import.meta.url));
  const rig = new ControlRig(JSON.parse(read('../assets/rig.json')));
  const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
  const bin = read('../assets/motiondb.bin');
  const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const re = new SomaToManny(rig, soma, JSON.parse(read('../assets/retarget_cal.json')).joints), fitter = new RigFitter(rig), physical = new Physical(rig);
  const nat = new Naturalizer(rig, db, re, fitter, physical);
  const start = rig.vectorFromValues(JSON.parse(read('../assets/start_pose.json')).values);
  const names = process.argv.slice(2);
  console.log(table(runCases({ rig, nat, db, re, fitter, physical, start }, names.length ? names : undefined)));
}
