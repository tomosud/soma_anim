// Anime style: a correct but flat motion made snappier - pose contrast, anticipation and follow-through,
// a steadier stance, fast strikes and stops, the striking limb left out for a moment, the feet kept planted.
// The length of the animation and the times of its action peaks stay where they were (the keys can be kept as
// such peaks too), so the result replaces the plain animation frame for frame.
//
// It works on the skeleton (the body joints the rig is fitted from), and the result is put back on the rig with
// the fitter.  The order of the steps matters:
//   analyse -> 1 pose emphasis -> 2 cartoon filter -> 3 steady       (poses, on the time of the input)
//           -> 4 time warp (peaks locked)                              (time)
//           -> 5 limb hold -> 6 foot lock (always last)                (on the output)
// Methods: adjustment blending of pose offsets; the cartoon animation filter (Wang et al. 2006); guided time
// warping (Hsu et al. 2007) with fixed anchors.
import * as M from './m4.js';

/** Defaults.  Frame counts are counted at 60 fps (the steps convert them to the fps of the animation). */
export const STYLE_DEFAULTS = {
  poseAmp: 0.4, poseSigma: 0.2, keyGap: 0.15,
  cartoon: 1.2, cartoonSigma: 0.08,
  steady: 0.3, steadySigma: 0.25,
  contrast: 1.0, keyHoldF: 6, strikeSpeed: 2, strikeHoldF: 2,
  limbHoldF: 10, limbBlendF: 5,
  footLock: true, footBlendF: 4,
  strength: 1, // one knob: scales the pose emphasis, the cartoon filter, the steadiness and the contrast
};

// the joints worked on, each with the one it hangs on (spine_05 on the pelvis: the spine as one piece, as the
// rig has it)
const SIDES = ['l', 'r'];
export const STYLE_JOINTS = [['pelvis', null], ['spine_05', 'pelvis'], ['neck_01', 'spine_05'], ['head', 'neck_01'],
  ...SIDES.flatMap(s => [[`clavicle_${s}`, 'spine_05'], [`upperarm_${s}`, `clavicle_${s}`], [`lowerarm_${s}`, `upperarm_${s}`], [`hand_${s}`, `lowerarm_${s}`],
    [`thigh_${s}`, 'pelvis'], [`calf_${s}`, `thigh_${s}`], [`foot_${s}`, `calf_${s}`], [`ball_${s}`, `foot_${s}`]])];
const NAMES = STYLE_JOINTS.map(j => j[0]);
const IDX = new Map(NAMES.map((n, i) => [n, i]));
const PARENT = STYLE_JOINTS.map(j => (j[1] ? IDX.get(j[1]) : -1));
const LIMBS = ['hand_l', 'hand_r', 'foot_l', 'foot_r'];
const CHAIN = {
  hand_l: ['upperarm_l', 'lowerarm_l', 'hand_l'], hand_r: ['upperarm_r', 'lowerarm_r', 'hand_r'],
  foot_l: ['thigh_l', 'calf_l', 'foot_l', 'ball_l'], foot_r: ['thigh_r', 'calf_r', 'foot_r', 'ball_r'],
};
const BODY_PARTS = ['pelvis', 'spine_05', 'head', 'hand_l', 'hand_r', 'foot_l', 'foot_r'];

// ---------------------------------------------------------------- quaternions [x, y, z, w]
// qm(a, b) is the rotation of M.mul(A, B) (row vectors: a first, then b)
const qm = (b, a) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = q => [-q[0], -q[1], -q[2], q[3]];
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const qnorm = q => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qlog = q => { const w = q[3] < 0 ? -1 : 1, v = [q[0] * w, q[1] * w, q[2] * w], s = Math.hypot(...v); if (s < 1e-12) return [0, 0, 0]; const a = Math.atan2(s, q[3] * w) / s; return [v[0] * a, v[1] * a, v[2] * a]; };
const qexp = v => { const a = Math.hypot(...v); if (a < 1e-12) return [v[0], v[1], v[2], 1]; const s = Math.sin(a) / a; return [v[0] * s, v[1] * s, v[2] * s, Math.cos(a)]; };
/** q pushed away from s by (1 + k): s * (s^-1 q)^(1+k) */
const qpush = (s, q, k) => { const d = qlog(qm(q, qinv(s))); return qnorm(qm(qexp([d[0] * (1 + k), d[1] * (1 + k), d[2] * (1 + k)]), s)); };
const qangle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(qdot(a, b))));

