// SOMA Anim: pose-to-pose animation on UE5 Manny with a BNS style rig.
import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as M from './m4.js';
import { BnsRig } from './rig.js';
import { SomaRig, MotionDB } from './motiondb.js';
import { SomaToManny } from './retarget.js';
import { RigFitter } from './fit.js';
import { Naturalizer } from './natural.js';
import { Inbetweener } from './inbetween.js';
import { Project, newScene } from './project.js';
import { MotionBricks } from './motionbricks.js';
import { loadState, saveState } from './store.js';
import { FootReset, FOOT_CONTROLS } from './feet.js';
import { writeFbx } from './fbx.js';
import { loadManny, makeMannequin } from './character.js';
import { Timeline } from './timeline.js';

const $ = id => document.getElementById(id);
// cache busters: the commit for what changes with the code, a data version for the 20 MB motion database
const VERSION = window.SOMA_ANIM_VERSION || 'dev', DB_VERSION = '1';
const asset = p => (VERSION === 'dev' ? p : `${p}?v=${VERSION}`);
const status = t => { $('status').textContent = t; };
/** The wait screen: text and progress 0..1 (null = unknown); wait(null) takes it away. */
function wait(text, part = null, canSkip = false) {
  $('loading').hidden = text === null;
  if (text === null) return;
  $('loadText').textContent = text;
  $('loadBar').style.width = part === null ? '100%' : Math.round(part * 100) + '%';
  $('loadBar').style.opacity = part === null ? 0.35 : 1;
  $('loadSkip').hidden = !canSkip;
}
const FOOT_PINS = ['L_Foot_trans', 'R_Foot_trans', 'L_Foot_rot', 'R_Foot_rot', 'L_Toe_rot', 'R_Toe_rot'];
const LABEL = {
  world_ctl: '全身', Hip_trans: '腰', Hip2_rot: '腰の向き', Spine_trans: '胸', Spine_rot: '胸のひねり', Neck_rot: '首', Head_rot: '頭の傾き', Head_trans: '視線',
  Shoulder_rot: '肩', elbow_pv: '肘の向き', Hand_trans: '手', Hand_rot: '手首', knee_pv: '膝の向き', Foot_trans: '足', Foot_rot: '足首', Toe_rot: 'つま先',
};
const label = n => { const m = n.match(/^([LR])_(.+)$/); const base = m ? m[2] : n; return LABEL[base] ? `${m ? (m[1] === 'L' ? '左' : '右') : ''}${LABEL[base]}` : n; };

// ---------------------------------------------------------------- scene
const canvas = $('gl');
const renderer = new T.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
const scene = new T.Scene();
scene.background = new T.Color(0x1b1d21);
const camera = new T.PerspectiveCamera(35, 1, 5, 5000);
camera.position.set(260, 150, 330);
const orbit = new OrbitControls(camera, canvas);
orbit.target.set(0, 95, 0);
orbit.update();
scene.add(new T.HemisphereLight(0xdde6f5, 0x30343a, 1.5));
const sun = new T.DirectionalLight(0xffffff, 2.2);
sun.position.set(150, 320, 200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 10, far: 900 });
scene.add(sun);
const floor = new T.Mesh(new T.PlaneGeometry(4000, 4000), new T.ShadowMaterial({ opacity: 0.35 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new T.GridHelper(1000, 20, 0x4a515c, 0x2c3037);
scene.add(grid);

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
  dirty = true;
}
let dirty = true;
new ResizeObserver(resize).observe(canvas.parentElement);
orbit.addEventListener('change', () => { dirty = true; });

// ---------------------------------------------------------------- state
let rig, project, character, nat = null, inb = null, mb = null, timeline, footReset;
let frame = 0, selected = null, playing = false, clipboard = null;
let working = null; // pose being edited (not yet a key)
const ctlView = new Map();
const proxy = new T.Object3D();
scene.add(proxy);
const gizmo = new TransformControls(camera, canvas);
gizmo.setSize(0.8);
scene.add(gizmo.getHelper());
const ghosts = [0x4fb0ff, 0xffa24a].map(color => {
  const l = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ color, transparent: true, opacity: 0.45, depthTest: false }));
  l.renderOrder = 5; l.frustumCulled = false; scene.add(l);
  return l;
});

