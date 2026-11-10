// BNS style rig for UE5 Manny, evaluated from the node graph exported from
// Rig_Manny_BNS.ma (rigspec/bns_rig_spec.json).
//
//   control values -> control / helper transforms -> drv skeleton -> bind skeleton
//
// Every node of the Maya rig is evaluated with the same rules Maya uses
// (point / orient / parent / aim constraints, RP IK, the finger expression,
// the twist joints), so the result is the Maya rig, not an approximation.
import * as M from './m4.js';

const CH = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'];

/** Split a local matrix into scale sign (mirror on Z), rotation and translation. */
function split(m) {
  const mirrored = M.det3(m) < 0;
  const r = M.rotOnly(m);
  if (mirrored) { r[8] = -r[8]; r[9] = -r[9]; r[10] = -r[10]; }
  return { mirrored, r, t: M.pos(m) };
}

export class BnsRig {
  constructor(spec) {
    this.spec = spec;
    this.nodes = [];
    this.byName = new Map();
    const raw = new Map(spec.nodes.map(n => [n.name, n]));
    const add = name => {
      if (this.byName.has(name)) return this.byName.get(name);
      const s = raw.get(name);
      const parent = s.parent && raw.has(s.parent) ? add(s.parent) : null;
      const rest = split(s.local_matrix);
      const n = {
        name, parent, index: this.nodes.length, inherits: s.inherits_transform !== false,
        order: s.rotate_order || 'xyz', mirrored: rest.mirrored, restR: rest.r, restT: rest.t,
        restWorld: s.world_matrix.slice(), world: s.world_matrix.slice(), local: s.local_matrix.slice(),
        r: rest.r.slice(), t: rest.t.slice(), cons: [], isJoint: s.type === 'joint',
      };
      this.nodes.push(n);
      this.byName.set(name, n);
      return n;
    };
    for (const s of spec.nodes) add(s.name);

    // controls
    this.controls = [];
    this.controlByName = new Map();
    for (const c of spec.controls) {
      const node = this.byName.get(c.name);
      const limits = {};
      for (const ch of c.animatable) if (c.channels[ch].limit) limits[ch] = c.channels[ch].limit;
      const ctl = {
        name: c.name, side: c.side, group: c.group, node, channels: c.animatable.slice(), limits,
        parentControl: c.parent_control, mirror: c.mirror || {}, mirroredAxes: !!c.mirrored_axes,
        shapes: c.shapes || [], order: c.rotate_order,
        hasT: c.animatable.some(a => a[0] === 't'), hasR: c.animatable.some(a => a[0] === 'r'),
      };
      node.control = ctl;
      node.value = [0, 0, 0, 0, 0, 0];
      this.controls.push(ctl);
      this.controlByName.set(c.name, ctl);
    }

    // constraints
    for (const c of spec.constraints) {
      const driven = this.byName.get(c.driven);
      const k = { type: c.type, targets: c.targets.map(t => this.byName.get(t)), weights: c.weights };
      if (c.type === 'pointConstraint') k.offset = c.offset;
      else if (c.type === 'orientConstraint') k.offset = M.euler(c.offset, 'xyz');
      else if (c.type === 'parentConstraint') {
        k.offsets = c.target_offsets.map(o => M.compose(M.euler(o.rotate, 'xyz'), o.translate));
      } else if (c.type === 'aimConstraint') {
        k.offset = M.euler(c.offset, 'xyz');
        const a = c.aim_vector, u = c.up_vector;
        k.basis = M.fromRows(a, u, M.cross(a, u)); // rows: aim, up, third (local)
        k.upType = c.world_up_type;
        k.upVector = c.world_up_vector;
        k.upObject = this.byName.get(c.world_up_object);
      } else if (c.type === 'poleVectorConstraint') { k.pole = true; }
      driven.cons.push(k);
    }

    // IK
    this.iks = spec.ik_handles.map(h => {
      const handle = this.byName.get(h.node);
      const pvc = handle.cons.find(c => c.pole);
      const start = this.byName.get(h.start_joint), mid = this.byName.get(h.mid_joint), end = this.byName.get(h.end_joint);
      const a = mid.restT, b = M.xdir(end.restT, mid.restR); // both in the space of the start joint
      const la = M.len(a), lb = M.len(b);
      const ik = {
        handle, start, mid, end, pv: pvc.targets[0], a, b, la, lb,
        axis: M.norm(M.cross(a, b)), // hinge axis (start joint space)
        rest: Math.acos(Math.max(-1, Math.min(1, M.dot(a, b) / (la * lb)))), // angle from a to b
      };
      start.ik = ik;
      mid.ikMid = ik;
      return ik;
    });

    // finger expressions: "node.rotateX = <expr>;"
    this.expr = [];
    for (const e of spec.expressions) this.expr.push(compileExpression(e.code, this));

    // twist joints
    for (const t of spec.twist_joints) {
      const src = this.byName.get(t.source_joint);
      const restInv = M.transpose3(split(t.rest_local_matrix).r);
      for (const j of t.joints) {
        const n = this.byName.get(j.joint);
        n.twist = { src, restInv, self: t.mode === 'self_local', weight: j.weight };
      }
    }

    // neck: the neck joints take 40% of the head yaw (rotateZ of bns_head_aim)
    const aim = this.byName.get('bns_head_aim');
    const necks = this.nodes.filter(n => /^bns_neck_twist\d+$/.test(n.name));
    for (const n of necks) n.neckTwist = { aim, share: 0.4 / necks.length };

    // bind skeleton: same local values as the drv skeleton
    this.joints = spec.bind_skeleton.map(j => ({ name: j.name, parent: j.parent, drv: this.byName.get(j.driven_by || 'drv_' + j.name), rest: j.world_matrix }));
    this.jointIndex = new Map(this.joints.map((j, i) => [j.name, i]));
    this.scale = this.byName.get('drv_head').restWorld[13] / 162.6;
    this.exprValue = new Map();
    this._channels();
    this._order();
  }

