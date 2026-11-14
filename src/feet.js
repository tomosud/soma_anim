// "Reset the feet": both feet flat on the floor where they are, pointing the way they point, the knees over
// the toes, and the hips lowered if a leg would not reach.  For key poses whose feet float, sink or are twisted.
import * as M from './m4.js';

const horiz = v => [v[0], 0, v[2]];

export class FootReset {
  constructor(rig) {
    this.rig = rig;
    const rest = n => rig.joints[rig.jointIndex.get(n)].rest;
    this.sides = [['L', 'l'], ['R', 'r']].map(([S, s]) => {
      const ik = rig.iks.find(k => k.start.name.endsWith('thigh_' + s));
      return {
        S, s, reach: (ik.la + ik.lb) * 0.985,
        footY: rest('foot_' + s)[13],
        dir: M.norm(horiz(M.sub(M.pos(rest('ball_' + s)), M.pos(rest('foot_' + s)))), [0, 0, 1]),
        rotRest: M.rotation(rig.node(S + '_Foot_rot').restWorld),
      };
    });
    this.pv = 50 * rig.scale;
  }

  _set(name, ch, v) { this.rig.set(name + '.' + ch, v); }

  _pos(name, world) {
    const n = this.rig.node(name), t = M.sub(M.xpoint(world, M.inv(n.parent.world)), n.restT);
    for (const ch of n.control.channels) if (ch[0] === 't') this._set(name, ch, t['xyz'.indexOf(ch[1])]);
  }

  /** v: pose vector.  Returns the pose with the feet reset. */
  apply(v) {
    const rig = this.rig;
    rig.setVector(v).evaluate();
    const feet = this.sides.map(side => {
      const f = M.pos(rig.jointWorld('foot_' + side.s)), b = M.pos(rig.jointWorld('ball_' + side.s));
      // which way the foot points on the floor (a foot pointing straight up or down keeps the rest direction)
      const d = horiz(M.sub(b, f));
      const dir = M.len(d) > 3 ? M.norm(d) : side.dir;
      const yaw = Math.atan2(dir[0], dir[2]) - Math.atan2(side.dir[0], side.dir[2]);
      return { side, at: [f[0], side.footY, f[2]], dir, yaw };
    });
    for (const { side, at, yaw } of feet) {
      this._pos(side.S + '_Foot_trans', at);
      // flat: the rest orientation, turned about the vertical
      const n = rig.node(side.S + '_Foot_rot');
      const world = M.mul(side.rotRest, M.rotAxis(1, yaw / M.DEG));
      const e = M.toEuler(M.mul(world, M.transpose3(M.rotation(n.parent.world))), n.order);
      for (const ch of ['rx', 'ry', 'rz']) this._set(side.S + '_Foot_rot', ch, e['xyz'.indexOf(ch[1])]);
      this._set(side.S + '_Toe_rot', 'rz', 0);
    }
    rig.evaluate();
    // a leg that would be stretched straight (or not reach): the hips come down until both reach
    let drop = 0;
    for (const { side, at } of feet) {
      const hip = M.pos(rig.jointWorld('thigh_' + side.s));
      const h = Math.hypot(hip[0] - at[0], hip[2] - at[2]);
      if (M.dist(hip, at) > side.reach && h < side.reach) drop = Math.max(drop, hip[1] - (at[1] + Math.sqrt(side.reach * side.reach - h * h)));
    }
    if (drop > 0) {
      const p = M.pos(rig.controlWorld('Hip_trans'));
      this._pos('Hip_trans', [p[0], p[1] - drop, p[2]]);
      rig.evaluate();
    }
    // knees over the toes
    for (const { side, at, dir } of feet) {
      const hip = M.pos(rig.jointWorld('thigh_' + side.s));
      const axis = M.norm(M.sub(at, hip), [0, -1, 0]);
      const pole = M.norm(M.ortho(dir, axis), dir);
      this._pos(side.S + '_knee_pv', M.add(M.lerp(hip, at, 0.5), M.scl(pole, this.pv)));
    }
    rig.evaluate();
    return rig.getVector();
  }
}

export const FOOT_CONTROLS = ['L_Foot_trans', 'R_Foot_trans', 'L_Foot_rot', 'R_Foot_rot', 'L_Toe_rot', 'R_Toe_rot', 'L_knee_pv', 'R_knee_pv'];
