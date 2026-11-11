// Natural posing.
//
// What an animator expects when one control is moved:
//   * the control stays exactly where it was put, and so does everything placed by hand before (the pins);
//   * the rest of the body comes along as a body does - lower the hips and the chest, head and arms come down
//     with them (on this rig every control sits in the world, so left alone they would stay behind);
//   * the parts next to the edit settle into something a person would do (shoulder, spine, a shift of the hips),
//     taken from the nearest pose of the reference motion, while parts that have nothing to do with it - the
//     other hand - are left as they are;
//   * what a body cannot hold is put right (src/physical.js: balance, reach, the floor).
//
// The work is done on the skeleton (local joint rotations of the SOMA pose), then put back on the rig, and only
// the controls whose part of the body actually changed are rewritten.
import * as M from './m4.js';
import { DIM, F_FEET, F_HIPS_H, F_HANDS, F_HEAD, qmul, qinv } from './motiondb.js';
import { queryFromRig } from './retarget.js';
import { BODY_FIT_CONTROLS } from './fit.js';

/** Which feature dimensions a pinned control speaks for. */
const PIN_DIMS = {
  L_Foot_trans: [F_FEET, 3], R_Foot_trans: [F_FEET + 3, 3], L_Foot_rot: [F_FEET, 3], R_Foot_rot: [F_FEET + 3, 3],
  L_Hand_trans: [F_HANDS, 3], R_Hand_trans: [F_HANDS + 3, 3], L_Hand_rot: [F_HANDS, 3], R_Hand_rot: [F_HANDS + 3, 3],
  Hip_trans: [F_HIPS_H, 1], Head_trans: [F_HEAD, 3], Head_rot: [F_HEAD, 3],
};
const BASE = [[F_FEET, 6, 1], [F_HIPS_H, 1, 2], [F_HANDS, 6, 1], [F_HEAD, 3, 1.5]];

export function poseWeights(pins, pinned = 3) {
  const w = new Float32Array(DIM);
  for (const [o, n, v] of BASE) for (let i = 0; i < n; i++) w[o + i] = v;
  for (const p of pins) { const d = PIN_DIMS[p]; if (d) for (let i = 0; i < d[1]; i++) w[d[0] + i] = pinned; }
  return w;
}

// --- the body in parts -----------------------------------------------------------------------------------
// part -> SOMA joints, and per joint the controls that hold it (a joint held by a pinned control keeps the
// rotation it has; the others follow their parent)
const PARTS = { hips: ['Hips'], spine: ['Spine1', 'Spine2', 'Chest'], head: ['Neck1', 'Neck2', 'Head'] };
const HOLD = { Spine1: ['Spine_trans', 'Spine_rot'], Spine2: ['Spine_trans', 'Spine_rot'], Chest: ['Spine_trans', 'Spine_rot'], Neck1: ['Neck_rot', 'Head_trans', 'Head_rot'], Neck2: ['Neck_rot', 'Head_trans', 'Head_rot'], Head: ['Head_trans', 'Head_rot'] };
const GROUP = { Hip_trans: 'root', Hip2_rot: 'hips', Spine_trans: 'spine', Spine_rot: 'spine', Neck_rot: 'head', Head_rot: 'head', Head_trans: 'head' };
// part -> Manny joints that show whether the part moved, and the controls that are rewritten when it did
const SHOWS = { root: ['pelvis'], hips: ['thigh_l', 'thigh_r', 'spine_01'], spine: ['spine_03', 'spine_05', 'neck_01'], head: ['head'] };
const CONTROLS = { root: ['Hip_trans'], hips: ['Hip2_rot'], spine: ['Spine_trans', 'Spine_rot'], head: ['Neck_rot', 'Head_rot', 'Head_trans'] };
for (const [S, s, W] of [['L', 'l', 'Left'], ['R', 'r', 'Right']]) {
  PARTS['arm' + S] = [W + 'Shoulder', W + 'Arm', W + 'ForeArm', W + 'Hand'];
  PARTS['leg' + S] = [W + 'Leg', W + 'Shin', W + 'Foot', W + 'ToeBase'];
  Object.assign(HOLD, {
    [W + 'Shoulder']: [S + '_Shoulder_rot'], [W + 'Arm']: [S + '_Hand_trans', S + '_elbow_pv'], [W + 'ForeArm']: [S + '_Hand_trans', S + '_elbow_pv'], [W + 'Hand']: [S + '_Hand_rot'],
    [W + 'Leg']: [S + '_Foot_trans', S + '_knee_pv'], [W + 'Shin']: [S + '_Foot_trans', S + '_knee_pv'], [W + 'Foot']: [S + '_Foot_rot'], [W + 'ToeBase']: [S + '_Toe_rot', S + '_Foot_rot'],
  });
  for (const c of ['_Shoulder_rot', '_elbow_pv', '_Hand_trans', '_Hand_rot']) GROUP[S + c] = 'arm' + S;
  for (const c of ['_knee_pv', '_Foot_trans', '_Foot_rot', '_Toe_rot']) GROUP[S + c] = 'leg' + S;
  SHOWS['arm' + S] = ['clavicle_' + s, 'upperarm_' + s, 'lowerarm_' + s, 'hand_' + s, 'middle_01_' + s];
  SHOWS['leg' + S] = ['calf_' + s, 'foot_' + s, 'ball_' + s];
  CONTROLS['arm' + S] = [S + '_Shoulder_rot', S + '_elbow_pv', S + '_Hand_trans', S + '_Hand_rot'];
  CONTROLS['leg' + S] = [S + '_knee_pv', S + '_Foot_trans', S + '_Foot_rot', S + '_Toe_rot'];
}