const COLORS = { L: 0x4f9dff, R: 0xff5d5d, C: 0xffd24a };
const colorOf = c => (c.group === 'world' ? 0xc79bff : COLORS[c.side] ?? 0xffffff);

function buildControls() {
  for (const c of rig.controls) {
    const g = new T.Group();
    g.matrixAutoUpdate = false;
    const mat = new T.LineBasicMaterial({ color: colorOf(c), depthTest: false, transparent: true, opacity: 0.9 });
    for (const s of c.shapes) {
      const pts = s.cvs_local.flat();
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      const line = s.form === 'periodic' ? new T.LineLoop(geo, mat) : new T.Line(geo, mat);
      line.renderOrder = 10; line.frustumCulled = false;
      g.add(line);
    }
    scene.add(g);
    ctlView.set(c.name, { g, mat, c, cvs: c.shapes.map(s => s.cvs_local) });
  }
}

function refreshControlLook() {
  const key = project.keyAt(frame);
  const pins = key ? key.pins : new Set();
  for (const [name, v] of ctlView) {
    const finger = v.c.group === 'finger';
    v.g.visible = $('showCtl').checked && (!finger || $('showFinger').checked);
    v.mat.color.setHex(name === selected ? 0xffffff : pins.has(name) ? 0x6fe3a0 : colorOf(v.c));
    v.mat.opacity = name === selected ? 1 : 0.85;
  }
}

/** Everything that follows the rig. */
function syncView() {
  character?.userData.update(rig);
  for (const [name, v] of ctlView) v.g.matrix.fromArray(rig.controlWorld(name));
  dirty = true;
}

function syncProxy() {
  if (!selected) return;
  const w = rig.controlWorld(selected);
  proxy.position.set(w[12], w[13], w[14]);
  proxy.quaternion.setFromRotationMatrix(new T.Matrix4().fromArray(M.rotation(w)));
  proxy.updateMatrixWorld(true);
}

// ---------------------------------------------------------------- pose flow
/** The pose shown at the current frame. */
function currentPose() { return working ?? project.pose(frame); }

function showFrame(f, keepWorking = false) {
  frame = Math.max(0, Math.min(project.length, Math.round(f)));
  if (!keepWorking) working = null;
  rig.setVector(currentPose()).evaluate();
  syncView(); syncProxy(); refreshPanel(); refreshGhosts();
  $('frame').value = frame;
  timeline.draw();
}

function rebake() {
  project.bake(inb, mb);
  save();
  refreshGhosts();
  if (project.todo.length) {
    status('MotionBricks が中割りを生成中…');
    project.fill(inb, mb, error => {
      // (a stretch landed: show it, unless the animator is in the middle of a drag)
      if (gizmo.dragging) timeline.draw(); else showFrame(frame, !!working);
      if (error) status('MotionBricks の生成に失敗しました（その区間は単純な補間）: ' + error);
      else if (!project.todo.length) status(mbLine());
    });
  }
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState('project', project.toJSON()), 300);
}

const mbLine = () => (mb && mb.state === 'ready' ? `MotionBricks: ${mb.backend}` : '');

/**
 * Start MotionBricks when the in-betweens ask for it, and keep the animator waiting until it is there (what is
 * made before that would be made again).  The model (about 380 MB) is downloaded once and kept in IndexedDB.
 */
