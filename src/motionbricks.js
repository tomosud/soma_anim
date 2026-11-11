// In-betweens by NVIDIA MotionBricks (the SOMA model): four context poses and a target pose in,
// the motion between them out.  The model runs in a worker (src/mb_worker.js, ONNX Runtime Web on
// WebGPU, WASM as a fallback); the weights are downloaded by the browser from NVIDIA's repository
// on first use (about 380 MB, kept in IndexedDB).
//
// Encoding, decoding and the end-point correction follow NVlabs/motionbricks
// `motionbricks/model/soma/kernels.py` (Apache-2.0), by way of soma-fighter-web src/soma.js.
import * as M from './m4.js';
import { qmul, qinv, qrot, qyaw } from './motiondb.js';
import { Evaluator, penalty } from './evaluate.js';

export const FPS = 30, NJ = 30, FEAT = 366, MAX_FRAMES = 64;
const MB_REV = '54fc563aeaaf819a753d72cc9fdc6713989cdd43';
export const MODEL_URL = `https://media.githubusercontent.com/media/NVlabs/motionbricks/${MB_REV}/motionbricks/assets/onnx/soma/mmm_v6_soma_fp16.onnx`;
const ID = [0, 0, 0, 1];

function emptyBatch(n) {
  return {
    global_root_values: new Float32Array(n * 8 * 5), local_root_values: new Float32Array(n * 8 * 4), local_poses: new Float32Array(n * 8 * 267),
    has_global_root_values: new Int32Array(n * 8), has_local_root_values: new Int32Array(n * 8), has_local_poses: new Int32Array(n * 8),
    allowed_pred_num_tokens: new Int32Array(n * 11),
  };
}

/** Four context poses, 1-4 target poses, the allowed token counts -> tensors (request 0 of a batch of 1). */
function encode(soma, batch, context, targets, tokens) {
  const nT = targets.length, poses = [...context, ...targets];
  while (poses.length < 8) poses.push(targets[nT - 1]);
  const world = poses.map(p => soma.positions(p));
  const last = world[3];
  const yaw = soma.heading(last) - Math.PI / 2; // the last context pose faces +X
  const alignQ = qyaw(yaw), inv = qinv(alignQ), origin = [last[0][0], 0, last[0][2]];
  const aligned = world.map(P => P.map(v => qrot(inv, [v[0] - origin[0], v[1] - origin[1], v[2] - origin[2]])));
  const headings = aligned.map(P => soma.heading(P));
  const g = batch.global_root_values, l = batch.local_root_values, lp = batch.local_poses;
  for (let f = 0; f < 8; f++) {
    const next = f === 3 ? f : Math.min(f + 1, 7);
    const hip = aligned[f][0], nhip = aligned[next][0];
    const dh = Math.atan2(Math.sin(headings[next] - headings[f]), Math.cos(headings[next] - headings[f]));
    g.set([hip[0], hip[1], hip[2], Math.cos(headings[f]), Math.sin(headings[f])], f * 5);
    l.set([dh * FPS, (nhip[0] - hip[0]) * FPS, (nhip[2] - hip[2]) * FPS, hip[1]], f * 4);
    const base = f * 267;
    for (let j = 0; j < NJ; j++) {
      if (j > 0) { const p = aligned[f][j]; lp.set([p[0] - hip[0], p[1], p[2] - hip[2]], base + (j - 1) * 3); }
      const q = qmul(inv, soma.rot(poses[f], j));
      const xa = qrot(q, [1, 0, 0]), ya = qrot(q, [0, 1, 0]);
      lp.set([xa[0], xa[1], xa[2], ya[0], ya[1], ya[2]], base + 87 + j * 6);
    }
    const given = f < 4 + nT ? 1 : 0;
    batch.has_global_root_values[f] = given;
    // a target marked `free` says only where the hips are and which way they face; the body is the model's
    batch.has_local_poses[f] = given && !(f >= 4 && poses[f].free) ? 1 : 0;
    batch.has_local_root_values[f] = (f === 3 || f === 4 + nT - 1) ? 0 : given;
  }
  for (let i = 0; i < 11; i++) batch.allowed_pred_num_tokens[i] = tokens.includes(6 + i) ? 1 : 0;
  return { origin, q: alignQ };
}