// ---------------------------------------------------------------- smoothing
const kernel = (sigma) => { const r = Math.max(1, Math.ceil(3 * sigma)), w = []; for (let i = -r; i <= r; i++) w.push(Math.exp(-0.5 * (i / sigma) ** 2)); return { r, w }; };

/** Gaussian blur of a number series (sigma in frames). */
export function blur(x, sigma) {
  if (sigma < 0.3) return Float64Array.from(x);
  const { r, w } = kernel(sigma), n = x.length, out = new Float64Array(n);
  for (let f = 0; f < n; f++) { let s = 0, ws = 0; for (let i = -r; i <= r; i++) { const g = f + i; if (g < 0 || g >= n) continue; s += x[g] * w[i + r]; ws += w[i + r]; } out[f] = s / ws; }
  return out;
}

/** Gaussian blur of rotations: the signs made to agree with the middle frame, a weighted mean, normalised. */
function blurQ(qs, sigma) {
  if (sigma < 0.3) return qs.map(q => q.slice());
  const { r, w } = kernel(sigma), n = qs.length;
  return qs.map((c, f) => {
    const s = [0, 0, 0, 0];
    for (let i = -r; i <= r; i++) {
      const g = f + i; if (g < 0 || g >= n) continue;
      const q = qs[g], k = w[i + r] * (qdot(q, c) < 0 ? -1 : 1);
      s[0] += q[0] * k; s[1] += q[1] * k; s[2] += q[2] * k; s[3] += q[3] * k;
    }
    return qnorm(s);
  });
}

function blurV(vs, sigma) {
  const out = vs.map(() => [0, 0, 0]);
  for (let c = 0; c < 3; c++) { const b = blur(vs.map(v => v[c]), sigma); b.forEach((x, f) => { out[f][c] = x; }); }
  return out;
}

// ---------------------------------------------------------------- the skeleton
/** World rotation (quaternion) and position (cm) of each joint, from the locals. */
function fk(Q, T) {
  const wq = [], wp = [];
  for (let j = 0; j < NAMES.length; j++) {
    const p = PARENT[j];
    if (p < 0) { wq.push(Q[j]); wp.push(T[j]); continue; }
    wq.push(qnorm(qm(Q[j], wq[p])));
    wp.push(M.add(wp[p], M.xdir(T[j], M.fromQuat(wq[p]))));
  }
  return { wq, wp };
}

/** Locals from world rotations and positions. */
function locals(wq, wp) {
  const Q = [], T = [];
  for (let j = 0; j < NAMES.length; j++) {
    const p = PARENT[j];
    if (p < 0) { Q.push(wq[j]); T.push(wp[j]); continue; }
    Q.push(qnorm(qm(wq[j], qinv(wq[p]))));
    T.push(M.xdir(M.sub(wp[j], wp[p]), M.transpose3(M.fromQuat(wq[p]))));
  }
  return { Q, T };
}

// ---------------------------------------------------------------- analysis
const speedOf = (pos, fps) => pos.map((_, f) => {
  const a = pos[Math.max(0, f - 1)], b = pos[Math.min(pos.length - 1, f + 1)], dt = (Math.min(pos.length - 1, f + 1) - Math.max(0, f - 1)) / fps;
  return dt > 0 ? M.dist(a, b) / dt : 0;
});