  // -- values -----------------------------------------------------------
  /** values: {"Control.ch": number}.  Missing channels are 0 (= rest). */
  setValues(values) {
    for (const c of this.controls) c.node.value.fill(0);
    for (const k in values) this.set(k, values[k]);
  }

  set(key, v) {
    const i = key.lastIndexOf('.');
    const c = this.controlByName.get(key.slice(0, i));
    if (!c) return;
    const ch = key.slice(i + 1);
    if (!c.channels.includes(ch)) return;
    const lim = c.limits[ch];
    if (lim) v = Math.max(lim[0], Math.min(lim[1], v));
    c.node.value[CH.indexOf(ch)] = v;
  }

  get(key) {
    const i = key.lastIndexOf('.');
    const c = this.controlByName.get(key.slice(0, i));
    return c ? c.node.value[CH.indexOf(key.slice(i + 1))] : 0;
  }

  /** All non-zero channel values. */
  getValues() {
    const out = {};
    for (const c of this.controls) for (const ch of c.channels) {
      const v = c.node.value[CH.indexOf(ch)];
      if (v !== 0) out[c.name + '.' + ch] = v;
    }
    return out;
  }

  // -- vectors: one number per animatable channel, in this.channelKeys order --
  getVector(out = new Float64Array(this.channelKeys.length)) {
    for (let i = 0; i < this.channelRefs.length; i++) out[i] = this.channelRefs[i][0][this.channelRefs[i][1]];
    return out;
  }

  setVector(v) {
    for (let i = 0; i < this.channelRefs.length; i++) {
      const lim = this.channelLimits[i];
      this.channelRefs[i][0][this.channelRefs[i][1]] = lim ? Math.max(lim[0], Math.min(lim[1], v[i])) : v[i];
    }
    return this;
  }

  vectorFromValues(values) {
    const v = new Float64Array(this.channelKeys.length);
    for (const k in values) { const i = this.channelIndex.get(k); if (i !== undefined) v[i] = values[k]; }
    return v;
  }

  valuesFromVector(v) {
    const out = {};
    for (let i = 0; i < v.length; i++) if (Math.abs(v[i]) > 1e-9) out[this.channelKeys[i]] = +v[i].toFixed(5);
    return out;
  }

  /** Left-right mirror of a pose (world YZ plane). */
  mirrorVector(v) {
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[this.mirrorMap[i][0]] = v[i] * this.mirrorMap[i][1];
    return out;
  }

  mirrorName(name) {
    if (name.startsWith('L_')) return 'R_' + name.slice(2);
    if (name.startsWith('R_')) return 'L_' + name.slice(2);
    if (name.includes('_L_')) return name.replace('_L_', '_R_');
    if (name.includes('_R_')) return name.replace('_R_', '_L_');
    return name;
  }

  _channels() {
    this.channelKeys = []; this.channelRefs = []; this.channelLimits = []; this.channelControl = [];
    for (const c of this.controls) for (const ch of c.channels) {
      this.channelKeys.push(c.name + '.' + ch);
      this.channelRefs.push([c.node.value, CH.indexOf(ch)]);
      this.channelLimits.push(c.limits[ch] || null);
      this.channelControl.push(c);
    }
    this.channelIndex = new Map(this.channelKeys.map((k, i) => [k, i]));
    this.mirrorMap = this.channelKeys.map((k, i) => {
      const c = this.channelControl[i], ch = k.slice(k.lastIndexOf('.') + 1);
      const other = this.channelIndex.get(this.mirrorName(c.name) + '.' + ch) ?? i;
      const inv = c.mirror['inv' + ch[0].toUpperCase() + ch.slice(1)];
      return [other, inv ? -1 : 1];
    });
  }