function wantMotionBricks() {
  if (!inb || project.mode !== 'mb') { wait(null); return; }
  if (!mb) mb = new MotionBricks(inb);
  if (mb.state !== 'idle') { if (mb.state !== 'loading') wait(null); return; }
  const mbytes = x => (x / 1048576).toFixed(0);
  let skipped = false;
  $('loadSkip').onclick = () => { skipped = true; wait(null); };
  const show = (text, part, canSkip) => { status(text); if (!skipped) wait(text, part, canSkip); };
  show('MotionBricks を準備中…', null, false);
  mb.load(p => {
    if (p.phase === 'download') show(`MotionBricks のモデルを取得中… ${mbytes(p.loaded)}${p.total ? ' / ' + mbytes(p.total) : ''} MB（初回だけ）`, p.total ? p.loaded / p.total : null, true);
    else if (p.phase === 'cache') show('MotionBricks のモデルを読み込み中…（保存済みのものを使用）', null, false);
    else if (p.phase === 'session') show('MotionBricks を準備中…', null, false);
  }).then(() => { wait(null); status(mbLine()); rebake(); if (!gizmo.dragging && !working) showFrame(frame); })
    .catch(e => { console.error(e); wait(null); status('MotionBricks を使えませんでした（単純な補間で中割りします）: ' + e.message); });
}

function effectivePins(key) {
  const p = new Set(key.pins);
  if ($('lockFeet').checked) for (const n of FOOT_PINS) p.add(n);
  return p;
}

/** The rig holds an edited pose: make it the key of this frame. */
function commit(touched, { natural = $('auto').checked } = {}) {
  project.pushUndo();
  const key = project.setKey(frame, rig.getVector());
  for (const n of touched) key.pins.add(n);
  if (natural && nat) {
    const r = nat.naturalize(key.v, effectivePins(key), +$('strength').value);
    key.v = r.vector;
    showMatch(r.match);
  }
  working = null;
  rebake();
  showFrame(frame);
}

function showMatch(m) {
  $('match').textContent = m ? `参考: ${m.clip} f${m.frame}${m.mirrored ? '（反転）' : ''}` : '';
}

function naturalizeNow() {
  if (!nat) return;
  project.pushUndo();
  const key = project.setKey(frame, currentPose());
  const r = nat.naturalize(key.v, effectivePins(key), 1);
  key.v = r.vector;
  showMatch(r.match);
  working = null;
  rebake(); showFrame(frame);
}

// ---------------------------------------------------------------- gizmo
function select(name) {
  selected = name && ctlView.has(name) ? name : null;
  if (!selected) { gizmo.detach(); $('gizmoMode').hidden = true; refreshPanel(); refreshControlLook(); dirty = true; return; }
  const c = rig.controlByName.get(selected);
  if (c.group === 'finger' && !$('showFinger').checked) { $('showFinger').checked = true; }
  syncProxy();
  gizmo.attach(proxy);
  // a control that only moves gets the arrows, one that only turns gets the rings;
  // one that does both (world_ctl) keeps the mode chosen last (W / E)
  setGizmoMode(c.hasT && c.hasR ? bothMode : c.hasT ? 'translate' : 'rotate');
  refreshPanel(); refreshControlLook();
  dirty = true;
}

let bothMode = 'translate';
function setGizmoMode(mode) {
  if (!selected) return;
  const c = rig.controlByName.get(selected);
  if (mode === 'translate' ? !c.hasT : !c.hasR) return;
  if (c.hasT && c.hasR) bothMode = mode;
  const tr = mode === 'translate', p = tr ? 't' : 'r';
  const n = c.channels.filter(ch => ch[0] === p).length;
  gizmo.setMode(mode);
  gizmo.setSpace(!tr || n < 3 ? 'local' : 'world');
  gizmo.showX = c.channels.includes(p + 'x'); gizmo.showY = c.channels.includes(p + 'y'); gizmo.showZ = c.channels.includes(p + 'z');
  syncProxy();
  const box = $('gizmoMode');
  box.hidden = !(c.hasT && c.hasR);
  $('modeMove').classList.toggle('on', tr); $('modeTurn').classList.toggle('on', !tr);
  dirty = true;
}

gizmo.addEventListener('dragging-changed', e => {
  orbit.enabled = !e.value;
  if (e.value) { working = rig.getVector(); moved = false; } else if (selected && moved) { commit([selected]); } else { working = null; }
});

