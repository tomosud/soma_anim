// Put a skeleton pose on the rig: world matrices of the Manny body joints -> control values.
//
// The rig has fewer freedoms than the skeleton (two spine segments, IK limbs, an aimed head), so this
// is a fit: hips, hands and feet land exactly (position and orientation), the spine, neck and head as
// close as the rig can go.  The controls are solved from the root outward, evaluating the rig in between
// because every control sits in the space of something the earlier ones move.
import * as M from './m4.js';

/** Direction from the a-c line to the middle joint b (the side the limb bends to). */
function poleDir(a, b, c, fallback) {
  const ac = M.sub(c, a), l2 = M.dot(ac, ac);
  if (l2 < 1e-6) return fallback;
  const d = M.sub(b, M.add(a, M.scl(ac, M.dot(M.sub(b, a), ac) / l2)));
  // nearly straight: the bend side is not defined by the positions
  const w = Math.min(1, M.len(d) / 2);
  const f = M.norm(M.ortho(fallback, M.norm(ac)), fallback);
  return M.norm(M.add(M.scl(M.norm(d, f), w), M.scl(f, 1 - w)), f);
}

/** Angle (degrees) of a rotation about a unit axis (its twist). */
function twistAbout(r, axis) {
  const q = M.toQuat(r);
  const a = 2 * Math.atan2(q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2], q[3]) / M.DEG;
  return a > 180 ? a - 360 : a < -180 ? a + 360 : a;
}

export const BODY_FIT_CONTROLS = ['Hip_trans', 'Hip2_rot', 'Spine_trans', 'Spine_rot', 'Neck_rot', 'Head_rot', 'Head_trans',
  ...['L', 'R'].flatMap(s => [`${s}_Shoulder_rot`, `${s}_elbow_pv`, `${s}_Hand_trans`, `${s}_Hand_rot`, `${s}_knee_pv`, `${s}_Foot_trans`, `${s}_Foot_rot`, `${s}_Toe_rot`])];