/** Extremes of a series (min or max), at least `gap` frames apart (the stronger one kept), both ends added. */
function extremes(x, gap, accept, isMax) {
  const n = x.length, cand = [];
  for (let f = 1; f < n - 1; f++) {
    const e = isMax ? x[f] >= x[f - 1] && x[f] > x[f + 1] : x[f] <= x[f - 1] && x[f] < x[f + 1];
    if (e && accept(x[f])) cand.push(f);
  }
  cand.sort((a, b) => (isMax ? x[b] - x[a] : x[a] - x[b]));
  const kept = [];
  for (const f of cand) if (kept.every(k => Math.abs(k - f) >= gap)) kept.push(f);
  return [...new Set([0, ...kept, n - 1])].filter(f => f >= 0).sort((a, b) => a - b);
}

/**
 * P: per frame, world positions (cm) of the joints (by name).  Returns the speeds, the strikes, the key poses
 * (where the body nearly stops) and the action peaks (where it moves most).
 */
export function analyse(P, fps, o = STYLE_DEFAULTS) {
  const n = P.length, F = x => x * fps / 60;
  const rel = name => P.map(p => M.sub(p[name], p.pelvis));
  const limbSpeed = Object.fromEntries(LIMBS.map(l => [l, speedOf(rel(l), fps)]));
  const main = new Float64Array(n), who = [];
  for (let f = 0; f < n; f++) { let b = LIMBS[0]; for (const l of LIMBS) if (limbSpeed[l][f] > limbSpeed[b][f]) b = l; main[f] = limbSpeed[b][f]; who.push(b); }
  const vmax = n ? Math.max(...main) : 0;
  const strikes = [];
  if (vmax >= 400) {
    const peaks = extremes(main, F(8), v => v >= 0.55 * vmax, true).filter(f => f > 0 && f < n - 1);
    for (const peak of peaks) {
      const half = main[peak] / 2, limb = who[peak];
      let a0 = peak, a1 = peak;
      while (a0 > 0 && main[a0 - 1] >= half) a0--;
      while (a1 < n - 1 && main[a1 + 1] >= half) a1++;
      // the wind-up: the furthest pull against the strike within 0.6 s before it, and back to where the pull began
      const r = rel(limb), dir = M.norm(M.sub(r[Math.min(n - 1, peak + 1)], r[Math.max(0, peak - 1)]));
      const along = f => M.dot(r[f], dir);
      let m = a0;
      for (let f = Math.max(0, Math.round(peak - 0.6 * fps)); f <= a0; f++) if (along(f) < along(m)) m = f;
      let w0 = m;
      while (w0 > 0 && w0 > peak - 0.6 * fps && along(w0 - 1) > along(w0)) w0--;
      strikes.push({ peak, a0, a1, w0, limb });
    }
  }
  // the body: the pelvis as it moves, the rest as seen from the pelvis
  const parts = BODY_PARTS.map(b => speedOf(b === 'pelvis' ? P.map(p => p.pelvis) : rel(b), fps));
  const body = new Float64Array(n);
  for (let f = 0; f < n; f++) body[f] = parts.reduce((s, x) => s + x[f], 0) / parts.length;
  const still = blur(body, 0.03 * fps), lively = still;
  const top = n ? Math.max(...still) : 0, gap = o.keyGap * fps;
  const keyPoses = extremes(still, gap, v => v < 0.6 * top, false);
  const actionPeaks = extremes(lively, gap, v => v >= 0.25 * top, true);
  return { main, who, vmax, strikes, body, keyPoses, actionPeaks };
}