let moved = false;
gizmo.addEventListener('objectChange', () => {
  if (!selected) return;
  moved = true;
  const c = rig.controlByName.get(selected), n = c.node;
  proxy.updateMatrixWorld(true);
  if (gizmo.mode === 'translate') {
    const t = M.sub(M.xpoint(proxy.position.toArray(), M.inv(n.parent.world)), n.restT);
    for (const ch of c.channels) if (ch[0] === 't') rig.set(selected + '.' + ch, t['xyz'.indexOf(ch[1])]);
  } else {
    const w = M.rotOnly(proxy.matrixWorld.elements);
    if (M.det3(n.world) < 0) { w[8] = -w[8]; w[9] = -w[9]; w[10] = -w[10]; }
    const l = M.rotation(M.mul(w, M.inv(M.rotOnly(n.parent.world))));
    const e = M.toEuler(l, n.order);
    for (const ch of c.channels) if (ch[0] === 'r') rig.set(selected + '.' + ch, e['xyz'.indexOf(ch[1])]);
  }
  rig.evaluate();
  working = rig.getVector();
  syncView(); refreshChannels();
});
gizmo.addEventListener('change', () => { dirty = true; });

// picking: the control whose curve passes nearest the pointer
let down = null;
canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || gizmo.dragging || gizmo.axis) { down = null; return; }
  down = null;
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const v = new T.Vector3();
  let best = null, bd = 10;
  for (const [name, view] of ctlView) {
    if (!view.g.visible) continue;
    const w = rig.controlWorld(name);
    for (const cvs of view.cvs) {
      const pts = cvs.map(p => { const q = M.xpoint(p, w); v.set(q[0], q[1], q[2]).project(camera); return v.z > 1 ? null : [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height]; });
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (!a || !b) continue;
        const d = segDist(mx, my, a, b);
        if (d < bd) { bd = d; best = name; }
      }
    }
  }
  select(best);
});
function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)) : 0;
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

// ---------------------------------------------------------------- panel
function refreshChannels() {
  if (!selected) return;
  for (const inp of $('channels').querySelectorAll('input')) if (document.activeElement !== inp) inp.value = (+rig.get(inp.dataset.key).toFixed(2));
}

function refreshPanel() {
  const key = project.keyAt(frame);
  $('selName').textContent = selected ? `${label(selected)}  (${selected})` : '（未選択：コントロールの線をクリック）';
  const box = $('channels');
  box.textContent = '';
  if (selected) {
    const c = rig.controlByName.get(selected);
    for (const ch of c.channels) {
      const l = document.createElement('span'); l.textContent = ch;
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = ch[0] === 't' ? 1 : 5; inp.dataset.key = selected + '.' + ch;
      inp.value = +rig.get(inp.dataset.key).toFixed(2);
      inp.addEventListener('change', () => { rig.set(inp.dataset.key, +inp.value || 0); rig.evaluate(); commit([selected]); });
      box.append(l, inp);
    }
  }
  const pins = $('pins');
  pins.textContent = '';
  if (key) for (const n of key.pins) {
    const s = document.createElement('span');
    s.className = 'chip'; s.textContent = label(n) + ' ×'; s.title = n + ' のピンを外す';
    s.onclick = () => { project.pushUndo(); key.pins.delete(n); rebake(); showFrame(frame); };
    pins.append(s);
  }
  for (const d of $('list').children) {
    d.classList.toggle('sel', d.dataset.name === selected);
    d.classList.toggle('pin', !!key && key.pins.has(d.dataset.name));
  }
  $('delKey').disabled = !key;
  $('addKey').classList.toggle('on', !!key);
  refreshControlLook();
}

function buildList() {
  const list = $('list');
  for (const c of rig.controls) {
    if (c.group === 'finger') continue;
    const d = document.createElement('div');
    d.dataset.name = c.name; d.textContent = label(c.name); d.title = c.name;
    d.onclick = () => select(c.name);
    list.append(d);
  }
}

