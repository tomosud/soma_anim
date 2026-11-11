// The sample scene (assets/sample_action.json), made the way an animator makes it in the page: go to a frame, click a
// pose of the pose book, copy a key along, move the whole body.  Run in the page:
//   (await import('/tools/make_action_sample.js')).make()
// It leaves the scene open in the page and posts it to eval_out/action.json (copy that to assets/sample_action.json).
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function make() {
  const app = window.app, $ = id => document.getElementById(id);
  const at = f => app.showFrame(f);
  const pose = (f, label, opts) => { at(f); if (!app.applyPose(label, opts)) throw Error('no pose ' + label); };
  const hold = (from, to) => { at(from); app.actions.copy(); at(to); app.actions.paste(false); };
  const move = (f, values) => {
    at(f); app.select('world_ctl');
    for (const [ch, x] of Object.entries(values)) { const inp = [...document.querySelectorAll('#channels input')].find(i => i.dataset.key === 'world_ctl.' + ch); inp.value = (+inp.value) + x; inp.dispatchEvent(new Event('change')); }
    app.select(null);
  };
  $('newScene').click();
  await wait(200);
  // stand, drop into a stance
  pose(22, '格闘の構え');
  hold(22, 36);
  // jab, cross
  pose(40, 'ジャブ');
  pose(47, '格闘の構え');
  pose(52, '振りかぶり');
  pose(57, 'クロス');
  pose(70, '格闘の構え');
  // step in, sink, uppercut
  move(88, { tz: 60 });
  pose(95, 'アッパーの溜め');
  pose(100, 'アッパー');
  pose(112, '格闘の構え');
  // roundhouse kick
  pose(122, '蹴りの溜め');
  pose(128, '回し蹴り');
  pose(148, '格闘の構え');
  // back off, guard, duck under, body shot
  move(166, { tz: -70 });
  pose(176, '両腕ガード');
  pose(188, 'ダッキング');
  pose(196, 'ボディ');
  pose(208, '格闘の構え');
  // knee up into a high kick
  pose(218, '膝蹴り');
  pose(225, 'ハイキック');
  pose(246, '格闘の構え');
  // done
  pose(272, '立ち');
  at(0);
  // wait for the in-betweens
  for (let i = 0; i < 200 && app.project.todo.length; i++) await wait(250);
  await fetch('/save/action.json', { method: 'POST', body: JSON.stringify(app.project.toJSON(), null, 1) });
  return app.project.segments.map(s => `${s.from}-${s.to}: ${s.match ? (s.match.kind || s.match.clip) + ' ' + (s.match.score ?? '') : 'steps'}`).join('\n');
}

/** The pictures of the scene that is open: eval_out/action_NN.png (every `step` frames, two views). */
export async function draw(step = 3, per = 20) {
  const app = window.app, { strip, savePng } = await import('./draw.js');
  const frames = app.project.baked, keys = app.project.keys.map(k => k.frame), n = frames.length, files = [];
  for (let a = 0, i = 0; a < n; a += step * per, i++) {
    const idx = []; for (let f = a; f < Math.min(n, a + step * per); f += step) idx.push(f);
    const rows = [false, true].map(side => ({ label: `frames ${idx[0]}-${idx[idx.length - 1]}  ${side ? 'side (faces right)' : 'front-left'}   numbers on the tiles are 0.. within this row: frame = ${idx[0]} + ${step} x tile`, frames: idx.map(f => frames[f]), keys: idx.map((f, k) => (keys.some(q => q >= f && q < f + step) ? k : -1)).filter(k => k >= 0), side }));
    const name = `action_${String(i).padStart(2, '0')}.png`;
    await savePng(strip(app.rig, app.env.physical.floor, rows, { per: 99, shot: app.shot }), name);
    files.push(name);
  }
  return files;
}

/** The scene that is open, in-betweened both ways and measured: how it moves (src/evaluate.js, `live`). */
export async function compare() {
  const app = window.app, { Evaluator, penalty } = await import('../src/evaluate.js'), { Project } = await import('../src/project.js');
  const ev = new Evaluator(app.rig, app.inb.db, app.inb.re), keys = app.project.keys.map(k => k.frame), out = [];
  for (const mode of ['ease', 'mb']) {
    const p = new Project(app.rig);
    p.fromJSON(app.project.toJSON()); p.mode = mode;
    p.bake(app.inb, app.mb);
    if (p.todo.length) await p.fill(app.inb, app.mb, () => {});
    const m = ev.measure(p.baked, keys), pen = penalty(m);
    const made = p.segments.filter(s => s.match && s.match.clip === 'MotionBricks').length, plain = p.segments.filter(s => s.match && s.match.clip === 'plain').length;
    out.push(`${mode.padEnd(5)} still ${m.live.still.toFixed(2)}  snap ${m.live.snap.toFixed(2)}  arc ${m.live.arc.toFixed(2)}  overlap ${m.live.overlap.toFixed(2)}  | penalty ${pen.total.toFixed(2)} (${Object.entries(pen.parts).filter(e => e[1] > 0.15).map(e => e[0] + ' ' + e[1].toFixed(1)).join(', ')})  | segments: ${p.segments.length}, by the model ${made}, fallen back to plain ${plain}`);
  }
  return out.join('\n');
}

/** Every frame from a to b of the scene that is open, two views: eval_out/<name>.png */
export async function dense(a, b, name) {
  const app = window.app, { strip, savePng } = await import('./draw.js');
  const idx = []; for (let f = a; f <= b; f++) idx.push(f);
  const keys = app.project.keys.map(k => k.frame);
  const rows = [false, true].map(side => ({ label: `every frame ${a}-${b}  ${side ? 'side (faces right)' : 'front-left'}   frame = ${a} + tile`, frames: idx.map(f => app.project.baked[f]), keys: idx.map((f, k) => (keys.includes(f) ? k : -1)).filter(k => k >= 0), side }));
  await savePng(strip(app.rig, app.env.physical.floor, rows, { per: 99, shot: app.shot }), name + '.png');
}