// ---------------------------------------------------------------- 1-3: poses
/** 1. Push the key poses away from the smoothed motion, spread over each joint's own turning (adjustment blending). */
function poseEmphasis(Q, keyPoses, amount, sigma) {
  if (!amount) return;
  for (let j = 0; j < NAMES.length; j++) {
    const q = Q.map(f => f[j]), s = blurQ(q, sigma);
    const off = keyPoses.map(k => qm(qpush(s[k], q[k], amount), qinv(q[k])));
    // how far the joint has turned so far
    const cum = new Float64Array(q.length);
    for (let f = 1; f < q.length; f++) cum[f] = cum[f - 1] + qangle(q[f - 1], q[f]);
    for (let i = 0; i + 1 < keyPoses.length; i++) {
      const a = keyPoses[i], b = keyPoses[i + 1], span = cum[b] - cum[a];
      for (let f = a; f <= b; f++) {
        const w = span > 1e-4 ? (cum[f] - cum[a]) / span : (f - a) / Math.max(1, b - a);
        Q[f][j] = qnorm(qm(M.qslerp(off[i], off[i + 1], w), q[f]));
      }
    }
  }
}

/** 2. The cartoon filter: rotations (and the pelvis position, half as much) pushed away from their blur. */
function cartoon(Q, T, k, sigma) {
  if (!k) return;
  for (let j = 0; j < NAMES.length; j++) {
    const q = Q.map(f => f[j]), s = blurQ(q, sigma);
    for (let f = 0; f < q.length; f++) Q[f][j] = qpush(s[f], q[f], k);
  }
  const x = T.map(f => f[0]), s = blurV(x, sigma);
  for (let f = 0; f < x.length; f++) T[f][0] = M.add(s[f], M.scl(M.sub(x[f], s[f]), 1 + 0.5 * k));
}

/** 3. Away from the strikes, the small shakes of the stance are calmed. */
function steady(Q, strikes, amount, sigma, F) {
  if (!amount) return;
  const n = Q.length, busy = new Uint8Array(n);
  for (const s of strikes) for (let f = Math.max(0, Math.floor(s.w0 - F(2))); f <= Math.min(n - 1, Math.ceil(s.a1 + F(4))); f++) busy[f] = 1;
  for (let j = 0; j < NAMES.length; j++) {
    const s = blurQ(Q.map(f => f[j]), sigma);
    for (let f = 0; f < n; f++) if (!busy[f]) Q[f][j] = M.qslerp(Q[f][j], s[f], amount);
  }
}

// ---------------------------------------------------------------- 4: time
/**
 * The source time of every output frame.  Between two anchors the output takes as long as the source did; the
 * holds are taken out of that first (up to 60 %), the rest is shared out as 1 / rate.
 * rate: per source frame.  anchors: source frames (sorted, ends included).  holds: [{at, len}] (frames).
 */
export function lockedWarp(n, rate, anchors, holds) {
  const times = new Float64Array(n);
  for (let f = 0; f < n; f++) times[f] = f;
  const rateAt = s => { const i = Math.min(n - 1, Math.floor(s)), t = s - i; return i + 1 < n ? rate[i] + (rate[i + 1] - rate[i]) * t : rate[i]; };
  for (let i = 0; i + 1 < anchors.length; i++) {
    const a = anchors[i], b = anchors[i + 1], L = b - a;
    if (L < 2) continue;
    const hs = holds.filter(h => (h.at > a || (i === 0 && h.at === a)) && h.at <= b);
    const H = hs.reduce((s, h) => s + h.len, 0), fit = H > 0.6 * L ? 0.6 * L / H : 1;
    const R = L - H * fit, K = Math.max(8, Math.ceil(L / 0.05)), ds = L / K;
    let I = 0;
    const inv = new Float64Array(K);
    for (let k = 0; k < K; k++) { inv[k] = 1 / rateAt(a + (k + 0.5) * ds); I += inv[k] * ds; }
    const c = R / I, U = [a], S = [a];
    let u = a;
    for (const h of hs) if (h.at === a) { u += h.len * fit; U.push(u); S.push(a); }
    for (let k = 0; k < K; k++) {
      const s0 = a + k * ds, s1 = s0 + ds;
      u += c * inv[k] * ds; U.push(u); S.push(s1);
      for (const h of hs) if (h.at > s0 && h.at <= s1) { u += h.len * fit; U.push(u); S.push(s1); }
    }
    // (rounding: the last point is exactly b)
    U[U.length - 1] = b;
    let p = 0;
    for (let f = Math.ceil(a); f <= b; f++) {
      while (p + 1 < U.length - 1 && U[p + 1] < f) p++;
      const du = U[p + 1] - U[p];
      times[f] = du > 1e-9 ? S[p] + (S[p + 1] - S[p]) * Math.min(1, Math.max(0, (f - U[p]) / du)) : S[p + 1];
    }
  }
  return times;
}