/** Model output -> SOMA poses in the world (three boundary frames dropped at each end). */
function decode(soma, motions, tokens, align) {
  const raw = Math.max(0, Math.min(MAX_FRAMES, tokens * 4)), frames = [];
  for (let f = 3; f < raw - 3; f++) {
    const o = f * FEAT;
    const r = qrot(align.q, [motions[o], motions[o + 1], motions[o + 2]]);
    const q = new Float32Array(NJ * 4);
    for (let j = 0; j < NJ; j++) {
      const k = o + 92 + j * 6;
      const x = M.norm([motions[k], motions[k + 1], motions[k + 2]]);
      const z = M.norm(M.cross(x, [motions[k + 3], motions[k + 4], motions[k + 5]]));
      const y = M.cross(z, x);
      q.set(qmul(align.q, M.toQuat(M.fromRows(x, y, z))), j * 4);
    }
    const contact = [0, 1, 2, 3].map(i => Math.max(0, Math.min(1, motions[o + FEAT - 4 + i]))); // L heel, L toe, R heel, R toe
    frames.push(soma.fixRigid({ root: [r[0] + align.origin[0], r[1] + align.origin[1], r[2] + align.origin[2]], q, contact }));
  }
  return frames;
}

/**
 * Move the first frame onto `start` and the last onto `end`, each correction fading across the motion (local
 * rotations).  end = null: only the start is corrected (a stretch that goes on into the next one).
 */
function correctEndpoints(soma, frames, start, end, endRoot = null) {
  const n = frames.length;
  if (n < 2) return frames;
  const local = p => { const out = []; for (let j = 0; j < NJ; j++) { const q = soma.rot(p, j); out.push(soma.parents[j] < 0 ? q : qmul(qinv(soma.rot(p, soma.parents[j])), q)); } return out; };
  const L0 = local(frames[0]), L1 = local(frames[n - 1]), C = local(start), T = end ? local(end) : L1;
  const dS = C.map((c, j) => qmul(c, qinv(L0[j]))), dE = T.map((t, j) => qmul(t, qinv(L1[j])));
  // (endRoot: only the place of the hips on the ground is brought to that pose's - a walk kept on its schedule)
  const rS = M.sub(start.root, frames[0].root);
  let rE = end ? M.sub(end.root, frames[n - 1].root) : [0, 0, 0];
  if (!end && endRoot) rE = [endRoot.root[0] - frames[n - 1].root[0], 0, endRoot.root[2] - frames[n - 1].root[2]];
  return frames.map((fr, i) => {
    const w = i / (n - 1), L = local(fr), q = new Float32Array(NJ * 4);
    const out = { root: M.add(fr.root, M.add(M.scl(rS, 1 - w), M.scl(rE, w))), q, contact: fr.contact };
    for (let j = 0; j < NJ; j++) {
      const l = qmul(M.qslerp(ID, dE[j], w), qmul(M.qslerp(ID, dS[j], 1 - w), L[j]));
      q.set(soma.parents[j] < 0 ? l : qmul(soma.rot(out, soma.parents[j]), l), j * 4);
    }
    return soma.fixRigid(out);
  });
}

function locals(soma, p) {
  const out = [];
  for (let j = 0; j < NJ; j++) { const q = soma.rot(p, j); out.push(soma.parents[j] < 0 ? q : qmul(qinv(soma.rot(p, soma.parents[j])), q)); }
  return out;
}

function fromLocals(soma, root, L) {
  const q = new Float32Array(NJ * 4), p = { root, q };
  for (let j = 0; j < NJ; j++) q.set(soma.parents[j] < 0 ? L[j] : qmul(soma.rot(p, soma.parents[j]), L[j]), j * 4);
  return p;
}

function lerpPose(a, b, t) {
  const q = new Float32Array(a.q.length);
  for (let i = 0; i < q.length; i += 4) q.set(M.qslerp([a.q[i], a.q[i + 1], a.q[i + 2], a.q[i + 3]], [b.q[i], b.q[i + 1], b.q[i + 2], b.q[i + 3]], t), i);
  return { root: M.lerp(a.root, b.root, t), q, contact: (t < 0.5 ? a : b).contact || [0, 0, 0, 0] };
}