// ---------------------------------------------------------------- ghosts
const BONES = [];
function refreshGhosts() {
  if (!rig) return;
  const prev = [...project.keys].reverse().find(k => k.frame < frame), next = project.keys.find(k => k.frame > frame);
  const saved = rig.getVector();
  [prev, next].forEach((k, i) => {
    const g = ghosts[i];
    g.visible = !!k && $('showGhost').checked && !playing;
    if (!g.visible) return;
    rig.setVector(k.v).evaluate();
    const pts = [];
    for (const [a, b] of BONES) { const p = rig.jointWorld(a), q = rig.jointWorld(b); pts.push(p[12], p[13], p[14], q[12], q[13], q[14]); }
    g.geometry.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
  });
  rig.setVector(saved).evaluate();
  dirty = true;
}

// ---------------------------------------------------------------- actions
const actions = {
  addKey() { project.pushUndo(); project.setKey(frame, currentPose()); working = null; rebake(); showFrame(frame); },
  delKey() { if (!project.keyAt(frame)) return; project.pushUndo(); project.removeKey(frame); rebake(); showFrame(frame); },
  copy() { const k = project.keyAt(frame); clipboard = { v: currentPose().slice(), pins: [...(k?.pins ?? [])] }; flash('copy'); },
  paste(mirror = false) {
    if (!clipboard) return;
    project.pushUndo();
    const v = keepPlace(mirror ? rig.mirrorVector(clipboard.v) : clipboard.v.slice());
    project.setKey(frame, v, clipboard.pins.map(n => (mirror ? rig.mirrorName(n) : n)));
    working = null; rebake(); showFrame(frame);
  },
  mirror() {
    project.pushUndo();
    const k = project.keyAt(frame);
    project.setKey(frame, keepPlace(rig.mirrorVector(currentPose())), [...(k?.pins ?? [])].map(n => rig.mirrorName(n)));
    working = null; rebake(); showFrame(frame);
  },
  undo() { if (project.undo()) { afterLoad(); wantMotionBricks(); } },
  redo() { if (project.redo()) { afterLoad(); wantMotionBricks(); } },
  play() { playing = !playing; $('play').textContent = playing ? '⏸' : '▶'; last = 0; acc = 0; refreshGhosts(); },
  prevKey() { const k = [...project.keys].reverse().find(k => k.frame < frame); showFrame(k ? k.frame : 0); },
  nextKey() { const k = project.keys.find(k => k.frame > frame); if (k) showFrame(k.frame); },
  resetSel() {
    if (!selected) return;
    for (const ch of rig.controlByName.get(selected).channels) rig.set(selected + '.' + ch, 0);
    rig.evaluate(); commit([selected], { natural: false });
  },
  resetAll() { project.pushUndo(); project.setKey(frame, keepPlace(project.zero()), []); working = null; rebake(); showFrame(frame); },
  unpin() { const k = project.keyAt(frame); if (!k) return; project.pushUndo(); k.pins.clear(); rebake(); showFrame(frame); },
};
/** A pose brought from elsewhere takes the place and facing (the whole-body control) of the frame it lands on. */
function keepPlace(v) {
  const here = currentPose();
  rig.channelKeys.forEach((k, i) => { if (k.startsWith('world_ctl.')) v[i] = here[i]; });
  return v;
}

/** Feet flat on the floor (this key, or every key). */
function resetFeet(all = false) {
  project.pushUndo();
  const keys = all ? project.keys : [project.setKey(frame, currentPose())];
  for (const k of keys) { k.v = footReset.apply(k.v); for (const n of FOOT_CONTROLS) k.pins.add(n); }
  working = null; rebake(); showFrame(frame);
  flash(all ? 'feetAll' : 'feet');
}

