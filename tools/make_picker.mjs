// The picker of the page (assets/picker.json), from the picker exported from the Maya rig (rigspec/, kept
// local).  Only what the page draws and does is kept: shapes, colours, text, the controls a button selects,
// the option a switch button sets, when a button is shown.  The IK/FK buttons, the FK controls and the
// buttons that run Maya tools this page does not have are left out.     node tools/make_picker.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const src = JSON.parse(readFileSync(new URL('../rigspec/bns_picker.json', import.meta.url)));
const spec = JSON.parse(readFileSync(new URL('../assets/bns_rig.json', import.meta.url)));
const hidden = new Set(spec.controls.filter(c => /_fk$/.test(c.name)).map(c => c.name));

// Maya tool -> what the page does
const OPS = {
  'posetools.reset': 'resetPose', 'posetools.mirror': 'mirror', 'posetools.copy_pose': 'copy', 'posetools.paste_pose': 'paste',
  'posetools.reset_hand': 'resetHand', 'posetools.copy_hand': 'copyHand', 'posetools.paste_hand': 'pasteHand', 'posetools.hand_to_other': 'handToOther',
  'posetools.key_attr': 'key',
};
const LEAVE_TEXT = /IK\/FK|マウスを乗せると|右クリック|押して切替/;

const r1 = x => Math.round(x * 10) / 10;
// (lines about the Maya tools - the right-click menu, the graph editor - are not for this page)
const tip = t => t.split('\n').filter(l => !/右クリック|グラフエディタ|Maya/.test(l)).join('\n');
const tabs = src.tabs.map(tab => {
  const items = [];
  for (const it of tab.items) {
    if (it.kind === 'frame') continue; // (key / selection rings: drawn by the page from its own state)
    const sw = it.switch && !/IKFK$/.test(it.switch.attr) && !/^slider/.test(String(it.switch.value)) && typeof it.switch.value === 'number' ? { attr: it.switch.attr, value: it.switch.value } : null;
    if (it.switch && /IKFK$/.test(it.switch.attr)) continue;
    const controls = (it.controls || []).filter(c => !hidden.has(c));
    if (it.kind === 'select' && !controls.length) continue;
    let op = null;
    if (it.kind === 'action' && !sw) {
      const o = (Array.isArray(it.operation) ? it.operation : []).find(o => o.module);
      const name = o && OPS[o.module.replace(/^bns_rig\./, '') + '.' + o.function];
      if (!name) continue;
      op = name;
      if (name === 'mirror' && !/'flip'/.test(o.args)) continue; // (left to right / right to left: not on this page)
      const side = /'([LR])'/.exec(o.args || '');
      if (side) op += ':' + side[1];
    }
    if (it.kind === 'label' && LEAVE_TEXT.test(it.text || '')) continue;
    const vis = it.visibility && !it.visibility.runtime ? it.visibility.formula : null;
    items.push({
      kind: it.kind, x: r1(it.position[0]), y: r1(it.position[1]), shape: it.shape, size: it.size.map(r1),
      outline: it.shape === 'circle' ? null : it.outline.map(p => p.map(r1)),
      color: it.color, text: it.text || '', textSize: it.text_size, textColor: it.text_color,
      ...(controls.length ? { controls } : {}), ...(sw ? { switch: sw } : {}), ...(op ? { op } : {}),
      ...(it.binding ? { slider: { attr: it.binding.attr, min: it.binding.min, max: it.binding.max } } : {}),
      ...(vis ? { visible: vis } : {}), ...(it.tooltip ? { tip: tip(it.tooltip) } : {}),
    });
  }
  return { name: tab.name === 'Body' ? '体' : tab.name === 'Fingers' ? '指' : tab.name, items };
});
writeFileSync(new URL('../assets/picker.json', import.meta.url), JSON.stringify({ about: 'picker of the page (tools/make_picker.mjs)', tabs }));
for (const t of tabs) {
  const kinds = {};
  for (const i of t.items) kinds[i.op || i.kind + (i.switch ? '/switch' : '')] = (kinds[i.op || i.kind + (i.switch ? '/switch' : '')] || 0) + 1;
  console.log(t.name, t.items.length, JSON.stringify(kinds));
}
