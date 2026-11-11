// Pictures for judging motion without a viewer: a strip of stick figures (every few frames, seen from the
// front-left, each centred on the hips) and a heat map of what src/evaluate.js measures per frame.
// Runs in the page; the images are posted to the local server (eval_out/).
import * as M from '../src/m4.js';
import { SERIES, badness } from '../src/evaluate.js';

const CHAIN = [['pelvis', 'spine_03', 'spine_05', 'neck_01', 'head']];
const SIDE = s => [['clavicle_' + s, 'upperarm_' + s, 'lowerarm_' + s, 'hand_' + s], ['pelvis', 'thigh_' + s, 'calf_' + s, 'foot_' + s, 'ball_' + s]];
const TW = 92, TH = 150, SCALE = 0.62, LABEL = 16;

/** Joint positions of a pose vector. */
function joints(rig, v) {
  rig.setVector(v).evaluate();
  const P = {};
  for (const n of ['pelvis', 'spine_03', 'spine_05', 'neck_01', 'head', ...'lr'.split('').flatMap(s => SIDE(s).flat())]) P[n] = M.pos(rig.jointWorld(n));
  return P;
}

const SOMA = { pelvis: 'Hips', spine_03: 'Spine2', spine_05: 'Chest', neck_01: 'Neck1', head: 'Head' };
for (const [s, w] of [['l', 'Left'], ['r', 'Right']]) Object.assign(SOMA, { ['clavicle_' + s]: w + 'Shoulder', ['upperarm_' + s]: w + 'Arm', ['lowerarm_' + s]: w + 'ForeArm', ['hand_' + s]: w + 'Hand', ['thigh_' + s]: w + 'Leg', ['calf_' + s]: w + 'Shin', ['foot_' + s]: w + 'Foot', ['ball_' + s]: w + 'ToeBase' });

/** The same joints of a SOMA pose (metres -> cm), to draw the model's motion before it is put on the rig. */
export function somaPoints(soma, pose) {
  const W = soma.positions(pose), P = {};
  for (const [n, s] of Object.entries(SOMA)) P[n] = W[soma.index[s]].map(x => x * 100);
  return P;
}
export function somaFloor(soma) {
  const a = soma.restPos[soma.index.LeftFoot][1] * 100, b = soma.restPos[soma.index.LeftToeBase][1] * 100;
  return { foot_l: a, foot_r: a, ball_l: b, ball_r: b };
}