  // -- evaluation ---------------------------------------------------------
  /**
   * The graph has position / orientation cross links (the foot control sits on
   * the ankle that the IK places, the ankle takes the orientation of the foot
   * control), so one pass in hierarchy order is not enough.  Find, once, an
   * order and a number of passes that settles a strongly posed rig.
   */
  _order() {
    this.passes = 12;
    const probe = {};
    let s = 1;
    for (const c of this.controls) for (const ch of c.channels) { s = -s; probe[c.name + '.' + ch] = s * (ch[0] === 't' ? 6 : 9); }
    const saved = this.getValues();
    this.setValues(probe);
    this._run(40);
    const settled = this.nodes.map(n => n.world.slice());
    for (const n of this.nodes) { n.world = n.restWorld.slice(); }
    let need = 40;
    for (let p = 1; p <= 40; p++) {
      this._pass();
      let err = 0;
      for (const n of this.nodes) for (let i = 0; i < 16; i++) err = Math.max(err, Math.abs(n.world[i] - settled[n.index][i]));
      if (err < 1e-9) { need = p; break; }
    }
    this.passes = need + 1;
    this.setValues(saved);
    this.evaluate();
  }

  _run(passes) { for (let i = 0; i < passes; i++) this._pass(); }

  evaluate() {
    this._expr();
    this._run(this.passes);
    return this;
  }

  _expr() {
    this.exprValue.clear();
    for (const f of this.expr) f(this);
  }

  _pass() {
    for (const n of this.nodes) this._node(n);
  }

  _node(n) {
    const pw = n.parent && n.inherits ? n.parent.world : IDENT;
    let r = n.restR, t = n.restT;

    if (n.control) {
      const v = n.value;
      if (v[0] || v[1] || v[2]) t = [t[0] + v[0], t[1] + v[1], t[2] + v[2]];
      if (v[3] || v[4] || v[5]) r = M.mul(M.euler([v[3], v[4], v[5]], n.order), r);
    }
    const ev = this.exprValue.get(n);
    if (ev) r = M.mul(M.euler(ev, n.order), r);
    if (n.neckTwist) {
      const rz = M.toEuler(n.neckTwist.aim.r, 'xyz')[2];
      r = M.mul(M.rotAxis(2, rz * n.neckTwist.share), r);
    }
    if (n.twist) {
      const tw = n.twist, cur = tw.src.r;
      const d = tw.self ? M.mul(cur, tw.restInv) : M.mul(tw.restInv, cur);
      const q = M.toQuat(d);
      const ang = 2 * Math.atan2(q[0], q[3]) / M.DEG;
      const a = ang > 180 ? ang - 360 : ang < -180 ? ang + 360 : ang;
      r = M.mul(M.rotAxis(0, a * tw.weight), r);
    }

    if (n.cons.length) {
      const pinv = M.inv(pw);
      for (const c of n.cons) {
        if (c.type === 'pointConstraint') {
          t = M.add(M.xpoint(meanPos(c), pinv), c.offset);
        } else if (c.type === 'orientConstraint') {
          const w = M.mul(c.offset, blendTargets(c));
          r = localRot(w, pw, n.mirrored);
        } else if (c.type === 'parentConstraint') {
          const w = M.mul(c.offsets[0], c.targets[0].world);
          const l = M.mul(w, pinv);
          t = M.pos(l);
          // a mirrored target (the L finger controls): Maya reads it as scale (-1,-1,-1)
          r = M.det3(l) < 0 ? M.rotation(l.map((x, i) => (i < 11 ? -x : x))) : M.rotation(l);
        } else if (c.type === 'aimConstraint') {
          const p = M.xpoint(t, pw);
          const dir = M.norm(M.sub(M.pos(c.targets[0].world), p));
          let up = c.upType === 'object' ? M.sub(M.pos(c.upObject.world), p) : M.xdir(c.upVector, c.upObject.world);
          up = M.norm(M.ortho(up, dir), [0, 1, 0]);
          const world = M.mul(M.transpose3(c.basis), M.fromRows(dir, up, M.cross(dir, up)));
          r = M.mul(c.offset, localRot(world, pw, n.mirrored));
        }
      }
    }

    if (n.ik) r = this._ikStart(n.ik, pw, t);
    else if (n.ikMid) r = n.ikMid.midR || r;

    n.r = r; n.t = t;
    const l = n.local;
    const z = n.mirrored ? -1 : 1;
    l[0] = r[0]; l[1] = r[1]; l[2] = r[2];
    l[4] = r[4]; l[5] = r[5]; l[6] = r[6];
    l[8] = r[8] * z; l[9] = r[9] * z; l[10] = r[10] * z;
    l[12] = t[0]; l[13] = t[1]; l[14] = t[2];
    M.mul(l, pw, n.world);
  }

