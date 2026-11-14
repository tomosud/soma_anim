// How far the joints of a person turn, and poses kept inside that.
//
// For a joint, its turn from the rest pose relative to its parent is split into the twist about the bone and the
// swing of the bone (two angles, about two axes square to the bone).  assets/limits.json holds the range of each
// of the three over the reference motion (tools/make_limits.mjs) - what people do.  A pose outside is brought back:
//  * the wrists and ankles: the hand or the foot is turned back into range (Hand_rot / Foot_rot);
//  * the shoulders, elbows, hips and knees: the hand or the foot stays where it is, and the elbow or the knee is
//    swung about the line from the shoulder (hip) to the hand (foot) - the pole vector - to where the arm or the
//    leg is most inside its range.  (A straight arm whose elbow points the wrong way has its whole arm turned over:
//    the wrist then looks twisted half a turn.)
import * as M from './m4.js';
import { twistAbout } from './fit.js';

const DEG = 180 / Math.PI;
export const LIMIT_JOINTS = [];
for (const s of 'lr') {
  LIMIT_JOINTS.push(
    { name: 'hand_' + s, parent: 'lowerarm_' + s, tip: 'middle_01_' + s },
    { name: 'lowerarm_' + s, parent: 'upperarm_' + s, tip: 'hand_' + s },
    { name: 'upperarm_' + s, parent: 'clavicle_' + s, tip: 'lowerarm_' + s },
    { name: 'foot_' + s, parent: 'calf_' + s, tip: 'ball_' + s },
    { name: 'calf_' + s, parent: 'thigh_' + s, tip: 'foot_' + s },
    { name: 'thigh_' + s, parent: 'pelvis', tip: 'calf_' + s },
  );
}
LIMIT_JOINTS.push({ name: 'head', parent: 'neck_02', tip: null }, { name: 'neck_01', parent: 'spine_05', tip: 'neck_02' });

const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = q => [-q[0], -q[1], -q[2], q[3]];
// (degrees a joint may turn in one frame before it is a flip: a fast wrist in a strike turns about 25)
const SNAP = 35;
const frames = new Map();

/** The bone axis and two axes square to it, in the frame of the joint at rest; the rest turn relative to the parent. */
function frameOf(j, rest) {
  let f = frames.get(j.name);
  if (f) return f;
  const Rc = M.rotation(rest[j.name]), Rp = M.rotation(rest[j.parent]);
  const dir = j.tip ? M.sub(M.pos(rest[j.tip]), M.pos(rest[j.name])) : M.sub(M.pos(rest[j.name]), M.pos(rest[j.parent]));
  const a = M.norm(M.xdir(dir, M.transpose3(Rc)));
  const u = M.norm(M.cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1])), v = M.cross(a, u);
  f = { a, u, v, L0: M.mul(Rc, M.transpose3(Rp)) };
  frames.set(j.name, f);
  return f;
}

/** {twist, u, v} in degrees: the turn of joint j (world matrix Wc) from rest, relative to its parent (Wp). */
export function jointTurn(j, Wc, Wp, rest) {
  const { a, u, v, L0 } = frameOf(j, rest);
  const L = M.mul(M.rotation(Wc), M.transpose3(M.rotation(Wp)));
  let q = M.toQuat(M.mul(L, M.transpose3(L0)));
  if (q[3] < 0) q = q.map(x => -x);
  const s = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
  const tl = Math.hypot(s, q[3]) || 1, tw = [a[0] * s / tl, a[1] * s / tl, a[2] * s / tl, q[3] / tl];
  const sw = qmul(q, qinv(tw)), sl = Math.hypot(sw[0], sw[1], sw[2]), ang = 2 * Math.atan2(sl, sw[3]);
  const k = sl < 1e-9 ? 0 : ang / sl;
  return { twist: 2 * Math.atan2(s, q[3]) * DEG, u: (sw[0] * u[0] + sw[1] * u[1] + sw[2] * u[2]) * k * DEG, v: (sw[0] * v[0] + sw[1] * v[1] + sw[2] * v[2]) * k * DEG };
}

