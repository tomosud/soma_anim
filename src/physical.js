// What a body cannot hold is put right: feet under the floor, a leg or an arm asked to reach farther than it is
// long, and the weight outside of what stands on the floor (the hips shift until the body is over its feet).
// Pinned controls are not moved, except that nothing is left under the floor.
import * as M from './m4.js';

// share of the body weight and where along the segment its centre is: [from, to, share, at]
const MASS = [['pelvis', 'neck_01', 0.50, 0.45], ['neck_01', 'head', 0.08, 1.2]];
for (const s of 'lr') {
  MASS.push(['upperarm_' + s, 'lowerarm_' + s, 0.027, 0.45], ['lowerarm_' + s, 'hand_' + s, 0.016, 0.45], ['hand_' + s, 'middle_01_' + s, 0.006, 0.5],
    ['thigh_' + s, 'calf_' + s, 0.10, 0.43], ['calf_' + s, 'foot_' + s, 0.046, 0.43], ['foot_' + s, 'ball_' + s, 0.014, 0.5]);
}

/** Convex hull of points [x, z] (counter-clockwise). */
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** From point c to the nearest point of a convex polygon drawn in by `inset` ([0,0] when c is inside). */
function intoHull(c, poly, inset) {
  if (!poly.length) return [0, 0];
  // (drawn in toward its middle)
  const mid = [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
  const P = poly.map(p => { const d = Math.hypot(p[0] - mid[0], p[1] - mid[1]), k = d > 1e-6 ? Math.max(0, d - inset) / d : 0; return [mid[0] + (p[0] - mid[0]) * k, mid[1] + (p[1] - mid[1]) * k]; });
  if (P.length === 1) return [P[0][0] - c[0], P[0][1] - c[1]];
  let inside = P.length > 2, best = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], ex = b[0] - a[0], ez = b[1] - a[1], l = ex * ex + ez * ez;
    if (P.length > 2 && ex * (c[1] - a[1]) - ez * (c[0] - a[0]) < 0) inside = false;
    const t = l ? Math.max(0, Math.min(1, ((c[0] - a[0]) * ex + (c[1] - a[1]) * ez) / l)) : 0;
    const d = [a[0] + ex * t - c[0], a[1] + ez * t - c[1]];
    if (!best || Math.hypot(d[0], d[1]) < Math.hypot(best[0], best[1])) best = d;
  }
  return inside ? [0, 0] : best;
}

export class Physical {
  constructor(rig) {
    this.rig = rig;
    const rest = n => rig.joints[rig.jointIndex.get(n)].rest[13];
    this.floor = { foot_l: rest('foot_l'), foot_r: rest('foot_r'), ball_l: rest('ball_l'), ball_r: rest('ball_r') };
    const reach = start => { const ik = rig.iks.find(k => k.start.name === start); return ik.la + ik.lb; };
    this.leg = { l: reach('drv_thigh_l'), r: reach('drv_thigh_r') };
    this.arm = { l: reach('drv_upperarm_l'), r: reach('drv_upperarm_r') };
  }

  _p(n) { return M.pos(this.rig.jointWorld(n)); }

  /** Move a control by a world offset (its translate channels). */
  _move(name, d) {
    // (added to the channel values, so that two moves without an evaluation in between both count)
    const rig = this.rig, n = rig.node(name), t = M.xdir(d, M.inv(n.parent.world));
    for (const ch of n.control.channels) if (ch[0] === 't') rig.set(name + '.' + ch, rig.get(name + '.' + ch) + t['xyz'.indexOf(ch[1])]);
  }

  /** Centre of mass of the pose the rig is in. */
  com() {
    const c = [0, 0, 0];
    let m = 0;
    for (const [a, b, share, at] of MASS) { const p = M.lerp(this._p(a), this._p(b), at); c[0] += p[0] * share; c[1] += p[1] * share; c[2] += p[2] * share; m += share; }
    return [c[0] / m, c[1] / m, c[2] / m];
  }

  /** What stands on the floor, as points [x, z]: the soles of the feet that are down, and hands on the floor. */
  support() {
    const pts = [];
    for (const s of 'lr') {
      const f = this._p('foot_' + s), b = this._p('ball_' + s);
      const ankle = f[1] - this.floor['foot_' + s] < 5, toe = b[1] - this.floor['ball_' + s] < 3;
      if (!ankle && !toe) continue;
      const d = M.norm([b[0] - f[0], 0, b[2] - f[2]], [0, 0, 1]), side = [d[2], 0, -d[0]];
      const add = (p, along, w) => { for (const k of [-w, w]) pts.push([p[0] + d[0] * along + side[0] * k, p[2] + d[2] * along + side[2] * k]); };
      if (ankle) add(f, -5, 4);
      if (toe) add(b, 6, 4.5); else add(f, 4, 4);
      if (ankle && toe) add(b, 0, 4.5);
    }
    for (const s of 'lr') { const h = this._p('hand_' + s); if (h[1] < 12) pts.push([h[0], h[2]]); }
    return pts;
  }

  /** How far the centre of mass is outside of the support (cm; 0 = balanced, -1 = nothing stands on the floor). */
  offBalance() {
    const pts = this.support();
    if (!pts.length) return -1;
    const c = this.com(), d = intoHull([c[0], c[2]], hull(pts), 0);
    return Math.hypot(d[0], d[1]);
  }