export class MotionBricks {
  /** inb: the Inbetweener (its rig, retarget and fitting are used). */
  constructor(inb) {
    this.inb = inb;
    this.soma = inb.db.rig;
    this.state = 'idle'; // idle | loading | ready | failed
    this.backend = '';
    this.waiting = new Map();
    this.serial = 0;
    this.chain = Promise.resolve();
  }

  /** Download (or read from the cache) the model and start the session.  onProgress({phase, loaded, total}). */
  load(onProgress = () => {}, url = MODEL_URL) {
    if (this.loading) return this.loading;
    this.state = 'loading';
    this.loading = new Promise((resolve, reject) => {
      const w = this.worker = new Worker(new URL('./mb_worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress(data);
        else if (data.type === 'ready') {
          // (the first run compiles the shaders - a few seconds: done here, behind the wait screen)
          this.backend = data.backend;
          const warm = emptyBatch(1); warm.allowed_pred_num_tokens[2] = 1;
          this._run(warm).catch(() => {}).then(() => { this.state = 'ready'; resolve(data.backend); });
        }
        else if (data.type === 'result') { this.waiting.get(data.id)?.resolve(data); this.waiting.delete(data.id); }
        else if (data.type === 'error') {
          if (data.id !== undefined && this.waiting.has(data.id)) { this.waiting.get(data.id).reject(Error(data.message)); this.waiting.delete(data.id); } else { this.state = 'failed'; reject(Error(data.message)); }
        }
      };
      w.onerror = e => { this.state = 'failed'; reject(Error(e.message || 'worker failed')); };
      const ep = new URLSearchParams(location.search).get('ep');
      w.postMessage({ type: 'load', url, ep, batch: 1 });
    });
    return this.loading;
  }

  _run(batch) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(Error('MotionBricks did not answer in 30 s')); }, 30000);
      this.waiting.set(id, { resolve: d => { clearTimeout(timer); resolve(d); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.worker.postMessage({ type: 'run', id, n: 1, inputs: batch });
    });
  }

  /**
   * One generation, as the model gives it: context = four SOMA poses, targets = one to four, tokens = the
   * allowed token counts.  Returns {frames (the three boundary frames at each end removed), tokens, ms}.
   */
  async raw(context, targets, tokens) {
    const batch = emptyBatch(1);
    const align = encode(this.soma, batch, context, targets, tokens);
    const out = await this._run(batch);
    return { frames: decode(this.soma, out.motions, out.tokens[0], align), tokens: out.tokens[0], ms: out.ms };
  }

  /**
   * A, B: pose vectors of two keys n frames apart.  context: the last four SOMA poses of the motion that
   * arrives at A (so the movement carries through the key), or null to start from rest in A.
   * Returns {frames, match, tail}; tail = the last four SOMA poses, for the next stretch.
   * Requests run one at a time, in the order they were asked for.
   */
  generate(A, B, n, context = null, opts = {}) {
    const job = this.chain.then(() => this._generate(A, B, n, context, opts));
    this.chain = job.catch(() => {});
    return job;
  }

  /** The walk the reference motion has for going `dir` (radians from straight ahead, + = left) at `speed` m/s. */
  _gait(dir, speed, low = false) {
    if (!this.gaits) {
      const db = this.inb.db, soma = this.soma;
      this.gaits = GAITS.map(g => {
        const clip = db.clips.findIndex(c => c.name.startsWith(g.clip));
        if (clip < 0) return null;
        // speed and period of the cycle, measured on the clip
        const f0 = g.from, at = f => db.pose(clip, f), P0 = soma.positions(at(f0));
        let best = null;
        for (let f = f0 + 18; f < Math.min(db.clips[clip].frames - 5, f0 + 60); f++) {
          const P = soma.positions(at(f));
          let e = 0;
          for (const j of [soma.index.LeftFoot, soma.index.RightFoot, soma.index.LeftHand, soma.index.RightHand]) e += Math.hypot(P[j][0] - P[0][0] - P0[j][0] + P0[0][0], P[j][1] - P0[j][1], P[j][2] - P[0][2] - P0[j][2] + P0[0][2]);
          if (!best || e < best.e) best = { e, f };
        }
        const a = at(f0), b = at(best.f), period = best.f - f0;
        // the pose the cycle swings about (per joint, the mean of its rotation relative to its parent)
        const mean = [];
        for (let f = f0; f < f0 + period; f++) locals(soma, at(f)).forEach((q, j) => { const m = mean[j] || (mean[j] = [0, 0, 0, 0]), sg = m[0] * q[0] + m[1] * q[1] + m[2] * q[2] + m[3] * q[3] < 0 ? -1 : 1; for (let k = 0; k < 4; k++) m[k] += sg * q[k]; });
        for (const m of mean) { const l = Math.hypot(m[0], m[1], m[2], m[3]); for (let k = 0; k < 4; k++) m[k] /= l; }
        return { ...g, index: clip, period, mean, height: a.root[1], speed: Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]) / period * FPS };
      }).filter(Boolean);
    }
    const kind = Math.abs(dir) < 1.0 ? 'fwd' : Math.abs(dir) > 2.2 ? 'back' : null;
    let best = null;
    for (const g of this.gaits) {
      if (g.kind !== kind || !!g.low !== low) continue;
      const rate = speed / g.speed, off = Math.abs(Math.log(rate));
      if (!best || off < best.off) best = { g, rate, off };
    }
    return best || (low ? this._gait(dir, speed, false) : null);
  }

  /** n poses of a gait from cycle position `phase` (frames), the first at (x, z) facing `yaw`, played at `rate`. */
  _stride(gait, phase, n, x, z, yaw, rate, swing = 1) {
    const db = this.inb.db, soma = this.soma, g = gait;
    // (swing < 1: a slower walk takes shorter steps - every joint swings that much less about its mean)
    const at = f => {
      f = g.from + ((f % g.period) + g.period) % g.period;
      const i = Math.floor(f), p = lerpPose(db.pose(g.index, i), db.pose(g.index, i + 1), f - i);
      if (swing >= 0.999) return p;
      const L = locals(soma, p);
      return fromLocals(soma, p.root, L.map((q, j) => (j === 0 ? q : M.qslerp(g.mean[j], q, swing))));
    };
    const p0 = at(phase), a = yaw - soma.heading(soma.positions(p0)), out = [];
    const v = g.speed / FPS * rate * swing * (g.kind === 'back' ? -1 : 1);
    for (let i = 0; i < n; i++) out.push(soma.place(at(phase + i * rate), a, x + Math.sin(yaw) * i * v, z + Math.cos(yaw) * i * v));
    return out;
  }

  /**
   * One way of making the stretch.  plan: {kind: 'single', tokens: [...]} or {kind: 'walk'}.
   * Returns the SOMA frames (frame 0 = at A ... the last at B) and how long the model took.
   */
  async _attempt(plan, a, b, c, n, ctx, nextLen) {
    const soma = this.soma;
    const goal = c && nextLen > 1 ? [b, lerpPose(b, c, 1 / nextLen)] : [b];
    let ms = 0;
    const one = async (context, targets, tokens) => { const r = await this.raw(context, targets, tokens); ms += r.ms; if (r.frames.length < 4) throw Error('MotionBricks returned no motion'); return r.frames; };
    if (plan.kind === 'single') {
      const part = await one(ctx, goal, plan.tokens);
      return { frames: correctEndpoints(soma, part, ctx[3], b), ms };
    }
    if (plan.kind === 'hops') {
      // a way the walks do not cover (sideways): one short move after another, each to the pose between the keys
      let frames = [], context = ctx;
      for (let i = 1; i <= plan.pieces; i++) {
        const last = i === plan.pieces, target = last ? b : lerpPose(a, b, i / plan.pieces);
        const want = Math.round(n * i / plan.pieces) - frames.length + (frames.length ? 1 : 0) - 1;
        const tokens = Math.max(6, Math.min(16, Math.round((want + 7) / 4)));
        const part = correctEndpoints(soma, await one(context, last ? goal : [target], [tokens]), context[3], target);
        const len = part.length - 1, fit = [];
        for (let k = 0; k <= want; k++) { const f = k * len / want, j = Math.min(len - 1, Math.floor(f)); fit.push(lerpPose(part[j], part[j + 1], f - j)); }
        frames = frames.concat(frames.length ? fit.slice(1) : fit);
        context = frames.slice(-4);
      }
      return { frames, ms };
    }
    // A walk: the hips follow a schedule along the straight way from A to B (speeding up, steady, slowing down),
    // and the model is aimed, again and again, at a stride of the reference walk placed a second ahead on that
    // schedule - and asked anew before it gets there, so it never slows down for a target.  The last stretch
    // aims at key B itself.
    const D = Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]);
    const ux = (b.root[0] - a.root[0]) / D, uz = (b.root[2] - a.root[2]) / D;
    const ha = soma.heading(soma.positions(a)), hb = soma.heading(soma.positions(b)), turn = Math.atan2(Math.sin(hb - ha), Math.cos(hb - ha));
    const ramp = Math.max(6, Math.min(15, n / 4)), cruise = D / (n - ramp); // metres per frame
    const along = f => { f = Math.max(0, Math.min(n, f)); return f < ramp ? cruise * f * f / (2 * ramp) : f > n - ramp ? D - cruise * (n - f) * (n - f) / (2 * ramp) : cruise * (f - ramp / 2); };
    // On the way the body faces where it goes (or, when both keys look the other way, walks backwards): it
    // turns into the walk at the start and into key B's facing at the end.
    const wrapA = x => Math.atan2(Math.sin(x), Math.cos(x)), ease = u => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
    const ht = Math.atan2(ux, uz), cost = h => Math.abs(wrapA(h - ha)) + Math.abs(wrapA(hb - h));
    const back = cost(ht + Math.PI) + 1 < cost(ht), hw = back ? ht + Math.PI : ht;
    const t1 = wrapA(hw - ha), t2 = wrapA(hb - hw), turnIn = Math.min(n * 0.35, 12 + Math.abs(t1) * 14), turnOut = Math.min(n * 0.35, 12 + Math.abs(t2) * 14);
    const facing = f => ha + t1 * ease(f / turnIn) + t2 * ease((f - (n - turnOut)) / turnOut);
    // (keys that are both low: the crouched walk)
    const pick = this._gait(back ? Math.PI : 0, cruise * FPS, (a.root[1] + b.root[1]) / 2 < 0.84 * soma.hipHeight);
    if (!pick) throw Error('no gait for that direction');
    // A walk slower or faster than the reference one: people change the length of the step and its pace about
    // equally (the square root of the speed each), so the reference stride is shortened and played slower.
    const gait = pick.g, speed = Math.max(0.3, Math.min(1.6, pick.rate)), swing = Math.max(0.55, Math.min(1.1, Math.sqrt(speed))), rate = speed / swing;
    // An arm the animator holds the same way in both keys, and not the way a walking arm hangs (a raised hand,
    // something carried), is held on the way too: the strides the model is aimed at have it, and what comes
    // back is brought to it.
    const La = locals(soma, a), Lb = locals(soma, b), ang = (p, q) => 2 * Math.acos(Math.min(1, Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3])));
    const carried = [];
    for (const side of ['Left', 'Right']) {
      const js = ['Shoulder', 'Arm', 'ForeArm', 'Hand'].map(n => soma.index[side + n]);
      const same = Math.max(...js.map(j => ang(La[j], Lb[j]))), odd = Math.max(ang(La[js[1]], gait.mean[js[1]]), ang(La[js[2]], gait.mean[js[2]]));
      if (same < 0.45 && odd > 0.9) carried.push(...js);
    }
    const carry = (p, u, w = 1) => {
      if (!carried.length) return p;
      const L = locals(soma, p);
      for (const j of carried) L[j] = M.qslerp(L[j], M.qslerp(La[j], Lb[j], u), w);
      return { ...fromLocals(soma, p.root, L), contact: p.contact };
    };
    const stride = f => { const s = along(f); return this._stride(gait, s / (gait.speed / FPS * swing), 4, a.root[0] + ux * s, a.root[2] + uz * s, facing(f), rate, Math.min(1, swing)).map(p => carry(p, f / n)); };
    let frames = [], t = 0, context = ctx;
    const HORIZON = 33, PLAY = 23; // 10 tokens ahead, asked anew 10 frames before arriving
    while (n - t > 57 || (n - t >= 38 && D - along(t) > 0.8)) {
      const play = Math.min(PLAY, n - t - 20);
      const part = correctEndpoints(soma, (await one(context, stride(t + HORIZON), [10])).slice(0, play + 1), context[3], null);
      frames = frames.concat(frames.length ? part.slice(1) : part);
      context = frames.slice(-4);
      t += play;
    }
    const left = n - t, tokens = Math.max(6, Math.min(16, Math.round((left + 7) / 4)));
    const part = correctEndpoints(soma, await one(context, goal, [tokens]), context[3], b);
    // (the last stretch is a frame or two longer or shorter than what is left: played that much faster or slower)
    const len = part.length - 1, fit = [];
    for (let k = 0; k <= left; k++) { const f = k * len / left, i = Math.min(len - 1, Math.floor(f)); fit.push(lerpPose(part[i], part[i + 1], f - i)); }
    frames = frames.concat(frames.length ? fit.slice(1) : fit);
    if (carried.length) frames = frames.map((p, k) => carry(p, k / n, 0.85));
    return { frames, ms, gait: gait.clip, rate, run: gait.run };
  }

  async _generate(A, B, n, context, { flow = false, next = null, nextLen = 0 } = {}) {
    const { rig, re } = this.inb, soma = this.soma;
    // (this runs between the animator's actions: the rig is put back as it was each time it is borrowed)
    let held = rig.getVector();
    rig.setVector(A).evaluate(); const a = re.fromRig(rig);
    rig.setVector(B).evaluate(); const b = re.fromRig(rig);
    let c = null;
    if (flow && next) { rig.setVector(next).evaluate(); c = re.fromRig(rig); }
    rig.setVector(held).evaluate();
    const ctx = context ?? [a, a, a, a];
    const dist = Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]); // metres
    const ha = soma.heading(soma.positions(a)), hb = soma.heading(soma.positions(b));
    const turn = Math.abs(Math.atan2(Math.sin(hb - ha), Math.cos(hb - ha)));
    // What the model is good at, and what it is not (measured: tools/mblab.js):
    //  * one generation is 18-58 frames.  Between two poses it can reach in that time it moves as a person would;
    //  * given more room than the move needs it mostly takes it all, so the animator's timing can be handed to it;
    //  * a place too far for one generation (2.5 m in under two seconds) it reaches by diving - so going
    //    somewhere is made as a walk (see _attempt), never as one long leap;
    //  * poses no one moves out of (a T-pose, a body off balance) give anything at all - the keys are made
    //    natural before they get here, and what comes back is checked (below) before it is shown.
    const moving = dist > 0.3 || turn > 0.5;
    const whole = Math.max(6, Math.min(16, Math.round((n + 7) / 4)));
    const upTo = Math.max(6, Math.min(16, Math.floor((n + 7) / 4)));
    const range = (lo, hi) => { const r = []; for (let t = lo; t <= hi; t++) r.push(t); return r; };
    const plans = [];
    // (measured: 1 m in one generation is fine, 1.5 m is a dive)
    if (dist > 0.9 && n >= 38 && this._gait(0, 1)) plans.push({ kind: 'walk' });
    // (too far for one move and too short a time for a walk: in two or three moves)
    if (dist > 1.2 && n >= 34) plans.push({ kind: 'hops', pieces: Math.max(2, Math.min(Math.floor(n / 17), Math.ceil(dist / 0.9))) });
    if (n <= 57) {
      // the gap is the move (the animator's timing); failing that, the model's own time and a hold
      plans.push({ kind: 'single', tokens: [whole] });
      if (upTo > 6) plans.push({ kind: 'single', tokens: range(6, upTo) });
      if (upTo > 8) plans.push({ kind: 'single', tokens: [Math.max(6, upTo - 3)] });
    } else {
      plans.push({ kind: 'single', tokens: range(8, 16) }, { kind: 'single', tokens: [12] }, { kind: 'single', tokens: [9] });
    }
    // Every way is put on the rig and measured as the self test measures (leaving the floor, tipping over,
    // spinning, leaving the way between the keys, gestures nobody asked for); the first that is clean is taken,
    // otherwise the best - and if even that is bad, the plain in-between is better than what the model made.
    let best = null, tried = 0, ms = 0;
    const tries = [];
    for (const plan of plans) {
      let r;
      try { r = await this._attempt(plan, a, b, c, n, ctx, nextLen); } catch (e) { if (plan.kind === 'single' && !best) throw e; continue; }
      tried++; ms += r.ms;
      const made = this._place(A, B, n, r.frames, plan.kind !== 'single' || (n <= 57 && plan.tokens.length === 1 && plan.tokens[0] === whole));
      const score = this._score(A, B, made.frames, plan.kind === 'walk' ? (r.run ? 'run' : 'walk') : '');
      tries.push(`${plan.kind}${plan.tokens ? ' ' + plan.tokens.join(',') : ''}: ${score.total.toFixed(2)} ${worst(score)}`);
      if (!best || score.total < best.score.total) best = { plan, r, made, score };
      // (the plans are in the order of preference: one that is good enough is taken)
      if (score.total < (plan.kind === 'walk' ? 0.9 : 0.6)) break;
    }
    const { made, r, plan, score } = best;
    if (score.total > 1.6) {
      held = rig.getVector();
      const plainFrames = this.inb.steps(A, B, n);
      rig.setVector(held).evaluate();
      const plainScore = this._score(A, B, plainFrames);
      if (plainScore.total < score.total) return { frames: plainFrames, match: { clip: 'plain', why: worst(score), score: +plainScore.total.toFixed(2), tried, ms }, tail: null };
    }
    return {
      frames: made.frames,
      match: { clip: 'MotionBricks', kind: plan.kind, gait: r.gait, frames: r.frames.length - 1, hold: made.hold, ms, tried, score: +score.total.toFixed(2), why: worst(score), flow, tries },
      // (the next stretch continues this movement only if it runs right up to the key)
      tail: made.hold ? null : r.frames.slice(-4),
    };
  }

  /** SOMA frames -> pose vectors for frames 1..n-1.  exact: the motion fills the gap; else it is played as made and B held. */
  _place(A, B, n, frames, exact) {
    const { rig } = this.inb;
    const len = frames.length - 1, m = exact ? n : Math.min(n, len), placed = [], contact = [[], []];
    for (let k = 0; k <= m; k++) {
      const f = k * len / m, i = Math.min(len - 1, Math.floor(f));
      const q = lerpPose(frames[i], frames[i + 1], f - i);
      placed.push(q);
      contact[0].push(Math.max(q.contact[0], q.contact[1]) > 0.55);
      contact[1].push(Math.max(q.contact[2], q.contact[3]) > 0.55);
    }
    const held = rig.getVector();
    const out = this.inb.finish(A, B, m, placed, contact).frames;
    rig.setVector(held).evaluate();
    for (let k = m; k < n; k++) out.push(B);
    return { frames: out, hold: n - m };
  }

  _score(A, B, frames, gait = '') {
    if (!this.ev) this.ev = new Evaluator(this.inb.rig, this.inb.db, this.inb.re);
    const p = penalty(this.ev.measure([A, ...frames, B], [0, frames.length + 1], 30, { ref: false })).parts;
    // (a walk turns into the way it goes - that is not spinning; a run leans and leaves the floor)
    if (gait) { p.spin = 0; p.tilt *= gait === 'run' ? 0.2 : 0.6; p.hips *= 0.6; if (gait === 'run') p.air = 0; }
    // (what the eye forgives least counts most)
    return { total: p.air * 1.5 + p.hips + p.tilt * 1.5 + p.spin + p.path + p.gesture + p.slide * 0.5 + p.sink * 0.5, parts: p };
  }
}

const worst = s => Object.entries(s.parts).filter(e => e[1] > 0.3 && e[0] !== 'ref' && e[0] !== 'kink').sort((x, y) => y[1] - x[1]).map(e => e[0]).join(' ');

// The walks of the reference motion that the model is aimed at (clip name, the frame its cycle is read from).
const GAITS = [
  { kind: 'fwd', clip: 'standard_walk', from: 20 },
  { kind: 'fwd', clip: 'running_forward_c9ceee', from: 10, run: true },
  { kind: 'back', clip: 'backward_walk', from: 10 },
];