export class RigFitter {
  constructor(rig) {
    this.rig = rig;
    const restJ = n => rig.joints[rig.jointIndex.get(n)].rest;
    const restC = n => rig.node(n).restWorld;
    // control world rotation = k * joint world rotation
    this.k = {};
    const pair = (c, j) => { this.k[c] = M.mul(M.rotation(restC(c)), M.transpose3(M.rotation(restJ(j)))); };
    pair('Hip2_rot', 'pelvis'); pair('Neck_rot', 'neck_01');
    for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
      pair(S + '_Shoulder_rot', 'clavicle_' + s); pair(S + '_Hand_rot', 'hand_' + s);
      pair(S + '_Foot_rot', 'foot_' + s); pair(S + '_Toe_rot', 'ball_' + s);
    }
    const sc = rig.scale;
    this.pvArm = 30 * sc; this.pvLeg = 50 * sc;
    // where Head_trans sits, in the frame of the head joint
    this.headAim = M.xdir(M.sub(M.pos(restC('Head_trans')), M.pos(restJ('head'))), M.transpose3(M.rotation(restJ('head'))));
    // rest bend side of the limbs in the frame of the first bone (used when a limb is straight)
    this.bend = {};
    for (const s of 'lr') {
      for (const [a, b, c] of [['upperarm_', 'lowerarm_', 'hand_'], ['thigh_', 'calf_', 'foot_']]) {
        const d = poleDir(M.pos(restJ(a + s)), M.pos(restJ(b + s)), M.pos(restJ(c + s)), a === 'thigh_' ? [0, 0, 1] : [0, 0, -1]);
        this.bend[a + s] = M.xdir(d, M.transpose3(M.rotation(restJ(a + s))));
      }
    }
  }

  _pos(name, world) {
    const n = this.rig.node(name);
    const t = M.sub(M.xpoint(world, M.inv(n.parent.world)), n.restT);
    for (const ch of n.control.channels) if (ch[0] === 't') this.rig.set(name + '.' + ch, t['xyz'.indexOf(ch[1])]);
  }

  _rot(name, worldRot) {
    const n = this.rig.node(name);
    const l = M.mul(worldRot, M.transpose3(M.rotation(n.parent.world)));
    const e = M.toEuler(l, n.order);
    for (const ch of ['rx', 'ry', 'rz']) this.rig.set(name + '.' + ch, n.control.channels.includes(ch) ? e['xyz'.indexOf(ch[1])] : 0);
  }

  /**
   * T: {joint: world matrix} for pelvis, spine_05, neck_01, head, and per side clavicle, upperarm,
   * lowerarm, hand, thigh, calf, foot, ball.  Leaves the fitted values in the rig (evaluated).
   */
  fit(T) {
    const rig = this.rig, k = this.k;
    const R = n => M.rotation(T[n]), P = n => M.pos(T[n]);
    for (const c of BODY_FIT_CONTROLS) rig.node(c).value.fill(0);
    rig.evaluate(); // the parents of the controls may have moved (world_ctl)

    this._pos('Hip_trans', P('pelvis'));
    rig.evaluate();
    this._rot('Hip2_rot', M.mul(k.Hip2_rot, R('pelvis')));
    this._pos('Spine_trans', P('neck_01'));
    rig.evaluate();

    // chest twist about the spine
    const axis = M.row(rig.controlWorld('Spine_rot'), 1);
    const d = M.mul(M.transpose3(M.rotation(rig.jointWorld('spine_05'))), R('spine_05'));
    rig.set('Spine_rot.ry', twistAbout(d, M.norm(axis)));
    rig.evaluate();

    this._rot('Neck_rot', M.mul(k.Neck_rot, R('neck_01')));
    rig.evaluate();
    // The limbs, in the order their controls hang on one another: the goals (they may follow the chest, the
    // hips or the other hand), the pole vectors (they may follow the hand or the foot), then the clavicles (the
    // automatic shoulder turns them toward the hand), then the hands and feet.  Twice: a goal that follows the
    // other hand needs that hand's final turn.
    for (let round = 0; round < 2; round++) {
      for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
        this._pos(S + '_Hand_trans', P('hand_' + s));
        this._pos(S + '_Foot_trans', P('foot_' + s));
      }
      rig.evaluate();
      for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
        const ea = poleDir(P('upperarm_' + s), P('lowerarm_' + s), P('hand_' + s), M.xdir(this.bend['upperarm_' + s], R('upperarm_' + s)));
        this._pos(S + '_elbow_pv', M.add(P('lowerarm_' + s), M.scl(ea, this.pvArm)));
        const ka = poleDir(P('thigh_' + s), P('calf_' + s), P('foot_' + s), M.xdir(this.bend['thigh_' + s], R('thigh_' + s)));
        this._pos(S + '_knee_pv', M.add(P('calf_' + s), M.scl(ka, this.pvLeg)));
      }
      rig.evaluate();
      for (const [S, s] of [['L', 'l'], ['R', 'r']]) this._rot(S + '_Shoulder_rot', M.mul(k[S + '_Shoulder_rot'], R('clavicle_' + s)));
      rig.evaluate();
      for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
        this._rot(S + '_Hand_rot', M.mul(k[S + '_Hand_rot'], R('hand_' + s)));
        this._rot(S + '_Foot_rot', M.mul(k[S + '_Foot_rot'], R('foot_' + s)));
      }
      rig.evaluate();
    }

    this._pos('Head_trans', M.add(P('head'), M.xdir(this.headAim, R('head'))));
    for (const [S, s] of [['L', 'l'], ['R', 'r']]) this._rot(S + '_Toe_rot', M.mul(k[S + '_Toe_rot'], R('ball_' + s)));
    rig.evaluate();

    // head roll about the line of sight
    const sight = M.norm(M.sub(M.pos(rig.controlWorld('Head_trans')), M.pos(rig.jointWorld('head'))));
    const dh = M.mul(M.transpose3(M.rotation(rig.jointWorld('head'))), R('head'));
    rig.set('Head_rot.rx', twistAbout(dh, sight));
    rig.evaluate();
    return rig;
  }
}