function flash(id) { const b = $(id); b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 250); }

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function bindUI() {
  for (const id of ['addKey', 'delKey', 'copy', 'mirror', 'undo', 'redo', 'play', 'prevKey', 'nextKey', 'resetSel', 'resetAll', 'unpin']) $(id).onclick = () => actions[id]();
  $('paste').onclick = () => actions.paste(false);
  $('pasteMirror').onclick = () => actions.paste(true);
  $('naturalize').onclick = naturalizeNow;
  $('modeMove').onclick = () => setGizmoMode('translate');
  $('modeTurn').onclick = () => setGizmoMode('rotate');
  $('pickWorld').onclick = () => select('world_ctl');
  $('first').onclick = () => showFrame(0);
  $('frame').onchange = e => showFrame(+e.target.value || 0);
  $('length').onchange = e => { project.pushUndo(); project.length = Math.max(10, Math.min(2000, +e.target.value || 90)); rebake(); showFrame(Math.min(frame, project.length)); };
  $('mode').onchange = e => { project.pushUndo(); project.mode = e.target.value; wantMotionBricks(); rebake(); showFrame(frame); };
  $('regen').onclick = regenerate;
  $('flow').onchange = e => { project.pushUndo(); project.flow = e.target.checked; rebake(); showFrame(frame); };
  $('newScene').onclick = () => { project.pushUndo(); newScene(project); select(null); frame = 0; afterLoad(); status('新しいシーンにしました（Ctrl+Z で前のシーンに戻せます）'); };
  $('strength').oninput = e => { $('strengthV').textContent = Math.round(e.target.value * 100) + '%'; };
  for (const id of ['showCtl', 'showFinger', 'showGhost']) $(id).onchange = () => { refreshControlLook(); refreshGhosts(); dirty = true; };
  $('showMesh').onchange = e => { if (character) character.visible = e.target.checked; dirty = true; };
  $('save').onclick = () => download('soma_anim_project.json', JSON.stringify(project.toJSON(), null, 1));
  $('export').onclick = () => download('soma_anim_bake.json', JSON.stringify(project.toBake()));
  $('exportFbx').onclick = () => { const text = writeFbx(rig, project.baked, project.fps); showFrame(frame, !!working); download('soma_anim.fbx', text); };
  $('feet').onclick = () => resetFeet(false);
  $('feetAll').onclick = () => resetFeet(true);
  $('load').onclick = () => $('file').click();
  $('file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { const d = JSON.parse(await f.text()); project.pushUndo(); project.fromJSON(d); afterLoad(); } catch (err) { alert('開けませんでした: ' + err.message); }
    e.target.value = '';
  };
  for (const b of document.querySelectorAll('[data-pick]')) b.onclick = () => {
    const names = rig.spec.selector_sets[b.dataset.pick];
    const i = names.indexOf(selected);
    select(names[(i + 1) % names.length]);
  };
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const run = f => { e.preventDefault(); f(); };
    if (k === ' ') run(actions.play);
    else if (mod && k === 'z') run(e.shiftKey ? actions.redo : actions.undo);
    else if (mod && k === 'y') run(actions.redo);
    else if (mod && k === 'c') run(actions.copy);
    else if (mod && k === 'v') run(() => actions.paste(e.shiftKey));
    else if (k === 'k') run(actions.addKey);
    else if (k === 'delete' || k === 'backspace') run(actions.delKey);
    else if (k === 'm') run(actions.mirror);
    else if (k === 'n') run(naturalizeNow);
    else if (k === 'r') run(regenerate);
    else if (k === 'g') run(() => resetFeet(false));
    else if (k === 'arrowleft') run(() => showFrame(frame - 1));
    else if (k === 'arrowright') run(() => showFrame(frame + 1));
    else if (k === ',') run(actions.prevKey);
    else if (k === '.') run(actions.nextKey);
    else if (k === 'w') run(() => setGizmoMode('translate'));
    else if (k === 'e') run(() => setGizmoMode('rotate'));
    else if (k === 'escape') run(() => select(null));
  });
}

/** Throw away the in-betweens and make them again (MotionBricks is asked afresh). */
function regenerate() {
  project.cache.clear(); project.tries.clear();
  rebake(); showFrame(frame, !!working);
  flash('regen');
}