/**
 * How far the reference pose is let into each part of the body when a part is edited (1 = fully).
 * `same` is the edited limb itself, `other` the limb of the same kind on the other side.
 */
const REACH = {
  arm: { same: 1, spine: 0.7, head: 0.3, hips: 0.4, root: 0.4, other: 0.1, legs: 0.25 },
  leg: { same: 1, root: 0.8, hips: 0.7, spine: 0.6, head: 0.3, arms: 0.3, other: 0.4 },
  root: { hips: 0.5, spine: 0.5, head: 0.3, arms: 0.3, legs: 1 },
  hips: { root: 0.2, spine: 0.5, head: 0.3, arms: 0.2, legs: 1 },
  spine: { root: 0.3, hips: 0.3, head: 0.5, arms: 0.4, legs: 0.2 },
  head: { spine: 0.4, hips: 0.05, arms: 0.05 },
};
const ALL_PARTS = ['root', 'hips', 'spine', 'head', 'armL', 'armR', 'legL', 'legR'];

/** part -> 0..1 for the controls that were just edited (null = the whole body). */
export function influence(touched) {
  const w = Object.fromEntries(ALL_PARTS.map(p => [p, touched ? 0 : 1]));
  for (const c of touched || []) {
    const g = GROUP[c];
    if (!g) continue;
    const kind = g.startsWith("arm") ? "arm" : g.startsWith("leg") ? "leg" : g, r = REACH[kind];
    for (const p of ALL_PARTS) {
      let x = r[p] ?? 0;
      if (p.startsWith('arm')) x = kind === 'arm' ? (p === g ? r.same : r.other) : r.arms ?? 0;
      if (p.startsWith('leg')) x = kind === 'leg' ? (p === g ? r.same : r.other) : r.legs ?? 0;
      if (p === g) x = 1;
      w[p] = Math.max(w[p], x);
    }
  }
  return w;
}

export class Naturalizer {
  constructor(rig, db, re, fitter, physical = null) {
    this.rig = rig; this.db = db; this.re = re; this.fitter = fitter; this.physical = physical;
    this.body = new Set(BODY_FIT_CONTROLS);
    // falls, hits and getting up are not what anyone means when placing a hand: never offered as natural
    this.skip = db.tagged(['fall', 'getup', 'hit']);
    const soma = db.rig;
    this.jointPart = new Array(soma.n).fill(null);
    for (const [p, names] of Object.entries(PARTS)) for (const n of names) this.jointPart[soma.index[n]] = p;
    this.jointHold = soma.names.map(n => HOLD[n] || null);
    this.channelsOf = name => rig.controlByName.get(name).channels.map(ch => rig.channelIndex.get(name + '.' + ch));
  }

