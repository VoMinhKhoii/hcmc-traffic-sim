// @ts-check
// ui/panel.js — per-intersection LOCAL controller panels.
// Click an intersection on the map → a small panel opens AT that intersection
// with only that controller's state and inputs (ped buttons per approach,
// its central link). Central/global actions stay in the operator console, so
// when you click something you can see exactly what it changes, right there.

import { DIRS, INTERSECTIONS, APPROACHES } from '../network.js';

export function attachLocalPanels(leftEl, canvas, sim, view) {
  const panel = document.createElement('div');
  panel.id = 'local-panel';
  panel.style.display = 'none';
  leftEl.appendChild(panel);
  let openNode = null;

  const toScreen = (wx, wy) => ({
    x: (wx + view.tx) * view.s,
    y: (wy + view.ty) * view.s + canvas.offsetTop,
  });
  const toWorld = (sx, sy) => ({
    x: sx / view.s - view.tx,
    y: (sy - canvas.offsetTop) / view.s - view.ty,
  });

  canvas.style.cursor = 'default';
  canvas.addEventListener('mousemove', (e) => {
    canvas.style.cursor = hit(e) ? 'pointer' : 'default';
  });
  canvas.addEventListener('click', (e) => {
    const n = hit(e);
    if (!n) { openNode = null; panel.style.display = 'none'; return; }
    openNode = openNode === n ? null : n;
    panel.style.display = openNode ? 'block' : 'none';
    if (openNode) render();
  });

  function hit(e) {
    const r = canvas.getBoundingClientRect();
    const w = toWorld(e.clientX - r.left, e.clientY - r.top + canvas.offsetTop);
    for (const [n, p] of Object.entries(INTERSECTIONS))
      if (Math.hypot(w.x - p.x, w.y - p.y) < 34) return n;
    return null;
  }

  function render() {
    if (!openNode) return;
    const n = openNode, lc = sim.locals[n], m = lc.machine;
    const p = toScreen(INTERSECTIONS[n].x, INTERSECTIONS[n].y);
    // keep the panel on-screen: flip side when near the right edge
    const flip = p.x > leftEl.clientWidth - 260;
    panel.style.left = `${Math.max(4, flip ? p.x - 248 : p.x + 30)}px`;
    panel.style.top = `${Math.max(4, Math.min(leftEl.clientHeight - 240, p.y - 60))}px`;

    const linkUp = sim.bus.linkUp[n] !== false;
    const pre = lc.overlay.active();
    const rows = DIRS.map((d) => {
      const s = sim.model.ap(n, d);
      const ext = APPROACHES[n][d].ext ? '·ext' : '';
      const lit = m.state === 'GREEN' && ['E', 'W'].includes(d) === (m.phase === 'A');
      return `<tr><td class="${lit ? 'ok' : ''}">${d}${ext}</td>
        <td>${s.q.toFixed(0)} veh</td>
        <td><button data-ped="${d}" class="mini${s.pedButton ? ' active' : ''}">🚶 ped</button></td></tr>`;
    }).join('');

    panel.innerHTML = `
      <div class="ph"><b>${n} — local controller</b><button id="lp-close" class="mini">✕</button></div>
      <div class="pl">plan <b>${lc.plan.type}</b> · lights <b class="st-${m.state}">${m.state}${m.state === 'GREEN' ? ' ' + m.phase : ''}</b>
        ${pre ? `· <b class="bad">${pre} PREEMPT</b>` : ''}</div>
      <table>${rows}</table>
      <div class="pl">central link: <b class="${linkUp ? 'ok' : 'bad'}">${linkUp ? 'UP' : 'DOWN'}</b>
        <button id="lp-link" class="mini">${linkUp ? 'cut link' : 'restore'}</button></div>`;

    panel.querySelector('#lp-close').onclick = () => { openNode = null; panel.style.display = 'none'; };
    panel.querySelectorAll('[data-ped]').forEach((b) => {
      b.onclick = () => sim.pressPed(n, b.dataset.ped);
    });
    panel.querySelector('#lp-link').onclick = () => sim.bus.setLink(n, !linkUp, sim.t);
  }

  return render;   // caller refreshes it on the board cadence
}
