// 4x4 matrices in Maya's convention: 16 numbers, row major, ROW VECTORS
// (world = local * parent, translation in elements 12..14).
// The same 16 numbers are a column-major matrix for three.js (Matrix4.fromArray).
// Rotations are 3x3 in the same convention, stored in the upper-left of a 16 array.

export const DEG = Math.PI / 180;

export const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a, b, out = new Array(16)) {
  const r = out === a || out === b ? new Array(16) : out;
  for (let i = 0; i < 4; i++) {
    const a0 = a[i * 4], a1 = a[i * 4 + 1], a2 = a[i * 4 + 2], a3 = a[i * 4 + 3];
    r[i * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8] + a3 * b[12];
    r[i * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9] + a3 * b[13];
    r[i * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10] + a3 * b[14];
    r[i * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3 * b[15];
  }
  if (r !== out) for (let i = 0; i < 16; i++) out[i] = r[i];
  return out;
}

/** Inverse of an affine matrix (any 3x3 part, including mirrored). */
export function inv(m, out = new Array(16)) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], k = m[10];
  const A = e * k - f * h, B = f * g - d * k, C = d * h - e * g;
  const det = a * A + b * B + c * C, s = 1 / det;
  const r0 = A * s, r1 = (c * h - b * k) * s, r2 = (b * f - c * e) * s;
  const r4 = B * s, r5 = (a * k - c * g) * s, r6 = (c * d - a * f) * s;
  const r8 = C * s, r9 = (b * g - a * h) * s, r10 = (a * e - b * d) * s;
  const x = m[12], y = m[13], z = m[14];
  out[0] = r0; out[1] = r1; out[2] = r2; out[3] = 0;
  out[4] = r4; out[5] = r5; out[6] = r6; out[7] = 0;
  out[8] = r8; out[9] = r9; out[10] = r10; out[11] = 0;
  out[12] = -(x * r0 + y * r4 + z * r8);
  out[13] = -(x * r1 + y * r5 + z * r9);
  out[14] = -(x * r2 + y * r6 + z * r10);
  out[15] = 1;
  return out;
}

export const det3 = m => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);

export const pos = m => [m[12], m[13], m[14]];

/** point * matrix */
export const xpoint = (p, m) => [
  p[0] * m[0] + p[1] * m[4] + p[2] * m[8] + m[12],
  p[0] * m[1] + p[1] * m[5] + p[2] * m[9] + m[13],
  p[0] * m[2] + p[1] * m[6] + p[2] * m[10] + m[14]];

/** direction * matrix (no translation) */
export const xdir = (p, m) => [
  p[0] * m[0] + p[1] * m[4] + p[2] * m[8],
  p[0] * m[1] + p[1] * m[5] + p[2] * m[9],
  p[0] * m[2] + p[1] * m[6] + p[2] * m[10]];