  _local(pose) {
    const soma = this.db.rig, out = [];
    for (let j = 0; j < soma.n; j++) { const q = soma.rot(pose, j); out.push(soma.parents[j] < 0 ? q : qmul(qinv(soma.rot(pose, soma.parents[j])), q)); }
    return out;
  }

  _world(root, local) {
    const soma = this.db.rig, q = new Float32Array(soma.n * 4), pose = { root, q };
    for (let j = 0; j < soma.n; j++) q.set(soma.parents[j] < 0 ? local[j] : qmul(soma.rot(pose, soma.parents[j]), local[j]), j * 4);
    return pose;
  }

  /** Put a SOMA pose on the rig, with the pinned controls back where v has them.  Returns the vector. */
  _apply(pose, v, pins) {
    const { rig } = this;
    rig.setVector(v);
    this.fitter.fit(this.re.targets(pose));
    for (const name of pins) if (rig.controlByName.has(name)) for (const i of this.channelsOf(name)) rig.set(rig.channelKeys[i], v[i]);
    rig.evaluate();
    return rig.getVector();
  }

  /**
   * The pose with the body brought along: every joint that no pinned control holds keeps the rotation it had
   * in `before` relative to its parent, under the hips of v.  (No reference motion: this is what a drag shows.)
   */
  follow(v, pins, before) {
    const { rig, re } = this;
    rig.setVector(v).evaluate(); const Sv = re.fromRig(rig);
    rig.setVector(before).evaluate(); const Sb = re.fromRig(rig);
    const Lv = this._local(Sv), Lb = this._local(Sb);
    const soma = this.db.rig, holds = j => (this.jointHold[j] || []).some(c => pins.has(c));
    const local = Lv.map((l, j) => (j === 0 || holds(j) ? l : Lb[j]));
    const pose = this._world(Sv.root, local);
    // Arms hang and a head stays level: when the chest tips over, they turn with it about the vertical only,
    // and take a part of the tilt (carried rigidly, an arm at the side would stick out like a rod).
    const chest = soma.index.Chest;
    const turn = qmul(soma.rot(pose, chest), qinv(soma.rot(Sb, chest)));
    const tw = Math.hypot(turn[1], turn[3]), about = tw < 1e-9 ? [0, 0, 0, 1] : [0, turn[1] / tw, 0, turn[3] / tw];
    const ease = (j, share) => {
      if (holds(j)) return;
      const q = M.qslerp(qmul(about, soma.rot(Sb, j)), soma.rot(pose, j), share);
      local[j] = qmul(qinv(soma.rot(pose, soma.parents[j])), q);
    };
    ease(soma.index.LeftArm, 0.3); ease(soma.index.RightArm, 0.3); ease(soma.index.Neck1, 0.5);
    const want = this._world(Sv.root, local);
    return this._settle(this._apply(want, v, pins), v, want, Sv);
  }

