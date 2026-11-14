// The control rig, evaluated from the node graph exported from the Maya scene (assets/rig.json).
//
//   control values -> control / helper transforms -> drv skeleton -> bind skeleton
//
// Every node of the Maya rig is evaluated with the same rules Maya uses (point / orient / parent / aim
// constraints with weights that come from the options, RP IK, the finger expression, the twist joints, the
// automatic shoulder), so the result is the Maya rig, not an approximation.
//
// Options (`custom_attributes` of the hand and foot controls: follow, pvFollow, wristFollow, ankleFollow,
// autoShoulder) are channels like the others: in the pose vector they are held as the difference from their
// default, so that a vector of zeros is the rig at rest with every option at its default.  IKFK is held at
// 1 (IK): this tool does not use the FK controls (they are in the rig, hidden, and stay at rest).
import * as M from './m4.js';

const CH = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'];
/** Options the tool does not let change, and the value they are held at. */
const FIXED = { IKFK: 1 };

/** Split a local matrix into scale sign (mirror on Z), rotation and translation. */
function split(m) {
  const mirrored = M.det3(m) < 0;
  const r = M.rotOnly(m);
  if (mirrored) { r[8] = -r[8]; r[9] = -r[9]; r[10] = -r[10]; }
  return { mirrored, r, t: M.pos(m) };
}