/** World rotation (3x3 in a 16) of joint j with the turn {twist, u, v} under the parent at Wp. */
function worldOf(j, t, Wp, rest) {
  const { a, u, v, L0 } = frameOf(j, rest);
  const half = x => x / DEG / 2;
  const tw = [a[0] * Math.sin(half(t.twist)), a[1] * Math.sin(half(t.twist)), a[2] * Math.sin(half(t.twist)), Math.cos(half(t.twist))];
  const r = [u[0] * t.u + v[0] * t.v, u[1] * t.u + v[1] * t.v, u[2] * t.u + v[2] * t.v], ang = Math.hypot(...r);
  const sw = ang < 1e-9 ? [0, 0, 0, 1] : [r[0] / ang * Math.sin(half(ang)), r[1] / ang * Math.sin(half(ang)), r[2] / ang * Math.sin(half(ang)), Math.cos(half(ang))];
  return M.mul(M.mul(M.fromQuat(qmul(sw, tw)), L0), M.rotation(Wp));
}

/** How far out of range (degrees, 0 = inside). */
function outside(t, r) {
  let d = 0;
  for (const k of ['twist', 'u', 'v']) d += Math.max(0, r[k][0] - t[k], t[k] - r[k][1]);
  return d;
}
// (a twist past one end may be nearer the other end the other way round: 155 is 46 past -159 as -205)
function clampTwist(x, [lo, hi]) {
  if (x >= lo && x <= hi) return x;
  const past = x > hi ? x - hi : lo - x, round = x > hi ? lo - (x - 360) : x + 360 - hi;
  return past <= round ? (x > hi ? hi : lo) : (x > hi ? lo : hi);
}
const clampTurn = (t, r) => ({ twist: clampTwist(t.twist, r.twist), u: Math.max(r.u[0], Math.min(r.u[1], t.u)), v: Math.max(r.v[0], Math.min(r.v[1], t.v)) });