  /**
   * Keep v's own numbers for every part of the body that was not asked to move: `want` is the pose that was put
   * on the rig, `had` the pose v had (both SOMA).  Decided on the skeleton, so that what the fit cannot reproduce
   * exactly (the spine) does not creep a little with every edit.
   */
  _settle(out, v, want, had, tol = 0.003) {
    const { rig } = this, soma = this.db.rig;
    const P0 = soma.positions(had), P1 = soma.positions(want), res = out.slice();
    const d = j => Math.hypot(P0[j][0] - P1[j][0], P0[j][1] - P1[j][1], P0[j][2] - P1[j][2]);
    for (const part of ALL_PARTS) {
      let moved = false;
      if (part === 'root') moved = d(0) > tol;
      else for (let j = 0; j < soma.n; j++) if ((this.jointPart[j] === part || this.jointPart[soma.parents[j]] === part) && d(j) > tol) moved = true;
      if (part === 'hips' && !moved) { const a = soma.rot(had, 0), b = soma.rot(want, 0); moved = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) < 0.99999; }
      if (moved) continue;
      for (const c of CONTROLS[part]) for (const i of this.channelsOf(c)) res[i] = v[i];
    }
    rig.setVector(res).evaluate();
    return res;
  }

  /**
   * v: pose vector, pins: Set of the controls the animator placed by hand (their part of the body is never
   * re-posed), strength 0..1.
   * opts.before: the pose before the edit (the body follows from it); opts.touched: the controls just edited
   * (the reference pose is let in around them; null = the whole body); opts.held: the controls that stay where
   * they are in the world while the body moves (the edited ones and the feet; default: all the pins - a hand
   * placed earlier and not held comes along with the body like any other); opts.balance: put right what a
   * body cannot hold.  Returns {vector, match, notes}.
   */
  naturalize(v, pins, strength = 1, { before = null, touched = null, held = null, balance = true } = {}) {
    const { rig, db, re } = this, soma = db.rig;
    const placed = pins;
    pins = held ?? pins;
    const W = influence(touched);
    for (const p of ALL_PARTS) if (CONTROLS[p].some(c => placed.has(c) && !pins.has(c))) W[p] = 0;
    let base = before ? this.follow(v, pins, before) : v.slice();
    let match = null;
    if (strength > 0 && ALL_PARTS.some(p => W[p] > 0)) {
      rig.setVector(base).evaluate();
      const S0 = re.fromRig(rig), L0 = this._local(S0);
      const { q, hip, heading } = queryFromRig(rig, re);
      const hits = db.nearest(q, poseWeights(new Set([...placed, ...pins])), 12, this.skip);
      // among the poses that agree with the handles: the one that asks for the least change of the whole body
      let best = null;
      for (const hit of hits) {
        const pose = db.pose(hit.clip, hit.frame, hit.mirrored);
        const placed = soma.place(pose, heading - soma.heading(soma.positions(pose)), hip[0], hip[2]);
        const L = this._local(placed);
        let change = 0, n = 0;
        for (let j = 1; j < soma.n; j++) if (this.jointPart[j]) { const d = Math.abs(L0[j][0] * L[j][0] + L0[j][1] * L[j][1] + L0[j][2] * L[j][2] + L0[j][3] * L[j][3]); change += 2 * Math.acos(Math.min(1, d)); n++; }
        const score = Math.sqrt(hit.cost) + 0.12 * change / n;
        if (!best || score < best.score) best = { score, hit, placed, L };
      }
      if (best) {
        // (a reference that is far from the pose knows little about it: it is let in less)
        const trust = Math.max(0.3, Math.min(1, 1 - (Math.sqrt(best.hit.cost) - 0.3) / 0.5));
        const k = strength * trust;
        const local = L0.map((l, j) => {
          const part = this.jointPart[j];
          if (!part) return l;
          return M.qslerp(l, best.L[j], Math.min(1, W[part] * k));
        });
        const root = S0.root.slice();
        if (!pins.has('Hip_trans')) root[1] += (best.placed.root[1] - root[1]) * Math.min(1, W.root * k);
        const want = this._world(root, local);
        base = this._settle(this._apply(want, base, pins), base, want, S0);
        match = { clip: db.clips[best.hit.clip].name, frame: best.hit.frame, mirrored: best.hit.mirrored, cost: best.hit.cost };
      }
    }
    let notes = [];
    if (balance && this.physical) {
      // (a pose that was off balance before the edit - a body in mid stride - is not what is being put right)
      let allow = 0;
      if (before) { rig.setVector(before).evaluate(); allow = Math.max(0, this.physical.offBalance()); }
      const r = this.physical.fix(base, pins, touched || [], allow);
      notes = r.notes;
      // (what the hips and the chest carry comes along with them)
      if (notes.length) base = this.follow(r.vector, new Set([...pins, 'Hip_trans', 'Spine_trans', 'Spine_rot', 'L_Foot_trans', 'R_Foot_trans']), base);
    }
    rig.setVector(base).evaluate();
    return { vector: base, match, notes };
  }
}

export const wrap = a => a - 360 * Math.round(a / 360);