function figure(g, P, ox, oy, yaw, floor) {
  const c = Math.cos(yaw), s = Math.sin(yaw), hip = P.pelvis;
  const pt = n => { const x = P[n][0] - hip[0], z = P[n][2] - hip[2]; return [ox + (x * c + z * s) * SCALE, oy - P[n][1] * SCALE, -x * s + z * c]; };
  const line = (names, colour, w) => {
    g.strokeStyle = colour; g.lineWidth = w; g.lineJoin = g.lineCap = 'round';
    g.beginPath(); names.forEach((n, i) => { const p = pt(n); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.stroke();
  };
  g.strokeStyle = '#999'; g.lineWidth = 1; g.beginPath(); g.moveTo(ox - TW / 2 + 4, oy); g.lineTo(ox + TW / 2 - 4, oy); g.stroke();
  // the far side first
  const depth = side => pt('upperarm_' + side)[2];
  const order = depth('l') > depth('r') ? ['l', 'r'] : ['r', 'l'];
  const col = { l: '#1f6fe0', r: '#e03030' };
  SIDE(order[0]).forEach(ch => line(ch, col[order[0]], 2.4));
  CHAIN.forEach(ch => line(ch, '#222', 3));
  const h = pt('head'); g.fillStyle = '#222'; g.beginPath(); g.arc(h[0], h[1] - 5, 5, 0, 7); g.fill();
  SIDE(order[1]).forEach(ch => line(ch, col[order[1]], 2.4));
  // a mark under a foot that stands on the floor
  for (const side of 'lr') {
    if (P['foot_' + side][1] - floor['foot_' + side] < 1.5 && P['ball_' + side][1] - floor['ball_' + side] < 1.5) {
      const p = pt('foot_' + side); g.fillStyle = col[side]; g.fillRect(p[0] - 5, oy + 2, 10, 3);
    }
  }
}

/**
 * rows: [{label, frames: [pose vector], keys: [frame], bad: Float32Array|null}] -> a canvas.
 * Every row shows `per` figures at most (evenly spaced, the keys always among them).
 */
export function strip(rig, floor, rows, { per = 22, yaw = -0.6, title = '', shot = null } = {}) {
  const held = rig.getVector();
  // (with `shot` - app.shot - the tiles show the character's mesh instead of a stick figure)
  const W = shot ? 124 : TW, H = shot ? 196 : TH;
  if (shot) per = Math.min(per, 20);
  const lay = rows.map(r => {
    const n = (r.points || r.frames).length, step = Math.max(1, Math.ceil((n - 1) / (per - 1)));
    const pick = new Set(r.keys);
    for (let f = 0; f < n; f += step) pick.add(f);
    pick.add(n - 1);
    return { ...r, shown: [...pick].filter(f => f < n).sort((a, b) => a - b) };
  });
  const cols = Math.max(...lay.map(r => r.shown.length));
  const cv = document.createElement('canvas');
  cv.width = cols * W + 8; cv.height = (title ? 22 : 0) + lay.length * (H + LABEL + 6) + 4;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.font = '12px sans-serif'; g.textBaseline = 'top';
  let y = 2;
  if (title) { g.fillStyle = '#000'; g.font = 'bold 14px sans-serif'; g.fillText(title, 6, y); y += 20; g.font = '12px sans-serif'; }
  for (const r of lay) {
    g.fillStyle = '#000'; g.fillText(r.label, 6, y); y += LABEL;
    r.shown.forEach((f, i) => {
      const x = 4 + i * W, key = r.keys.includes(f);
      const P = r.points ? r.points[f] : joints(rig, r.frames[f]);
      // (side: seen from the character's own right side, whichever way it faces - forward is to the right)
      const facing = Math.atan2(P.thigh_r[2] - P.thigh_l[2], -(P.thigh_r[0] - P.thigh_l[0]));
      if (shot && r.frames) {
        // the camera stands in front-left of the character, or at its right side
        shot(g, r.frames[f], x + 1, y, W - 2, H, r.side ? facing - Math.PI / 2 : r.front ? facing : r.yaw !== undefined ? facing + r.yaw : facing + 0.6);
        if (key) { g.strokeStyle = '#ffd400'; g.lineWidth = 4; g.strokeRect(x + 3, y + 2, W - 6, H - 4); }
        // a mark under a foot that stands on the floor
        const off = { l: r.side ? 0 : 10, r: r.side ? 0 : -10 };
        for (const side of 'lr') if (P['foot_' + side][1] - floor['foot_' + side] < 1.5 && P['ball_' + side][1] - floor['ball_' + side] < 1.5) { g.fillStyle = side === 'l' ? '#1f6fe0' : '#e03030'; g.fillRect(x + W / 2 + off[side] - 8 + (side === 'l' ? 8 : -8), y + H - 6, 14, 4); }
      } else {
        g.fillStyle = key ? '#fff3b0' : '#f4f4f4'; g.fillRect(x + 1, y, W - 2, H);
        figure(g, P, x + W / 2, y + H - 12, r.side ? Math.PI / 2 - facing : r.yaw ?? yaw, floor);
      }
      if (r.bad && r.bad[f] > 0.05) { g.fillStyle = `rgba(230,40,40,${0.25 + 0.75 * r.bad[f]})`; g.fillRect(x + 1, y, W - 2, 5); }
      g.fillStyle = shot ? '#fff' : '#444'; g.fillText(String(f), x + 6, y + 8);
      if (r.points) { g.fillStyle = '#888'; g.fillText(`${r.points[f].pelvis[0].toFixed(0)},${r.points[f].pelvis[2].toFixed(0)}`, x + 30, y + 7); }
    });
    y += H + 6;
  }
  rig.setVector(held).evaluate();
  return cv;
}

/** blocks: [{label, metrics}] (metrics from Evaluator.measure) -> a canvas: one line per series, one cell per frame. */
export function heatmap(blocks, { cell = 6, rowH = 9, left = 150 } = {}) {
  const names = Object.keys(SERIES), frames = Math.max(...blocks.map(b => b.metrics.frames));
  const bh = 16 + names.length * rowH + 6;
  const cv = document.createElement('canvas');
  cv.width = left + frames * cell + 60; cv.height = blocks.length * bh + 20;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.textBaseline = 'top';
  blocks.forEach((b, i) => {
    let y = 4 + i * bh;
    g.fillStyle = '#000'; g.font = 'bold 12px sans-serif'; g.fillText(b.label, 4, y); y += 15;
    g.font = '9px sans-serif';
    names.forEach((name, r) => {
      const s = b.metrics.series[name];
      g.fillStyle = '#555'; g.fillText(SERIES[name][0], 4, y + r * rowH);
      let worst = 0;
      for (let f = 0; f < s.length; f++) {
        const t = badness(name, s[f]); worst = Math.max(worst, s[f]);
        g.fillStyle = t <= 0 ? '#e9f3e9' : `hsl(${55 - 55 * t},95%,${62 - 14 * t}%)`;
        g.fillRect(left + f * cell, y + r * rowH, cell - 1, rowH - 1);
      }
      g.fillStyle = '#555'; g.fillText(worst.toFixed(0), left + s.length * cell + 4, y + r * rowH);
    });
    for (const k of b.keys || []) { g.fillStyle = '#000'; g.fillRect(left + k * cell + cell / 2 - 1, y - 2, 1, names.length * rowH + 3); }
  });
  return cv;
}

export async function savePng(cv, name) {
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  await fetch('/save/' + name, { method: 'POST', body: blob });
}