export class Limits {
  /** data: assets/limits.json; fitter: the RigFitter (its control <-> joint turns). */
  constructor(rig, fitter, data) {
    this.rig = rig; this.fitter = fitter; this.range = data.joints;
    this.rest = Object.fromEntries(rig.joints.map(j => [j.name, j.rest]));
    this.byName = Object.fromEntries(LIMIT_JOINTS.map(j => [j.name, j]));
    this.limbs = [];
    for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
      this.limbs.push({ pv: S + '_elbow_pv', root: 'upperarm_' + s, mid: 'lowerarm_' + s, end: 'hand_' + s, joints: ['upperarm_' + s, 'lowerarm_' + s] });
      this.limbs.push({ pv: S + '_knee_pv', root: 'thigh_' + s, mid: 'calf_' + s, end: 'foot_' + s, joints: ['thigh_' + s, 'calf_' + s] });
    }
    this.ends = [['L_Hand_rot', 'hand_l'], ['R_Hand_rot', 'hand_r'], ['L_Foot_rot', 'foot_l'], ['R_Foot_rot', 'foot_r']];
  }

  turn(name) { const j = this.byName[name]; return jointTurn(j, this.rig.jointWorld(j.name), this.rig.jointWorld(j.parent), this.rest); }
  out(name) { return outside(this.turn(name), this.range[name]); }

  /**
   * A stretch of poses (the first and the last are keys, never changed) with no sudden turns left: where a hand
   * or a foot turns faster than SNAP degrees a frame, its turn on the wrist or the ankle goes evenly from the frame
   * before to the frame after (in the joint's own angles - inside its range, never round the far side); where an
   * upper arm or a thigh does, so does the place of its elbow or knee pole about the shoulder or the hip.
   */
  smooth(frames) {
    const rig = this.rig, n = frames.length - 1;
    const turnAt = (v, name) => (rig.setVector(v).evaluate(), this.turn(name));
    const jump = (a, b) => Math.max(Math.abs(a.twist - b.twist), Math.abs(a.u - b.u), Math.abs(a.v - b.v));
    for (const limb of this.limbs) {
      const T = frames.map(v => turnAt(v, limb.root));
      for (let k = 1; k <= n; k++) {
        if (jump(T[k - 1], T[k]) <= SNAP) continue;
        const a = Math.max(0, k - 4), b = Math.min(n, k + 3);
        const off = i => (rig.setVector(frames[i]).evaluate(), M.sub(M.pos(rig.node(limb.pv).world), M.pos(rig.jointWorld(limb.root))));
        const oa = off(a), ob = off(b);
        for (let i = a + 1; i < b; i++) {
          rig.setVector(frames[i]).evaluate();
          this.fitter._pos(limb.pv, M.add(M.pos(rig.jointWorld(limb.root)), M.lerp(oa, ob, (i - a) / (b - a))));
          rig.evaluate();
          frames[i] = rig.getVector();
        }
        k = b;
      }
    }
    for (const [ctl, joint] of this.ends) {
      const j = this.byName[joint], T = frames.map(v => turnAt(v, joint));
      for (let k = 1; k <= n; k++) {
        if (jump(T[k - 1], T[k]) <= SNAP) continue;
        const a = Math.max(0, k - 4), b = Math.min(n, k + 3);
        for (let i = a + 1; i < b; i++) {
          const u = (i - a) / (b - a), t = { twist: T[a].twist + (T[b].twist - T[a].twist) * u, u: T[a].u + (T[b].u - T[a].u) * u, v: T[a].v + (T[b].v - T[a].v) * u };
          rig.setVector(frames[i]).evaluate();
          this.fitter._rot(ctl, M.mul(this.fitter.k[ctl], worldOf(j, t, rig.jointWorld(j.parent), this.rest)));
          rig.evaluate();
          frames[i] = rig.getVector();
          T[i] = t;
        }
        k = b;
      }
    }
    return frames;
  }

  /** Every joint out of its range in pose v: [{joint, by (degrees)}]. */
  check(v) {
    this.rig.setVector(v).evaluate();
    return LIMIT_JOINTS.map(j => ({ joint: j.name, by: +this.out(j.name).toFixed(1) })).filter(x => x.by > 0.5);
  }

  /**
   * Pose v brought inside the ranges (a new vector; v itself when nothing is out).  keep: controls the animator
   * placed by hand that are not to be moved (a pole vector or a hand turn of theirs is left as it is).
   */
  apply(v, keep = null) {
    const rig = this.rig;
    rig.setVector(v).evaluate();
    let changed = false;
    // the elbows and knees first (they decide where the forearm and the shin are, under the hand and the foot)
    for (const limb of this.limbs) {
      if (keep?.has(limb.pv)) continue;
      const bad = () => limb.joints.reduce((s, n) => s + this.out(n), 0);
      const now = bad();
      if (now < 0.5) continue;
      const pv = rig.node(limb.pv), t0 = M.pos(pv.world);
      const a = M.pos(rig.jointWorld(limb.root)), axis = M.norm(M.sub(M.pos(rig.jointWorld(limb.end)), a));
      const at = deg => { this.fitter._pos(limb.pv, M.add(a, M.xdir(M.sub(t0, a), M.axisAngle(axis, deg / DEG)))); rig.evaluate(); return bad(); };
      // (coarse, then fine; the smallest swing of the knee or the elbow among the best)
      let best = { deg: 0, cost: now };
      for (let d = -180; d < 180; d += 15) { const c = at(d) + Math.abs(d) * 0.002; if (c < best.cost) best = { deg: d, cost: c }; }
      for (let d = best.deg - 12; d <= best.deg + 12; d += 3) { const c = at(d) + Math.abs(d) * 0.002; if (c < best.cost) best = { deg: d, cost: c }; }
      at(best.deg);
      if (best.deg !== 0) changed = true;
    }
    // the wrists and ankles: the hand or the foot turned back into range
    for (const [ctl, joint] of this.ends) {
      if (keep?.has(ctl)) continue;
      const j = this.byName[joint], r = this.range[joint], t = this.turn(joint);
      if (outside(t, r) < 0.5) continue;
      const want = worldOf(j, clampTurn(t, r), rig.jointWorld(j.parent), this.rest);
      this.fitter._rot(ctl, M.mul(this.fitter.k[ctl], want));
      rig.evaluate();
      changed = true;
    }
    // the head: aimed and rolled back into range on the neck
    if (!keep?.has('Head_trans') && !keep?.has('Head_rot')) {
      const j = this.byName.head, t = this.turn('head');
      if (outside(t, this.range.head) >= 0.5) {
        const want = worldOf(j, clampTurn(t, this.range.head), rig.jointWorld(j.parent), this.rest);
        this.fitter._pos('Head_trans', M.add(M.pos(rig.jointWorld('head')), M.xdir(this.fitter.headAim, want)));
        rig.evaluate();
        const sight = M.norm(M.sub(M.pos(rig.controlWorld('Head_trans')), M.pos(rig.jointWorld('head'))));
        rig.set('Head_rot.rx', rig.get('Head_rot.rx') + twistAbout(M.mul(M.transpose3(M.rotation(rig.jointWorld('head'))), want), sight));
        rig.evaluate();
        changed = true;
      }
    }
    return changed ? rig.getVector() : v;
  }
}