// --- vectors -----------------------------------------------------------
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const norm = (a, fb = [1, 0, 0]) => { const l = len(a); return l < 1e-12 ? fb.slice() : [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** component of v perpendicular to the unit axis */
export const ortho = (v, axis) => sub(v, scl(axis, dot(v, axis)));

// --- rotations ---------------------------------------------------------
/** Rotation from three row axes. */
export const fromRows = (x, y, z, t) => [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, t ? t[0] : 0, t ? t[1] : 0, t ? t[2] : 0, 1];
export const row = (m, i) => [m[i * 4], m[i * 4 + 1], m[i * 4 + 2]];

export function rotAxis(axisIndex, deg) {
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  if (axisIndex === 0) return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axisIndex === 1) return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Euler (degrees) to rotation. order 'xyz' = Rx * Ry * Rz (rotate about X first). */
export function euler(v, order = 'xyz') {
  let m = null;
  for (const ch of order) {
    const i = ch === 'x' ? 0 : ch === 'y' ? 1 : 2;
    if (v[i] === 0) continue;
    const r = rotAxis(i, v[i]);
    m = m ? mul(m, r) : r;
  }
  return m || ident();
}

/** Rotation to Euler (degrees) for any of the six orders. */
export function toEuler(m, order = 'xyz') {
  const i = 'xyz'.indexOf(order[0]), j = 'xyz'.indexOf(order[1]), k = 'xyz'.indexOf(order[2]);
  const sign = (j - i + 3) % 3 === 1 ? 1 : -1; // even permutation
  const e = (r, c) => m[r * 4 + c];
  const out = [0, 0, 0];
  const sj = -sign * e(i, k);
  const cj = Math.hypot(e(i, i), e(i, j));
  if (cj > 1e-9) {
    out[i] = Math.atan2(sign * e(j, k), e(k, k)) / DEG;
    out[j] = Math.atan2(sj, cj) / DEG;
    out[k] = Math.atan2(sign * e(i, j), e(i, i)) / DEG;
  } else {
    out[i] = Math.atan2(-sign * e(k, j), e(j, j)) / DEG;
    out[j] = Math.atan2(sj, cj) / DEG;
    out[k] = 0;
  }
  return out;
}

/** Rotation about a unit axis by an angle in radians (row vectors). */
export function axisAngle(n, a) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c, x = n[0], y = n[1], z = n[2];
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}

/** 3x3 part only, transposed (= inverse of a rotation). */
export const transpose3 = m => [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
export const rotOnly = m => [m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1];

/** Orthonormal rotation of a matrix that may hold scale; a mirrored matrix gets its Z row flipped. */
export function rotation(m) {
  let x = norm(row(m, 0)), y = norm(row(m, 1)), z = norm(row(m, 2));
  if (dot(cross(x, y), z) < 0) z = scl(z, -1);
  return fromRows(x, y, z);
}

/** Quaternion [x,y,z,w] of a rotation; Rx(a) -> (sin a/2, 0, 0, cos a/2). */
export function toQuat(m) {
  const m00 = m[0], m11 = m[5], m22 = m[10], tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m[6] - m[9]) / s; x = s / 4; y = (m[1] + m[4]) / s; z = (m[8] + m[2]) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m[8] - m[2]) / s; x = (m[1] + m[4]) / s; y = s / 4; z = (m[6] + m[9]) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[6] + m[9]) / s; z = s / 4;
  }
  return [x, y, z, w];
}

export function fromQuat(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const x = q[0] / l, y = q[1] / l, z = q[2] / l, w = q[3] / l;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
}

export function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let s = 1;
  if (d < 0) { d = -d; s = -1; }
  let ka, kb;
  if (d > 0.9995) { ka = 1 - t; kb = t; } else {
    const th = Math.acos(d), sn = Math.sin(th);
    ka = Math.sin((1 - t) * th) / sn; kb = Math.sin(t * th) / sn;
  }
  kb *= s;
  const q = [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb, a[3] * ka + b[3] * kb];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Shortest-arc blend of two rotations. */
export const rslerp = (a, b, t) => fromQuat(qslerp(toQuat(a), toQuat(b), t));

/** Weighted blend of rotations (successive slerp). */
export function blendRot(mats, weights) {
  let q = toQuat(mats[0]), acc = weights[0];
  for (let i = 1; i < mats.length; i++) {
    if (weights[i] <= 0) continue;
    acc += weights[i];
    q = qslerp(q, toQuat(mats[i]), weights[i] / acc);
  }
  return fromQuat(q);
}

/** Smallest rotation that takes unit vector a to unit vector b. */
export function fromTo(a, b) {
  const c = cross(a, b), d = dot(a, b), l = len(c);
  if (l < 1e-10) {
    if (d > 0) return ident();
    const p = norm(ortho(Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], a));
    return axisAngle(p, Math.PI);
  }
  return axisAngle(scl(c, 1 / l), Math.atan2(l, d));
}

export const setPos = (m, p) => { m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
export const compose = (r, t) => [r[0], r[1], r[2], 0, r[4], r[5], r[6], 0, r[8], r[9], r[10], 0, t[0], t[1], t[2], 1];
