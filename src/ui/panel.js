// @ts-check
// ui/panel.js — per-intersection LOCAL controller panels.
// Click an intersection on the map → a small panel opens AT that intersection
// with only that controller's state and inputs (ped buttons per approach,
// its central link). Central/global actions stay in the operator console, so
// when you click something you can see exactly what it changes, right there.

import { DIRS, INTERSECTIONS, APPROACHES } from '../network.js';
import { CONFIG } from '../config.js';

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
    const flip = p.x > leftEl.clientWidth - 360;
    panel.style.left = `${Math.max(4, flip ? p.x - 348 : p.x + 30)}px`;
    panel.style.top = `${Math.max(4, Math.min(leftEl.clientHeight - 360, p.y - 60))}px`;

    const linkUp = sim.bus.linkUp[n] !== false;
    const pre = lc.overlay.active();
    const preDetail = lc.overlay.rail
      ? `${lc.overlay.rail.stage} · crossing ${lc.overlay.rail.crossing}`
      : pre === 'EV' ? 'priority route' : '';
    const why = planExplanation(n, lc);
    const interventions = activeInterventions(n, lc);
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
        ${pre ? `· <b class="bad">${pre} PREEMPT${preDetail ? ` · ${preDetail}` : ''}</b>` : ''}</div>
      <div class="why-title">Why am I doing this?</div>
      <div class="plan-facts">${planFacts(lc.plan)}</div>
      <div class="why-copy">${why}</div>
      ${interventions ? `<div class="interventions">${interventions}</div>` : ''}
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

function planFacts(plan) {
  const p = plan.params ?? {};
  if (plan.type === 'FIXED')
    return `FIXED · green A <b>${seconds(p.greenA)}</b> · green B <b>${seconds(p.greenB)}</b> · cycle <b>${seconds(p.cycle)}</b> · offset ${seconds(p.offset)}`;
  if (plan.type === 'ACTUATED')
    return `ACTUATED · green ${CONFIG.minGreen.toFixed(0)}–${CONFIG.maxGreen.toFixed(0)} s · gap-out ${CONFIG.gapOut.toFixed(0)} s`;
  return 'FLASH · main road yellow · side road red';
}

function planExplanation(node, lc) {
  const command = lc.planCommand;
  const meta = command?.meta ?? {};
  const effect = meta.effect;
  const cause = meta.cause;
  const who = command?.from ?? 'LOCAL';
  const when = Number.isFinite(command?.t) ? ` at t=${command.t.toFixed(1)} s` : '';
  if (meta.role === 'self-retime' && effect?.before && effect?.after) {
    const changed = changedGreen(effect.before.params, effect.after.params);
    const q = cause?.measurement?.value;
    const approach = meta.reason?.match(/reported ([NESW]) queue/)?.[1] ?? 'reported';
    const triggerT = Number.isFinite(meta.triggeredAt) ? meta.triggeredAt.toFixed(1) : command.t.toFixed(1);
    return `My green ${changed.phase} is <b>${seconds(changed.after)}</b> instead of ${seconds(changed.before)} because I reported a ${number(q)}-vehicle queue on ${approach} to central at t=${triggerT} s, and central sent me a new split${when}.`;
  }
  if (meta.role === 'metering')
    return `<b>${who}</b> commanded this split${when} to meter traffic feeding another congested intersection. ${escapeHtml(meta.reason ?? '')}`;
  if (meta.role === 'restore')
    return `<b>${who}</b> restored the normal ${lc.plan.type.toLowerCase()} plan${when} because the queue crossed the clear threshold.`;
  return `<b>${who}</b> commanded this ${lc.plan.type.toLowerCase()} plan${when}. ${escapeHtml(cause?.summary ?? 'It is the safe local startup plan.')}`;
}

function activeInterventions(node, lc) {
  const items = [];
  const meta = lc.planCommand?.meta ?? {};
  if (meta.role === 'self-retime') items.push(`<b>Congestion self-retime</b>: ${escapeHtml(meta.reason ?? 'extra green for the reported queue')}`);
  if (meta.role === 'metering') items.push(`<b>Upstream metering</b>: ${escapeHtml(meta.reason ?? 'feeding green restricted')}`);
  if (lc.overlay.rail) {
    const cause = lc.overlay.rail.meta?.cause;
    items.push(`<b>Rail ${lc.overlay.rail.stage}</b>: crossing ${lc.overlay.rail.crossing}, ${escapeHtml(cause?.summary ?? 'train protection active')}`);
  }
  if (lc.overlay.ev) {
    const ev = lc.overlay.ev;
    items.push(`<b>EV ${ev.active ? 'preempt' : 'scheduled'}</b>: ${ev.approach} approach, arrival t=${ev.eta.toFixed(1)} s. ${escapeHtml(ev.meta?.cause?.summary ?? '')}`);
  }
  return items.map((x) => `<div class="intervention">${x}</div>`).join('');
}

function changedGreen(before = {}, after = {}) {
  const phase = Math.abs((before.greenA ?? 0) - (after.greenA ?? 0)) > 1e-9 ? 'A' : 'B';
  return { phase, before: before[`green${phase}`], after: after[`green${phase}`] };
}

function seconds(value) { return Number.isFinite(value) ? `${Number(value).toFixed(1)} s` : '—'; }
function number(value) { return Number.isFinite(value) ? Number(value).toFixed(1) : 'reported'; }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