// ---------------------------------------------------------------- 6: feet
/** Where each foot is planted in the source: [{limb, s0, s1}] (source frames). */
function contacts(P, fps) {
  const out = [], n = P.length;
  const low = j => Math.min(...P.map(p => Math.min(p[j + '_l'][1], p[j + '_r'][1])));
  const lowFoot = low('foot'), lowBall = low('ball');
  for (const s of SIDES) {
    const v = speedOf(P.map(p => p['foot_' + s]), fps);
    let start = -1;
    for (let f = 0; f <= n; f++) {
      const on = f < n && P[f]['foot_' + s][1] - lowFoot < 6 && P[f]['ball_' + s][1] - lowBall < 6 && v[f] < 30;
      if (on && start < 0) start = f;
      if (!on && start >= 0) { if ((f - start) / fps >= 0.06) out.push({ side: s, s0: start, s1: f - 1 }); start = -1; }
    }
  }
  return out;
}

/** Two-bone IK of a leg (world rotations / positions in place): the ankle to `target`, the foot turned to `rot`. */
function legIK(wq, wp, s, target, rot) {
  const t = IDX.get('thigh_' + s), c = IDX.get('calf_' + s), ft = IDX.get('foot_' + s);
  const A = wp[t], B = wp[c], C = wp[ft];
  const la = M.dist(A, B), lb = M.dist(B, C), D = M.sub(target, A);
  const d = Math.min((la + lb) * 0.9995, Math.max(Math.abs(la - lb) + 1e-3, M.len(D)));
  const u = M.norm(D, M.norm(M.sub(C, A))), T = M.add(A, M.scl(u, d));
  const bend = M.norm(M.ortho(M.sub(B, A), u), M.norm(M.ortho(M.xdir([0, 0, 1], M.fromQuat(wq[t])), u)));
  const x = (la * la - lb * lb + d * d) / (2 * d), y = Math.sqrt(Math.max(0, la * la - x * x));
  const K = M.add(A, M.add(M.scl(u, x), M.scl(bend, y)));
  const qt = qnorm(qm(wq[t], M.toQuat(M.fromTo(M.norm(M.sub(B, A)), M.norm(M.sub(K, A))))));
  // the calf follows the thigh, then turns to the ankle
  const lc = qm(wq[c], qinv(wq[t])), tl = M.xdir(M.sub(B, A), M.transpose3(M.fromQuat(wq[t])));
  const tf = M.xdir(M.sub(C, B), M.transpose3(M.fromQuat(wq[c])));
  let qc = qnorm(qm(lc, qt));
  const B1 = M.add(A, M.xdir(tl, M.fromQuat(qt))), C1 = M.add(B1, M.xdir(tf, M.fromQuat(qc)));
  qc = qnorm(qm(qc, M.toQuat(M.fromTo(M.norm(M.sub(C1, B1)), M.norm(M.sub(T, B1))))));
  wq[t] = qt; wq[c] = qc; wp[c] = B1; wp[ft] = M.add(B1, M.xdir(tf, M.fromQuat(qc)));
  wq[ft] = rot;
}