  /** Rotate-plane IK without stretch.  Returns the local rotation of the start joint. */
  _ikStart(ik, pw, t) {
    const p0 = M.xpoint(t, pw);
    const goal = M.pos(ik.handle.world);
    const toGoal = M.sub(goal, p0);
    const { la, lb } = ik;
    const d = Math.max(Math.abs(la - lb) + 1e-6, Math.min(la + lb, M.len(toGoal)));
    // angle from a to b: 0 = straight
    const want = Math.PI - Math.acos(Math.max(-1, Math.min(1, (la * la + lb * lb - d * d) / (2 * la * lb))));
    const bend = M.axisAngle(ik.axis, want - ik.rest);
    ik.midR = M.mul(ik.mid.restR, bend);
    const b = M.xdir(ik.b, bend);
    const e = M.add(ik.a, b);
    // frame of the bent chain with the rest orientation of the start joint
    const w0 = M.mul(ik.start.restR, M.rotation(pw));
    const x1 = M.norm(M.xdir(e, w0));
    const z1 = M.norm(M.ortho(M.xdir(ik.axis, w0), x1));
    const m1 = M.cross(x1, z1);
    // frame wanted: end toward the goal, middle joint on the pole vector side
    const x2 = M.norm(toGoal, x1);
    const pv = M.sub(M.pos(ik.pv.world), p0);
    const m2 = M.norm(M.ortho(pv, x2), m1);
    const z2 = M.cross(m2, x2);
    const q = M.mul(M.transpose3(M.fromRows(x1, m1, z1)), M.fromRows(x2, m2, z2));
    return localRot(M.mul(w0, q), pw, false);
  }

  // -- results ------------------------------------------------------------
  /** World matrix (16 numbers) of a bind joint. */
  jointWorld(name) { return this.joints[this.jointIndex.get(name)].drv.world; }
  node(name) { return this.byName.get(name); }
  controlWorld(name) { return this.byName.get(name).world; }
}

const IDENT = M.ident();

function meanPos(c) {
  let x = 0, y = 0, z = 0, w = 0;
  for (let i = 0; i < c.targets.length; i++) {
    const m = c.targets[i].world, k = c.weights[i];
    x += m[12] * k; y += m[13] * k; z += m[14] * k; w += k;
  }
  return [x / w, y / w, z / w];
}

function blendTargets(c) {
  if (c.targets.length === 1) return M.rotation(c.targets[0].world);
  return M.blendRot(c.targets.map(t => M.rotation(t.world)), c.weights);
}

/** World rotation -> rotation in the space of the parent. */
function localRot(world, pw, mirrored) {
  const l = M.mul(world, M.transpose3(M.rotation(pw)));
  return l;
}

/** The finger expression: assignments of products and sums of control channels. */
function compileExpression(code, rig) {
  const lines = code.split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^(?:float\s+)?([$\w.]+)\s*=\s*(.+)$/);
    if (!m) throw Error('expression: ' + line);
    const lhs = m[1];
    const js = m[2]
      .replace(/\bmax\(/g, 'Math.max(').replace(/\bmin\(/g, 'Math.min(')
      .replace(/\$(\w+)/g, 'v.$1')
      .replace(/\b([A-Za-z_]\w*)\.(translate|rotate)([XYZ])\b/g, (_, n, k, ax) => `g("${n}.${k[0]}${ax.toLowerCase()}")`);
    const fn = new Function('v', 'g', 'return ' + js + ';');
    if (lhs[0] === '$') steps.push({ local: lhs.slice(1), fn });
    else {
      const [name, attr] = lhs.split('.');
      const node = rig.byName.get(name);
      const axis = 'XYZ'.indexOf(attr.slice(-1));
      if (!node || !attr.startsWith('rotate')) throw Error('expression target: ' + lhs);
      steps.push({ node, axis, fn });
    }
  }
  return r => {
    const v = {}, g = k => r.get(k);
    for (const s of steps) {
      const x = s.fn(v, g);
      if (s.local) v[s.local] = x;
      else {
        let a = r.exprValue.get(s.node);
        if (!a) r.exprValue.set(s.node, a = [0, 0, 0]);
        a[s.axis] = x;
      }
    }
  };
}
