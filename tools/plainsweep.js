// Where does the in-between give up on MotionBricks?  Scenes made as an animator makes them in the page (poses of
// the pose book at random frames, now and then the whole body moved or turned), in-betweened, and every stretch
// listed with how it was made.  Run in the page (?debug), after "MotionBricks: ..." shows:
//   (await import('/tools/plainsweep.js')).run({ scenes: 6, tag: '_before' })
// -> eval_out/plainsweep<tag>.txt / .json.  The scenes depend only on the seed, so two versions can be compared.
const wait = ms => new Promise(r => setTimeout(r, ms));

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export async function scene(seed, { flow = false } = {}) {
  const app = window.app, $ = id => document.getElementById(id), R = rng(seed);
  const pick = a => a[Math.floor(R() * a.length)];
  const at = f => app.showFrame(f);
  const move = (f, values) => {
    at(f); app.select('world_ctl');
    for (const [ch, x] of Object.entries(values)) { const inp = [...document.querySelectorAll('#channels input')].find(i => i.dataset.key === 'world_ctl.' + ch); inp.value = (+inp.value) + x; inp.dispatchEvent(new Event('change')); }
    app.select(null);
  };
  $('newScene').click();
  await wait(100);
  app.project.flow = flow;
  const labels = app.poseBook.map(p => p.label);
  let f = 0;
  const steps = [];
  while (true) {
    f += Math.round(8 + R() * 52);
    if (f > 290) break;
    const r = R();
    if (r < 0.2) { const v = { tz: Math.round((R() - 0.3) * 300), tx: Math.round((R() - 0.5) * 120) }; move(f, v); steps.push(`${f}: move ${JSON.stringify(v)}`); }
    else if (r < 0.3) { const v = { ry: Math.round((R() - 0.5) * 300) }; move(f, v); steps.push(`${f}: turn ${v.ry}`); }
    else { const l = pick(labels), m = R() < 0.3; at(f); app.applyPose(l, { mirror: m }); steps.push(`${f}: ${l}${m ? ' (mirrored)' : ''}`); }
  }
  for (let i = 0; i < 800 && app.project.todo.length; i++) await wait(250);
  return { seed, flow, steps, segments: app.project.segments.map(s => ({ from: s.from, to: s.to, clip: s.match?.clip ?? null, kind: s.match?.kind, score: s.match?.score, mbScore: s.match?.mbScore, reason: s.reason, tries: s.match?.tries })) };
}

export async function run({ scenes = 6, first = 1, flow = false, tag = '' } = {}) {
  const out = [];
  for (let s = first; s < first + scenes; s++) out.push(await scene(s, { flow }));
  const all = out.flatMap(o => o.segments.map(g => ({ ...g, seed: o.seed })));
  const plain = all.filter(g => g.clip !== 'MotionBricks');
  const lines = [`${plain.length} of ${all.length} stretches not made by MotionBricks${flow ? ' (flow)' : ''}`];
  for (const g of plain) lines.push(`  seed ${g.seed} ${g.from}-${g.to} (${g.to - g.from} f): ${g.clip ?? 'plain'} ${JSON.stringify(g.reason)} ${g.tries ? g.tries.join(' / ') : ''}`);
  const scores = all.filter(g => g.clip === 'MotionBricks').map(g => g.score);
  lines.push(`MotionBricks stretches: mean score ${(scores.reduce((a, b) => a + b, 0) / (scores.length || 1)).toFixed(3)}, over 1.0: ${scores.filter(x => x > 1).length}`);
  const text = lines.join('\n');
  await fetch(`/save/plainsweep${tag}.txt`, { method: 'POST', body: text }).catch(() => {});
  await fetch(`/save/plainsweep${tag}.json`, { method: 'POST', body: JSON.stringify(out, null, 1) }).catch(() => {});
  return text;
}