  /**
   * v: pose vector, pins: Set of control names, touched: the controls just edited (never moved; an older pin
   * gives way when a limb cannot reach).  Returns {vector, notes}.
   */
  fix(v, pins = new Set(), touched = [], allow = 0) {
    const rig = this.rig, notes = [];
    rig.setVector(v).evaluate();
    const free = c => !pins.has(c);
    const mine = new Set(touched);
    /** The hips, and the chest with them (it is its own control in the world). */
    const hips = (d, share = 1) => { this._move('Hip_trans', d); if (free('Spine_trans')) this._move('Spine_trans', M.scl(d, share)); };
    let shifted = 0, lowered = 0, lifted = 0, leaned = 0, pulled = 0, chest = 0;
    // In the order of what gives way first: a hand out of reach (the body leans to it, as far as a body leans),
    // then balance, then what cannot be otherwise - a leg is only so long, and nothing goes under the floor.
    const arms = () => {
      let any = false;
      for (let i = 0; i < 4; i++) {
        let moved = false;
        for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
          const sh = this._p('upperarm_' + s), at = M.pos(rig.controlWorld(S + '_Hand_trans')), d = M.dist(sh, at), over = d - this.arm[s] * 0.99;
          if (over <= 0.05) continue;
          const step = M.scl(M.sub(at, sh), over / d);
          let did = false;
          if (free('Spine_trans') && chest < 38) { this._move('Spine_trans', M.scl(step, 0.8)); chest += over * 0.8; did = true; }
          // (a hand that is low: the hips come down to it)
          if (free('Hip_trans') && step[1] < -0.5 && sunk < 38) { hips([0, step[1] * 0.45, 0]); sunk -= step[1] * 0.45; did = true; }
          if (did) { leaned = Math.max(leaned, over); moved = true; rig.evaluate(); }
        }
        if (!moved) break;
        any = true;
      }
      return any;
    };
    const balance = () => {
      let any = false;
      for (let i = 0; i < 6; i++) {
        const pts = this.support();
        if (!pts.length) break;
        const c = this.com(), d = intoHull([c[0], c[2]], hull(pts), 2);
        const l = Math.hypot(d[0], d[1]);
        if (l < 0.3 + allow || shifted > 60) break;
        // Hips that were just put there: the chest leans the other way first, as far as that goes; after
        // that the hips give way too (a body does not stand with its weight outside of its feet).
        const who = !free('Hip_trans') && free('Spine_trans') && counter < 15 ? 'Spine_trans' : 'Hip_trans';
        // (as far as it is off, less what it was off before; the hips and chest carry most of the weight)
        const k = (who === 'Hip_trans' ? 1.15 : 2.2) * (l - allow) / l;
        // (a body that leans to reach something keeps its chest there and takes the hips back)
        if (who === 'Hip_trans') hips([d[0] * k, 0, d[1] * k], chest > 2 ? 0.3 : 1); else { this._move(who, [d[0] * k, 0, d[1] * k]); counter += l * k; }
        shifted += l * k; any = true;
        rig.evaluate();
      }
      return any;
    };
    // (hips that were just put there stay: then the foot comes in along the floor)
    const legs = () => {
      let any = false;
      for (let i = 0; i < 10; i++) {
        let moved = false;
        for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
          const hip = this._p('thigh_' + s), at = M.pos(rig.controlWorld(S + '_Foot_trans')), d = M.dist(hip, at), reach = this.leg[s] * 0.995, over = d - reach;
          if (over <= 0.05) continue;
          // (the hips go toward the foot along the floor before they go down: a wide stance is stood in
          //  between the feet, not squatted over one of them)
          if (!mine.has('Hip_trans') || pins.has(S + '_Foot_trans')) {
            const dir = M.sub(at, hip), h = Math.hypot(dir[0], dir[2]);
            const step = h > 8 && !mine.has('Hip_trans') ? M.norm([dir[0], dir[1] * 0.3, dir[2]]) : M.norm(dir);
            hips(M.scl(step, over * 1.05)); lowered += over; moved = true;
          } else if (!mine.has(S + '_Foot_trans')) {
            const dy = hip[1] - at[1], h = Math.hypot(at[0] - hip[0], at[2] - hip[2]);
            if (Math.abs(dy) >= reach || h < 1e-3) this._move(S + '_Foot_trans', [0, (dy - Math.sign(dy) * reach * 0.98), 0]);
            else { const k = (h - Math.sqrt(reach * reach - dy * dy)) / h; this._move(S + '_Foot_trans', [(hip[0] - at[0]) * k, 0, (hip[2] - at[2]) * k]); }
            pulled += over; moved = true;
          }
          if (moved) rig.evaluate();
        }
        if (!moved) break;
        any = true;
      }
      return any;
    };
    const ground = () => {
      let any = false;
      for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
        const lift = Math.min(this._p('foot_' + s)[1] - this.floor['foot_' + s], this._p('ball_' + s)[1] - this.floor['ball_' + s]);
        if (lift < -0.05) { this._move(S + '_Foot_trans', [0, -lift, 0]); lifted = Math.max(lifted, -lift); any = true; rig.evaluate(); }
      }
      return any;
    };
    let sunk = 0, counter = 0;
    for (let round = 0; round < 5; round++) {
      // (the floor first: a foot pushed under it is lifted, not answered by lowering the hips)
      const g = ground(), a = round < 2 && arms(), b = balance(), c = legs(), d = ground();
      if (!g && !a && !b && !c && !d) break;
    }
    if (lifted > 1) notes.push('足を床の上へ ' + lifted.toFixed(0) + ' cm');
    if (lowered > 2) notes.push('脚が届くように腰を ' + lowered.toFixed(0) + ' cm');
    if (pulled > 2) notes.push('脚が届くように足を ' + pulled.toFixed(0) + ' cm');
    if (leaned > 2) notes.push('手が届くように体を ' + leaned.toFixed(0) + ' cm');
    if (shifted > 2) notes.push('バランスを取るため重心を ' + shifted.toFixed(0) + ' cm');
    return { vector: rig.getVector(), notes };
  }
}
