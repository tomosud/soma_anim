// The picker: the same buttons as the picker of the rig in Maya (assets/picker.json, tools/make_picker.mjs).
// Buttons select controls, set the switches (follow, the direction of the elbows and knees, the wrist and
// ankle), drive the automatic shoulder, and run the pose tools of the page.
const NS = 'http://www.w3.org/2000/svg';
const rgb = c => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;

/**
 * box: the element to draw into.  api: {get(attr), selected(), select(name), setOption(attr, value),
 * run(op, side), slide(attr, value, done)}.
 */
export class Picker {
  constructor(box, data, api) {
    this.box = box; this.data = data; this.api = api; this.tab = 0;
    this.visible = new Map();
    for (const t of data.tabs) for (const it of t.items) if (it.visible) this.visible.set(it, compile(it.visible));
    this.build();
  }

  build() {
    const box = this.box;
    box.textContent = '';
    const bar = document.createElement('div');
    bar.className = 'pick';
    this.data.tabs.forEach((t, i) => {
      const b = document.createElement('button');
      b.textContent = t.name;
      b.classList.toggle('on', i === this.tab);
      b.onclick = () => { this.tab = i; this.build(); };
      bar.append(b);
    });
    box.append(bar);
    const items = this.data.tabs[this.tab].items;
    // the frame of the picture: everything any button can cover
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const it of items) { const w = it.size[0] / 2, h = it.size[1] / 2; x0 = Math.min(x0, it.x - w); x1 = Math.max(x1, it.x + w); y0 = Math.min(y0, it.y - h); y1 = Math.max(y1, it.y + h); }
    const pad = 4, svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
    svg.setAttribute('class', 'picker');
    this.nodes = [];
    for (const it of items) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${it.x} ${-it.y})`);
      let shape;
      if (it.kind === 'label') shape = null;
      else if (it.shape === 'circle' || !it.outline) {
        shape = document.createElementNS(NS, 'ellipse');
        shape.setAttribute('rx', it.size[0] / 2); shape.setAttribute('ry', it.size[1] / 2);
      } else {
        shape = document.createElementNS(NS, 'polygon');
        shape.setAttribute('points', it.outline.map(p => `${p[0]},${-p[1]}`).join(' '));
        if (it.shape === 'rounded_rect') shape.setAttribute('stroke-linejoin', 'round');
      }
      if (shape) { shape.setAttribute('fill', rgb(it.color)); g.append(shape); }
      let bar = null;
      if (it.slider) {
        bar = document.createElementNS(NS, 'rect');
        bar.setAttribute('x', -it.size[0] / 2); bar.setAttribute('y', -it.size[1] / 2); bar.setAttribute('height', it.size[1]);
        bar.setAttribute('fill', 'rgba(120,200,255,0.55)');
        g.append(bar);
      }
      if (it.text || it.slider) {
        const t = document.createElementNS(NS, 'text');
        t.textContent = it.text;
        t.setAttribute('font-size', it.textSize || 5);
        t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central');
        t.setAttribute('fill', rgb(it.textColor || [235, 235, 235, 255]));
        g.append(t);
        if (it.slider) it.textNode = t;
      }
      if (it.tip || it.controls) {
        const title = document.createElementNS(NS, 'title');
        title.textContent = it.tip || it.controls.join(', ');
        g.append(title);
      }
      if (it.kind !== 'label') g.style.cursor = 'pointer';
      g.addEventListener('pointerdown', e => this.press(it, e, g));
      svg.append(g);
      this.nodes.push({ it, g, shape, bar });
    }
    box.append(svg);
    this.refresh();
  }

  press(it, e, g) {
    const api = this.api;
    if (it.switch) api.setOption(it.switch.attr, it.switch.value);
    else if (it.op) { const [op, side] = it.op.split(':'); api.run(op, side, it); }
    else if (it.slider) {
      const set = ev => {
        const r = g.getBoundingClientRect(), u = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        api.slide(it.slider.attr, it.slider.min + u * (it.slider.max - it.slider.min), false);
        this.refresh();
      };
      set(e);
      const move = ev => set(ev), up = ev => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); const r = g.getBoundingClientRect(); api.slide(it.slider.attr, it.slider.min + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (it.slider.max - it.slider.min), true); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    } else if (it.controls) {
      // (a button for several controls: each press goes on to the next one)
      const cur = this.api.selected(), i = it.controls.indexOf(cur);
      api.select(it.controls[(i + 1) % it.controls.length]);
    }
  }

  /** Show / hide by the options, and mark the selected control. */
  refresh() {
    if (!this.nodes) return;
    const sel = this.api.selected();
    for (const { it, g, shape, bar } of this.nodes) {
      const f = this.visible.get(it);
      g.style.display = !f || f(this.api.get) >= 0.5 ? '' : 'none';
      if (shape && it.controls) {
        const on = it.controls.length === 1 && it.controls[0] === sel;
        shape.setAttribute('stroke', on ? '#fff' : 'none');
        shape.setAttribute('stroke-width', on ? 1.6 : 0);
      }
      if (bar) {
        const v = this.api.get(it.slider.attr), u = (v - it.slider.min) / (it.slider.max - it.slider.min);
        bar.setAttribute('width', Math.max(0, Math.min(1, u)) * it.size[0]);
        if (it.textNode) it.textNode.textContent = `肩の追従 ${Math.round(v * 100)}%`;
      }
    }
  }
}

/** "((L_Hand_rot.pvFollow == 0) * L_Hand_rot.IKFK)" -> (get) => number */
function compile(formula) {
  const js = formula.replace(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g, (_, n, a) => `g(${JSON.stringify(n + '.' + a)})`);
  try { const f = new Function('g', 'return +(' + js + ');'); return g => f(g); } catch { return null; }
}