function afterLoad() {
  $('length').value = project.length; $('mode').value = project.mode; $('flow').checked = project.flow;
  working = null; rebake(); showFrame(Math.min(frame, project.length));
}

// ---------------------------------------------------------------- loop
let last = 0, acc = 0;
function tick(t) {
  requestAnimationFrame(tick);
  if (playing) {
    if (last) acc += (t - last) / 1000;
    last = t;
    const step = Math.floor(acc * project.fps);
    if (step > 0) { acc -= step / project.fps; showFrame((frame + step) % (project.length + 1)); }
  }
  if (dirty) { dirty = false; renderer.render(scene, camera); }
}

// ---------------------------------------------------------------- start
async function start() {
  $('title').title = 'version ' + VERSION;
  const spec = await fetch(asset('assets/bns_rig.json')).then(r => r.json());
  rig = new BnsRig(spec);
  project = new Project(rig);
  footReset = new FootReset(rig);
  const skip = /^(ik_|interaction|center_of_mass)/;
  for (const j of rig.joints) if (rig.jointIndex.has(j.parent) && j.parent !== 'root' && !skip.test(j.name)) BONES.push([j.parent, j.name]);
  buildControls(); buildList();
  timeline = new Timeline($('timeline'), project, {
    frame: () => frame,
    seek: f => { if (playing) actions.play(); showFrame(f); },
    moved: () => { rebake(); showFrame(frame); },
    beforeMove: () => project.pushUndo(),
  });
  bindUI();
  try {
    const saved = await loadState('project');
    const old = saved ? null : localStorage.getItem('soma_anim.project'); // (earlier versions kept it in localStorage)
    if (saved) project.fromJSON(saved); else if (old) project.fromJSON(JSON.parse(old));
    // (scenes from before MotionBricks was the default were saved as motion matching: moved over once)
    if (!(await loadState('mbDefault'))) { project.mode = 'mb'; saveState('mbDefault', true); }
    localStorage.removeItem('soma_anim.project');
  } catch { /* start empty */ }
  if (!project.keys.length) newScene(project);
  resize(); afterLoad();
  requestAnimationFrame(tick);
  $('hint').textContent = 'コントロールの線をクリックして選び、矢印や輪をドラッグ。K: キー / Space: 再生 / M: 左右反転 / N: 自然なポーズに';

  wait('キャラクターを読み込み中…');
  status('キャラクターを読み込み中…');
  // ?mesh=0 shows the capsule mannequin (what a copy without assets/manny.* shows)
  try { if (new URLSearchParams(location.search).get('mesh') === '0') throw Error('off'); character = await loadManny('assets/manny', VERSION === 'dev' ? '' : '?v=' + VERSION); } catch { character = makeMannequin(rig); }
  scene.add(character);
  syncView();

  wait('参考モーションを読み込み中…（約 20 MB）');
  status('参考モーションを読み込み中…（約 20 MB）');
  try {
    const soma = new SomaRig(await fetch(asset('assets/soma_rig.json')).then(r => r.json()));
    const db = await MotionDB.load(soma, 'assets/motiondb', '?v=' + DB_VERSION);
    const re = new SomaToManny(rig, soma), fitter = new RigFitter(rig);
    nat = new Naturalizer(rig, db, re, fitter);
    inb = new Inbetweener(rig, db, re, fitter);
    db.track();
    rebake(); showFrame(frame);
    status(`参考モーション ${db.clips.length} クリップ`);
    wantMotionBricks();
    if (project.mode !== 'mb') wait(null);
  } catch (e) {
    console.error(e);
    status('参考モーションを読み込めませんでした（単純な補間で動きます）');
    wait(null);
  }
  window.app = { rig, project, actions, select, showFrame, commit, naturalizeNow, render: () => renderer.render(scene, camera), get frame() { return frame; }, get nat() { return nat; }, get inb() { return inb; }, get mb() { return mb; } };
}
start().catch(e => { console.error(e); wait(null); status('起動に失敗: ' + e.message); });
