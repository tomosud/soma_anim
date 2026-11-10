// In-betweens by NVIDIA MotionBricks (the SOMA model): four context poses and a target pose in,
// the motion between them out.  The model runs in a worker (src/mb_worker.js, ONNX Runtime Web on
// WebGPU, WASM as a fallback); the weights are downloaded by the browser from NVIDIA's repository
// on first use (about 380 MB, kept in IndexedDB).
//
// Encoding, decoding and the end-point correction follow NVlabs/motionbricks
// `motionbricks/model/soma/kernels.py` (Apache-2.0), by way of soma-fighter-web src/soma.js.
import * as M from './m4.js';
import { qmul, qinv, qrot, qyaw } from './motiondb.js';

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
    batch.has_local_poses[f] = given;
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

/** Move the first frame onto `start` and the last onto `end`, each correction fading across the motion (local rotations). */
function correctEndpoints(soma, frames, start, end) {
  const n = frames.length;
  if (n < 2) return frames;
  const local = p => { const out = []; for (let j = 0; j < NJ; j++) { const q = soma.rot(p, j); out.push(soma.parents[j] < 0 ? q : qmul(qinv(soma.rot(p, soma.parents[j])), q)); } return out; };
  const L0 = local(frames[0]), L1 = local(frames[n - 1]), C = local(start), T = local(end);
  const dS = C.map((c, j) => qmul(c, qinv(L0[j]))), dE = T.map((t, j) => qmul(t, qinv(L1[j])));
  const rS = M.sub(start.root, frames[0].root), rE = M.sub(end.root, frames[n - 1].root);
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

function lerpPose(a, b, t) {
  const q = new Float32Array(a.q.length);
  for (let i = 0; i < q.length; i += 4) q.set(M.qslerp([a.q[i], a.q[i + 1], a.q[i + 2], a.q[i + 3]], [b.q[i], b.q[i + 1], b.q[i + 2], b.q[i + 3]], t), i);
  return { root: M.lerp(a.root, b.root, t), q, contact: (t < 0.5 ? a : b).contact };
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
        else if (data.type === 'ready') { this.state = 'ready'; this.backend = data.backend; resolve(data.backend); }
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
   * A, B: pose vectors of two keys n frames apart.  context: the last four SOMA poses of the motion that
   * arrives at A (so the movement carries through the key), or null to start from rest in A.
   * Returns {frames, match, tail} like Inbetweener.generate; tail = the last four SOMA poses, for the next one.
   * Requests run one at a time, in the order they were asked for.
   */
  generate(A, B, n, context = null) {
    const job = this.chain.then(() => this._generate(A, B, n, context));
    this.chain = job.catch(() => {});
    return job;
  }

  async _generate(A, B, n, context) {
    const { rig, re } = this.inb, soma = this.soma;
    // (this runs between the animator's actions: the rig is put back as it was each time it is borrowed)
    let held = rig.getVector();
    rig.setVector(A).evaluate(); const a = re.fromRig(rig);
    rig.setVector(B).evaluate(); const b = re.fromRig(rig);
    rig.setVector(held).evaluate();
    // the model makes 24-64 frames (6-16 tokens of 4), three of which are dropped at each end
    const want = Math.max(6, Math.min(16, Math.round((n + 7) / 4)));
    const batch = emptyBatch(1);
    const align = encode(soma, batch, context ?? [a, a, a, a], [b], [want]);
    const out = await this._run(batch);
    let frames = decode(soma, out.motions, out.tokens[0], align);
    if (frames.length < 4) throw Error('MotionBricks returned no motion');
    frames = correctEndpoints(soma, frames, a, b);
    // the model's length is a multiple of four frames: resample to the key spacing
    const m = frames.length - 1, placed = [], contact = [[], []];
    for (let k = 0; k <= n; k++) {
      const f = k * m / n, i = Math.min(m - 1, Math.floor(f));
      const p = lerpPose(frames[i], frames[i + 1], f - i);
      placed.push(p);
      contact[0].push(Math.max(p.contact[0], p.contact[1]) > 0.55);
      contact[1].push(Math.max(p.contact[2], p.contact[3]) > 0.55);
    }
    held = rig.getVector();
    const r = this.inb.finish(A, B, n, placed, contact);
    rig.setVector(held).evaluate();
    r.match = { clip: 'MotionBricks', frames: m, speed: m / n, ms: out.ms };
    r.tail = frames.slice(-4);
    return r;
  }
}