// ---------------------------------------------------------------- the whole
/**
 * Stylize baked frames.  rig: ControlRig, fitter: RigFitter, frames: pose vectors, fps.
 * opts: STYLE_DEFAULTS overrides, plus anchors: frames that must stay where they are (the keys), limit(v): a
 * last check of each output pose (joint ranges).  A generator: it yields between frames (so a page can share
 * the time); the return value is {frames, times, report}.  stylize() runs it through.
 */
export function* stylizeSteps(rig, fitter, frames, fps, opts = {}) {
  const o = { ...STYLE_DEFAULTS, ...opts }, n = frames.length, F = x => x * fps / 60, k = o.strength;
  if (n < 4) return { frames: frames.map(v => v.slice()), times: Float64Array.from(frames, (_, i) => i), report: { strikes: 0 } };
  const sc = rig.scale, held = rig.getVector();
  // the skeleton of every frame (positions in cm)
  const Q = [], T = [], P0 = [];
  for (let f = 0; f < n; f++) {
    rig.setVector(frames[f]).evaluate();
    const wq = [], wp = [];
    for (const name of NAMES) { const m = rig.jointWorld(name); wq.push(M.toQuat(M.rotation(m))); wp.push(M.scl(M.pos(m), 1 / sc)); }
    const l = locals(wq, wp);
    Q.push(l.Q); T.push(l.T);
    P0.push(Object.fromEntries(NAMES.map((name, j) => [name, wp[j]])));
    if (f % 30 === 29) yield;
  }
  const an = analyse(P0, fps, o);
  // 1-3: poses
  poseEmphasis(Q, an.keyPoses, o.poseAmp * k, o.poseSigma * fps);
  yield;
  cartoon(Q, T, o.cartoon * k, o.cartoonSigma * fps);
  yield;
  steady(Q, an.strikes, Math.min(1, o.steady * k), o.steadySigma * fps, F);
  yield;
  // 4: time
  const sm = blur(an.body, 0.05 * fps), sorted = Float64Array.from(sm).sort(), med = sorted[Math.floor(n / 2)];
  const rate = Float64Array.from(sm, b => (med > 1 ? Math.min(4, Math.max(0.35, (Math.max(b, 1e-6) / med) ** (o.contrast * k))) : 1));
  const holds = [];
  for (const s of an.strikes) { for (let f = s.a0; f <= s.a1; f++) rate[f] *= o.strikeSpeed; holds.push({ at: s.a1, len: F(o.strikeHoldF) }); }
  for (const p of an.keyPoses) if (p > 0 && p < n - 1) holds.push({ at: p, len: F(o.keyHoldF) });
  const anchors = [...new Set([...an.actionPeaks, ...(o.anchors || []).filter(f => f >= 0 && f < n)])].sort((a, b) => a - b);
  // (anchors closer than 2 frames: the first one)
  const anch = anchors.filter((f, i) => i === 0 || f === n - 1 || f - anchors[i - 1] >= 2);
  if (anch[anch.length - 2] > n - 3 && anch.length > 2) anch.splice(anch.length - 2, 1);
  const times = lockedWarp(n, rate, anch, holds);
  // the output: the poses at those times
  const steps = rig.channelStep || [];
  const oq = [], ot = [], base = [];
  for (let f = 0; f < n; f++) {
    const s = times[f], i = Math.min(n - 2, Math.floor(s)), t = s - i;
    oq.push(Q[i].map((q, j) => M.qslerp(q, Q[i + 1][j], t)));
    ot.push(T[i].map((p, j) => M.lerp(p, T[i + 1][j], t)));
    base.push(frames[i].map((x, c) => (steps[c] ? (t < 0.5 ? x : frames[i + 1][c]) : x + (frames[i + 1][c] - x) * t)));
  }
  yield;
  // 5: the striking limb stays where it struck (relative to the hips) for a moment, then goes back
  let W = oq.map((q, f) => fk(q, ot[f]));
  const an2 = analyse(W.map(w => Object.fromEntries(NAMES.map((name, j) => [name, w.wp[j]]))), fps, o);
  const hold = Math.round(F(o.limbHoldF)), back = Math.max(1, Math.round(F(o.limbBlendF)));
  if (hold > 0) {
    for (const s of an2.strikes) {
      const chain = CHAIN[s.limb].map(j => IDX.get(j)), at = s.a1;
      for (let f = at + 1; f <= Math.min(n - 1, at + hold + back); f++) {
        const w = f <= at + hold ? 1 : 1 - (f - at - hold) / back;
        for (const j of chain) oq[f][j] = M.qslerp(oq[f][j], oq[at][j], w);
      }
    }
    W = oq.map((q, f) => fk(q, ot[f]));
  }
  yield;
  // 6: the feet planted where the source plants them (last: after the holds)
  const plants = o.footLock ? contacts(P0, fps) : [];
  const slip = { before: 0, after: 0, frames: 0 };
  const blend = Math.max(1, Math.round(F(o.footBlendF)));
  const slipOf = key => { for (const c of plants) { const ft = IDX.get('foot_' + c.side); for (let f = 1; f < n; f++) if (times[f] >= c.s0 && times[f] <= c.s1 && times[f - 1] >= c.s0) { slip[key] += M.dist(W[f].wp[ft], W[f - 1].wp[ft]) * fps; if (key === 'after') slip.frames++; } } };
  slipOf('before');
  for (const c of plants) {
    const out = [];
    for (let f = 0; f < n; f++) if (times[f] >= c.s0 - 1e-6 && times[f] <= c.s1 + 1e-6) out.push(f);
    if (!out.length) continue;
    const a = out[0], b = out[out.length - 1], mid = out[Math.floor(out.length / 2)], ft = IDX.get('foot_' + c.side);
    const target = W[mid].wp[ft].slice(), rot = W[mid].wq[ft].slice();
    for (let f = Math.max(0, a - blend); f <= Math.min(n - 1, b + blend); f++) {
      const w = f < a ? 1 - (a - f) / (blend + 1) : f > b ? 1 - (f - b) / (blend + 1) : 1;
      const { wq, wp } = W[f];
      legIK(wq, wp, c.side, M.lerp(wp[ft], target, w), M.qslerp(wq[ft], rot, w));
    }
  }
  // (back to locals: the leg joints were set in world space)
  for (let f = 0; f < n; f++) {
    const l = locals(W[f].wq, W[f].wp);
    // the ball hangs on the foot: its local turn as before
    for (const s of SIDES) { const b = IDX.get('ball_' + s); l.Q[b] = oq[f][b]; l.T[b] = ot[f][b]; }
    W[f] = fk(l.Q, l.T);
  }
  slipOf('after');
  yield;
  // back on the rig
  const out = [];
  for (let f = 0; f < n; f++) {
    const Tm = {};
    NAMES.forEach((name, j) => { Tm[name] = M.compose(M.fromQuat(W[f].wq[j]), M.scl(W[f].wp[j], sc)); });
    rig.setVector(base[f]).evaluate();
    fitter.fit(Tm);
    let v = rig.getVector();
    if (o.limit) v = o.limit(v);
    out.push(v);
    if (f % 8 === 7) yield;
  }
  rig.setVector(held).evaluate();
  const report = {
    strikes: an.strikes.length, keyPoses: an.keyPoses.length, anchors: anch.length, contacts: plants.length,
    anchorError: Math.max(0, ...anch.map(a => Math.abs(times[a] - a))),
    footSlipBefore: slip.frames ? slip.before / slip.frames : 0, footSlip: slip.frames ? slip.after / slip.frames : 0, vmax: an.vmax,
  };
  return { frames: out, times, report };
}

export function stylize(rig, fitter, frames, fps, opts) {
  const it = stylizeSteps(rig, fitter, frames, fps, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
