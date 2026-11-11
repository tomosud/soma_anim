// SOMA pose <-> UE5 Manny.
//
//  * SomaToManny.targets(pose): world matrices (cm, row vectors) of the Manny body joints for a SOMA pose.
//    Each Manny joint takes the world rotation of its SOMA joint, measured from the SOMA rest pose and applied
//    to the Manny rest pose with the bone directions of the two rest poses lined up (T-pose vs A-pose).
//    Bone lengths are Manny's.
//  * queryFromRig(rig): the static motion-matching features (metres, body frame) of the pose the rig is in.
import * as M from './m4.js';
import { qmul, qinv, qfromTo, DIM, F_FEET, F_HIPS_H, F_HANDS, F_HEAD } from './motiondb.js';

const MAP = { pelvis: 'Hips', spine_01: 'Spine1', spine_02: 'Spine1', spine_03: 'Spine2', spine_04: 'Chest', spine_05: 'Chest', neck_01: 'Neck1', neck_02: 'Neck2', head: 'Head' };
const TIPS = { pelvis: 'spine_01', spine_01: 'spine_02', spine_02: 'spine_03', spine_03: 'spine_04', spine_04: 'spine_05', spine_05: 'neck_01', neck_01: 'neck_02', neck_02: 'head' };
for (const [s, w] of [['l', 'Left'], ['r', 'Right']]) {
  Object.assign(MAP, { ['clavicle_' + s]: w + 'Shoulder', ['upperarm_' + s]: w + 'Arm', ['lowerarm_' + s]: w + 'ForeArm', ['hand_' + s]: w + 'Hand', ['thigh_' + s]: w + 'Leg', ['calf_' + s]: w + 'Shin', ['foot_' + s]: w + 'Foot', ['ball_' + s]: w + 'ToeBase' });
  Object.assign(TIPS, { ['clavicle_' + s]: 'upperarm_' + s, ['upperarm_' + s]: 'lowerarm_' + s, ['lowerarm_' + s]: 'hand_' + s, ['hand_' + s]: 'middle_01_' + s, ['thigh_' + s]: 'calf_' + s, ['calf_' + s]: 'foot_' + s, ['foot_' + s]: 'ball_' + s });
}
const ORDER = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05', 'neck_01', 'neck_02', 'head'];
for (const s of 'lr') ORDER.push('clavicle_' + s, 'upperarm_' + s, 'lowerarm_' + s, 'hand_' + s, 'thigh_' + s, 'calf_' + s, 'foot_' + s, 'ball_' + s);

export class SomaToManny {
  /** cal: {joint: quaternion} from assets/retarget_cal.json - the roll of the limb bones going rig -> SOMA. */
  constructor(rig, soma, cal = null) {
    this.soma = soma;
    const rest = Object.fromEntries(rig.joints.map(j => [j.name, j.rest]));
    const parent = Object.fromEntries(rig.joints.map(j => [j.name, j.parent]));
    this.rest = rest;
    const hipY = rest.pelvis[13], footY = rest.foot_l[13];
    // cm per metre from the leg lengths, and the height that puts the ankles of both on the same floor
    this.k = (hipY - footY) / (soma.hipHeight - soma.ankleHeight);
    this.lift = footY - soma.ankleHeight * this.k;
    this.joints = ORDER.map(name => {
      const s = soma.index[MAP[name]];
      let a = [0, 0, 0, 1];
      const tip = TIPS[name];
      let st = tip && MAP[tip];
      if (name.startsWith('hand_')) st = MAP[name] + 'MiddleEnd';
      if (tip && st && st !== MAP[name]) {
        const dm = M.norm(M.sub(M.pos(rest[tip]), M.pos(rest[name])));
        const ds = M.norm(M.sub(soma.restPos[soma.index[st]], soma.restPos[s]));
        a = qfromTo(dm, ds);
      }
      // world rotation of the joint = q_soma(t) * c
      const c = qmul(qinv(soma.restRot[s]), qmul(a, M.toQuat(M.rotation(rest[name]))));
      // offset from the parent joint in the frame of the parent
      const p = parent[name];
      const off = rest[p] && MAP[p] ? M.xdir(M.sub(M.pos(rest[name]), M.pos(rest[p])), M.transpose3(M.rotation(rest[p]))) : null;
      return { name, s, c, back: cal?.[name] ?? c, parent: MAP[p] ? p : null, off };
    });
  }

  /** {jointName: world matrix} for the mapped body joints. */
  targets(pose) {
    const out = {}, soma = this.soma;
    for (const j of this.joints) {
      const r = M.fromQuat(qmul(soma.rot(pose, j.s), j.c));
      let p;
      if (!j.parent) p = [pose.root[0] * this.k, pose.root[1] * this.k + this.lift, pose.root[2] * this.k];
      else p = M.add(M.pos(out[j.parent]), M.xdir(j.off, out[j.parent]));
      out[j.name] = M.setPos(r, p);
    }
    return out;
  }

  /** The SOMA pose of the pose the rig is in (the inverse of targets()). */
  fromRig(rig) {
    const soma = this.soma, q = new Float32Array(soma.n * 4), done = new Uint8Array(soma.n);
    for (const j of this.joints) {
      // (spine_01 / spine_02 share Spine1, spine_04 / spine_05 share Chest: the upper one speaks)
      q.set(qmul(M.toQuat(M.rotation(rig.jointWorld(j.name))), qinv(j.back)), j.s * 4);
      done[j.s] = 1;
    }
    const pose = { root: this.toSoma(M.pos(rig.jointWorld('pelvis'))), q };
    for (let j = 0; j < soma.n; j++) if (!done[j]) q.set(qmul(soma.rot(pose, soma.parents[j]), soma.localRest[j]), j * 4);
    return pose;
  }

  /** cm (Manny world) -> metres (SOMA world) */
  toSoma(p) { return [p[0] / this.k, (p[1] - this.lift) / this.k, p[2] / this.k]; }
}

/** Facing (atan2(x, z)) of the rig from its thigh joints. */
export function rigHeading(rig) {
  const r = rig.jointWorld('thigh_r'), l = rig.jointWorld('thigh_l');
  const ax = r[12] - l[12], az = r[14] - l[14], n = Math.hypot(ax, az);
  return n < 1e-6 ? 0 : Math.atan2(az / n, -ax / n);
}

/** Body frame as in the database: origin = hips on the floor, z = facing, x = left. */
export function bodyPoint(p, hip, h) {
  const c = Math.cos(h), s = Math.sin(h), dx = p[0] - hip[0], dz = p[2] - hip[2];
  return [dx * c - dz * s, p[1], dx * s + dz * c];
}

/** The static features of the pose the rig is in. */
export function queryFromRig(rig, re) {
  const q = new Float32Array(DIM);
  const P = n => re.toSoma(M.pos(rig.jointWorld(n)));
  const hip = P('pelvis'), h = rigHeading(rig);
  const put = (k, n) => q.set(bodyPoint(P(n), hip, h), k);
  put(F_FEET, 'foot_l'); put(F_FEET + 3, 'foot_r');
  q[F_HIPS_H] = hip[1];
  put(F_HANDS, 'hand_l'); put(F_HANDS + 3, 'hand_r');
  put(F_HEAD, 'head');
  return { q, hip, heading: h };
}