export class ControlRig {
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
      // (the FK controls: IK only here - they stay at rest and are not shown)
      const hidden = /_fk$/.test(c.name);
      const ctl = {
        name: c.name, side: c.side, group: c.group, node, channels: hidden ? [] : c.animatable.slice(), limits,
        parentControl: c.parent_control, mirror: c.mirror || {}, mirroredAxes: !!c.mirrored_axes,
        shapes: c.shapes || [], order: c.rotate_order, hidden,
        hasT: !hidden && c.animatable.some(a => a[0] === 't'), hasR: !hidden && c.animatable.some(a => a[0] === 'r'),
        options: [],
      };
      node.control = ctl;
      node.value = [0, 0, 0, 0, 0, 0];
      node.opt = {};
      for (const a of c.custom_attributes || []) {
        if (a.name === 'control_control') continue;
        const o = { name: a.name, def: a.default, min: a.min ?? 0, max: a.max ?? 1, enum: a.enum || null, fixed: a.name in FIXED, delta: [0] };
        if (o.fixed) o.delta[0] = FIXED[a.name] - o.def;
        node.opt[a.name] = o;
        if (!o.fixed) ctl.options.push(a.name);
      }
      this.controls.push(ctl);
      this.controlByName.set(c.name, ctl);
    }

    // constraints
    for (const c of spec.constraints) {
      const driven = this.byName.get(c.driven);
      const drives = c.drives || [];
      const k = {
        type: c.type, targets: c.targets.map(t => this.byName.get(t)), weights: c.weights.slice(),
        moveT: !drives.length || drives.some(d => d.startsWith('translate')), moveR: !drives.length || drives.some(d => d.startsWith('rotate')),
        // weights that the options decide (the condition / reverse / multDL nodes, written as expressions)
        weightFns: (c.weights_expr || []).map((e, i) => (c.weight_inputs?.[i] && e ? compileWeight(e, this) : null)),
      };
      if (c.type === 'pointConstraint') k.offset = c.offset;
      else if (c.type === 'orientConstraint') k.offset = M.euler(c.offset, 'xyz');
      else if (c.type === 'parentConstraint') {
        k.offsets = c.target_offsets.map(o => M.compose(M.euler(o.rotate, 'xyz'), o.translate));
      } else if (c.type === 'aimConstraint') {
        k.offset = M.euler(c.offset, 'xyz');
        // rows: aim, up (made square to the aim, as Maya does), third (local)
        const a = M.norm(c.aim_vector), u = M.norm(M.ortho(c.up_vector, a));
        k.basis = M.fromRows(a, u, M.cross(a, u));
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

    // the automatic shoulder: a pairBlend from rest to the rotation of an aim node, with a weight from the options
    for (const u of spec.utility_nodes || []) {
      if (u.type !== 'pairBlend' || !u.outputs) continue;
      const from = this.byName.get((u.inRotate2_from || u.inputs.find(i => i[1].endsWith('.inRotate2'))[0]).split('.')[0]);
      for (const [, dst] of u.outputs) {
        const n = this.byName.get(dst.split('.')[0]);
        if (n && from) n.pairBlend = { from, weight: compileWeight(u.weight_expr, this) };
      }
    }

    // neck: the neck joints take 40% of the head yaw (rotateZ of rig_head_aim)
    const aim = this.byName.get('rig_head_aim');
    const necks = this.nodes.filter(n => /^rig_neck_twist\d+$/.test(n.name));
    for (const n of necks) n.neckTwist = { aim, share: 0.4 / necks.length };

    // bind skeleton: same local values as the drv skeleton
    this.joints = spec.bind_skeleton.map(j => {
      const jo = j.joint_orient || [0, 0, 0], has = jo.some(x => Math.abs(x) > 1e-9);
      return { name: j.name, parent: j.parent, drv: this.byName.get(j.driven_by || 'drv_' + j.name), rest: j.world_matrix, orientEuler: jo, orient: has ? M.euler(jo, 'xyz') : null };
    });
    this.jointIndex = new Map(this.joints.map((j, i) => [j.name, i]));
    this.scale = this.byName.get('drv_head').restWorld[13] / 162.6;
    this.exprValue = new Map();
    this._channels();
    this._order();
  }

  // -- values -----------------------------------------------------------
  /** values: {"Control.ch": number}.  Missing channels are 0 (= rest), missing options their default. */
  setValues(values) {
    for (const c of this.controls) { c.node.value.fill(0); for (const n of c.options) c.node.opt[n].delta[0] = 0; }
    for (const k in values) this.set(k, values[k]);
  }

  /** The value of a channel, or of an option (its own value, not the difference from its default). */
  set(key, v) {
    const i = key.lastIndexOf('.');
    const c = this.controlByName.get(key.slice(0, i));
    if (!c) return;
    const ch = key.slice(i + 1);
    const o = c.node.opt[ch];
    if (o) { if (!o.fixed) o.delta[0] = Math.max(o.min, Math.min(o.max, v)) - o.def; return; }
    if (!c.channels.includes(ch)) return;
    const lim = c.limits[ch];
    if (lim) v = Math.max(lim[0], Math.min(lim[1], v));
    c.node.value[CH.indexOf(ch)] = v;
  }

  get(key) {
    const i = key.lastIndexOf('.');
    const c = this.controlByName.get(key.slice(0, i));
    if (!c) return 0;
    const ch = key.slice(i + 1), o = c.node.opt[ch];
    if (o) return option(o);
    return c.node.value[CH.indexOf(ch)];
  }

  /** All channel values that are not at rest (options: not at their default). */
  getValues() {
    const out = {};
    for (const c of this.controls) {
      for (const ch of c.channels) {
        const v = c.node.value[CH.indexOf(ch)];
        if (v !== 0) out[c.name + '.' + ch] = v;
      }
      for (const n of c.options) if (c.node.opt[n].delta[0] !== 0) out[c.name + '.' + n] = option(c.node.opt[n]);
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
    for (const k in values) { const i = this.channelIndex.get(k); if (i !== undefined) v[i] = values[k] - this.channelBase[i]; }
    return v;
  }

  valuesFromVector(v) {
    const out = {};
    for (let i = 0; i < v.length; i++) if (Math.abs(v[i]) > 1e-9) out[this.channelKeys[i]] = +(v[i] + this.channelBase[i]).toFixed(5);
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
    // channelBase: what a vector value of 0 is (0 for the transform channels, the default for an option);
    // channelStep: an option that picks one of several (never in between: in-betweens hold it)
    this.channelKeys = []; this.channelRefs = []; this.channelLimits = []; this.channelControl = []; this.channelBase = []; this.channelStep = [];
    for (const c of this.controls) {
      for (const ch of c.channels) {
        this.channelKeys.push(c.name + '.' + ch);
        this.channelRefs.push([c.node.value, CH.indexOf(ch)]);
        this.channelLimits.push(c.limits[ch] || null);
        this.channelControl.push(c);
        this.channelBase.push(0); this.channelStep.push(false);
      }
      for (const n of c.options) {
        const o = c.node.opt[n];
        this.channelKeys.push(c.name + '.' + n);
        this.channelRefs.push([o.delta, 0]);
        this.channelLimits.push([o.min - o.def, o.max - o.def]);
        this.channelControl.push(c);
        this.channelBase.push(o.def); this.channelStep.push(!!o.enum);
      }
    }
    this.channelIndex = new Map(this.channelKeys.map((k, i) => [k, i]));
    this.mirrorMap = this.channelKeys.map((k, i) => {
      const c = this.channelControl[i], ch = k.slice(k.lastIndexOf('.') + 1);
      const other = this.channelIndex.get(this.mirrorName(c.name) + '.' + ch) ?? i;
      // (a control with no mirror table - world_ctl, COG_ctl - has the world axes: the mirror image across the
      //  YZ plane negates its X move and its turns about Y and Z)
      const table = Object.keys(c.mirror).length ? c.mirror : { invTx: true, invRy: true, invRz: true };
      const inv = c.node.opt[ch] ? false : table['inv' + ch[0].toUpperCase() + ch.slice(1)];
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
    // The nodes in the order of what they read (every target of a constraint counts, whatever the options make
    // of its weight): a node that is in no loop is evaluated once, after everything it reads.  The loops (strongly
    // connected parts of the graph) are passed over until they settle, before what hangs on them.
    const deps = n => [
      n.inherits ? n.parent : null, ...n.cons.flatMap(c => [...c.targets, c.upObject]), n.pairBlend?.from, n.neckTwist?.aim,
      n.twist?.src, n.ik?.handle, n.ik?.pv, n.ikMid?.start,
    ].filter(Boolean);
    // (Tarjan: the strongly connected parts come out with what they read before them)
    const low = new Map(), num = new Map(), stack = [], on = new Set(), parts = [];
    let count = 0;
    const visit = n => {
      num.set(n, count); low.set(n, count); count++; stack.push(n); on.add(n);
      for (const d of deps(n)) {
        if (!num.has(d)) { visit(d); low.set(n, Math.min(low.get(n), low.get(d))); } else if (on.has(d)) low.set(n, Math.min(low.get(n), num.get(d)));
      }
      if (low.get(n) === num.get(n)) {
        const part = [];
        let m;
        do { m = stack.pop(); on.delete(m); part.push(m); } while (m !== n);
        parts.push(part.sort((a, b) => a.index - b.index));
      }
    };
    for (const n of this.nodes) if (!num.has(n)) visit(n);
    this.steps = parts.map(p => (p.length > 1 ? p : p[0]));
    this.loops = parts.filter(p => p.length > 1);

    this.passes = 12;
    const probe = {};
    let s = 1;
    for (const c of this.controls) for (const ch of c.channels) { s = -s; probe[c.name + '.' + ch] = s * (ch[0] === 't' ? 6 : 9); }
    const saved = this.getValues();
    this.setValues(probe);
    this.passes = 40;
    this.evaluate();
    const settled = this.nodes.map(n => n.world.slice());
    let need = 40;
    for (let p = 1; p <= 40; p++) {
      for (const n of this.nodes) { n.world = n.restWorld.slice(); }
      this.passes = p;
      this.evaluate();
      let err = 0;
      for (const n of this.nodes) for (let i = 0; i < 16; i++) err = Math.max(err, Math.abs(n.world[i] - settled[n.index][i]));
      if (err < 1e-9) { need = p; break; }
    }
    this.passes = need + 1;
    this.setValues(saved);
    this.evaluate();
  }

  _run(passes) {
    for (const s of this.steps) {
      if (!Array.isArray(s)) { this._node(s); continue; }
      for (let i = 0; i < passes; i++) for (const n of s) this._node(n);
    }
  }

  evaluate() {
    this._expr();
    this._weights();
    this._run(this.passes);
    return this;
  }

  /** Constraint weights that the options decide. */
  _weights() {
    for (const n of this.nodes) for (const c of n.cons) c.weightFns.forEach((f, i) => { if (f) c.weights[i] = f(); });
  }

  _expr() {
    this.exprValue.clear();
    for (const f of this.expr) f(this);
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
    if (n.pairBlend) {
      // rotate = slerp(0, from.rotate, weight); `from` sits at rest with no rotation of its own
      const w = n.pairBlend.weight();
      if (w) r = M.mul(M.fromQuat(M.qslerp([0, 0, 0, 1], M.toQuat(M.mul(n.pairBlend.from.r, M.transpose3(n.pairBlend.from.restR))), w)), r);
    }
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
        const sum = c.weights.reduce((a, b) => a + b, 0);
        if (sum <= 1e-9 && c.type !== 'aimConstraint' && c.type !== 'poleVectorConstraint') continue; // (no target in use)
        if (c.type === 'pointConstraint') {
          t = M.add(M.xpoint(meanPos(c), pinv), c.offset);
        } else if (c.type === 'orientConstraint') {
          const w = M.mul(c.offset, blendTargets(c));
          r = localRot(w, pw, n.mirrored);
        } else if (c.type === 'parentConstraint') {
          // (with several targets the weights pick one: the options are on or off)
          let l;
          if (c.targets.length === 1) l = M.mul(M.mul(c.offsets[0], c.targets[0].world), pinv);
          else {
            const ws = c.targets.map((tg, i) => M.mul(c.offsets[i], tg.world));
            const p = [0, 0, 0];
            ws.forEach((w, i) => { const k = c.weights[i] / sum; p[0] += w[12] * k; p[1] += w[13] * k; p[2] += w[14] * k; });
            const rot = M.blendRot(ws.map(w => M.rotation(w)), c.weights.map(x => x / sum));
            l = M.mul(M.compose(rot, p), pinv);
          }
          if (c.moveT) t = M.pos(l);
          // a mirrored target (the L finger controls): Maya reads it as scale (-1,-1,-1)
          if (c.moveR) r = M.det3(l) < 0 ? M.rotation(l.map((x, i) => (i < 11 ? -x : x))) : M.rotation(l);
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
  const used = c.weights.map((w, i) => [w, i]).filter(e => e[0] > 1e-9);
  if (used.length === 1) return M.rotation(c.targets[used[0][1]].world);
  // two targets: shortest = slerp (interp 2); more (never in use at once here): normalised quaternion mean
  if (used.length === 2) {
    const [a, b] = used, k = b[0] / (a[0] + b[0]);
    return M.fromQuat(M.qslerp(M.toQuat(M.rotation(c.targets[a[1]].world)), M.toQuat(M.rotation(c.targets[b[1]].world)), k));
  }
  return M.blendRot(used.map(e => M.rotation(c.targets[e[1]].world)), used.map(e => e[0]));
}

/** The value of an option (enumerations are whole numbers). */
function option(o) { const v = o.def + o.delta[0]; return o.enum ? Math.round(v) : v; }

/** A weight written over the options, e.g. "((L_Foot_rot.follow == 1) * (L_Foot_rot.pvFollow == 0))". */
function compileWeight(expr, rig) {
  const js = String(expr).replace(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g, (_, n, a) => {
    const o = rig.byName.get(n)?.opt?.[a];
    if (!o) throw Error('weight: ' + n + '.' + a);
    return `o(${JSON.stringify(n + '.' + a)})`;
  });
  const opts = {};
  const o = k => { if (!opts[k]) { const [n, a] = k.split('.'); opts[k] = rig.byName.get(n).opt[a]; } return option(opts[k]); };
  const fn = new Function('o', 'return +(' + js + ');');
  return () => fn(o);
}

/** World rotation -> rotation in the space of the parent. */
function localRot(world, pw, mirrored) {
  const l = M.mul(world, M.transpose3(M.rotation(pw)));
  return l;
}

/** MEL clamp(min, max, value). */
const clampMel = (lo, hi, x) => Math.max(lo, Math.min(hi, x));

/** The finger expression: assignments of products and sums of control channels. */
function compileExpression(code, rig) {
  const lines = code.split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^(?:float\s+)?([$\w.]+)\s*=\s*(.+)$/);
    if (!m) throw Error('expression: ' + line);
    const lhs = m[1];
    const js = m[2]
      .replace(/\bmax\(/g, 'Math.max(').replace(/\bmin\(/g, 'Math.min(').replace(/\bclamp\(/g, 'clamp(')
      .replace(/\$(\w+)/g, 'v.$1')
      .replace(/\b([A-Za-z_]\w*)\.(translate|rotate)([XYZ])\b/g, (_, n, k, ax) => `g("${n}.${k[0]}${ax.toLowerCase()}")`);
    const fn = new Function('v', 'g', 'clamp', 'return ' + js + ';');
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
      const x = s.fn(v, g, clampMel);
      if (s.local) v[s.local] = x;
      else {
        let a = r.exprValue.get(s.node);
        if (!a) r.exprValue.set(s.node, a = [0, 0, 0]);
        a[s.axis] = x;
      }
    }
  };
}
