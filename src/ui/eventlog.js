// @ts-check
// ui/eventlog.js — live message causality, status board and operator alarms.

import { MSG } from '../messages.js';

const TYPECOL = {
  [MSG.STATUS_UPDATE]: '#6b7c8c', [MSG.SET_PLAN]: '#4aa3ff',
  [MSG.TRAIN_APPROACHING]: '#ff8b5a', [MSG.GATES_UP]: '#37d67a',
  [MSG.GATE_FAULT]: '#ff5a5a', [MSG.CONGESTION_ALARM]: '#ffd23f',
  [MSG.PREEMPT]: '#4ad9ff', [MSG.RESUME]: '#b3ff66', [MSG.ALARM]: '#ff5a5a',
};

export function buildEventLog(logRoot, boardRoot, sim) {
  let showStatus = false;
  logRoot.innerHTML = `<h3>Message causality <label class="tiny"><input type="checkbox" id="c-status"> show STATUS_UPDATE</label></h3><div id="log-lines"></div>`;
  const lines = logRoot.querySelector('#log-lines');
  logRoot.querySelector('#c-status').onchange = (e) => { showStatus = e.target.checked; };

  sim.bus.onLog = (m) => {
    if (m.type === MSG.STATUS_UPDATE && !showStatus && !m.dropped && !m.flushed) return;
    const el = document.createElement('div');
    const linked = m.meta?.correlationId && !m.meta?.root;
    el.className = `msg${linked ? ' chain-child' : ''}${m.meta?.root ? ' chain-root' : ''}`;
    const delivery = m.dropped ? ' ✕dropped' : m.flushed ? ' ↷flushed' : '';
    const correlation = m.meta?.correlationId
      ? `<span class="cid">${linked ? '└' : '◆'} ${escapeHtml(m.meta.correlationId)}</span>` : '';
    el.innerHTML = `<div class="msg-main"><span class="t">${m.t.toFixed(1)}s</span>${correlation}
      <span class="type" style="color:${TYPECOL[m.type] ?? '#cfd8e0'}">${m.type}</span>
      <span class="ft">${escapeHtml(m.from)} → ${escapeHtml(m.to)}${delivery}</span>
      <span class="d">${messageDetail(m)}</span></div>
      <div class="causal"><span class="cause">why</span> ${formatCause(m)} <span class="arrow">→</span>
      <span class="effect">changed</span> ${formatEffect(m)}</div>`;
    lines.prepend(el);
    while (lines.children.length > 120) lines.lastChild.remove();
  };

  return function refreshBoard() {
    const rows = Object.entries(sim.locals).map(([n, lc]) => {
      const b = sim.central.board[n];
      const pre = lc.overlay.active();
      const link = sim.bus.linkUp[n];
      return `<tr><td>${n}</td><td>${lc.plan.type}</td>
        <td class="st-${lc.machine.state}">${lc.machine.state}${lc.machine.state === 'GREEN' ? ' ' + lc.machine.phase : ''}</td>
        <td>${pre ?? ''}</td><td class="${link ? 'ok' : 'bad'}">${link ? 'UP' : 'DOWN'}</td>
        <td class="dim">${b ? b.t.toFixed(0) + 's' : '—'}</td></tr>`;
    }).join('');
    const alarms = sim.central.alarms.slice(-6).reverse()
      .map((a) => `<div class="alarm">${a.t.toFixed(0)}s ${a.kind} — ${a.detail}</div>`).join('');
    boardRoot.innerHTML = `<h3>Central status board ${sim.centralAlive ? '' : '<span class="bad">⚠ OFFLINE</span>'}</h3>
      <table><tr><th>node</th><th>plan</th><th>lights</th><th>preempt</th><th>link</th><th>last rpt</th></tr>${rows}</table>
      <h3>Alarms</h3>${alarms || '<div class="dim">none</div>'}`;
  };
}

function messageDetail(m) {
  if (m.type === MSG.SET_PLAN) return planDelta(m);
  if (m.type === MSG.CONGESTION_ALARM)
    return `${m.data.active ? 'RAISE' : 'CLEAR'} · approach=${escapeHtml(m.data.approach)} · q=${number(m.data.q)} veh`;
  if (m.type === MSG.TRAIN_APPROACHING)
    return `crossing=${escapeHtml(m.data.crossing)} · eta=${number(m.meta?.cause?.measurement?.value ?? m.data.eta)} s`;
  if (m.type === MSG.PREEMPT)
    return `approach=${escapeHtml(m.data.approach)} · eta=${number(m.meta?.cause?.measurement?.value)} s`;
  return escapeHtml(short(m.data));
}

function planDelta(m) {
  const before = m.meta?.effect?.before ?? { plan: '?', params: {} };
  const after = m.meta?.effect?.after ?? { plan: m.data.plan, params: m.data.params ?? {} };
  const bits = [];
  if (before.plan !== after.plan)
    bits.push(`<span class="delta">${escapeHtml(before.plan)} → ${escapeHtml(after.plan)}</span>`);
  else bits.push(`<b>${escapeHtml(after.plan)}</b>`);
  for (const [key, label] of [['greenA', 'green A'], ['greenB', 'green B'], ['cycle', 'cycle'], ['offset', 'offset']]) {
    const oldValue = before.params?.[key], newValue = after.params?.[key];
    if (newValue === undefined) continue;
    if (oldValue === undefined || Math.abs(oldValue - newValue) > 1e-9) {
      const oldText = oldValue === undefined ? '—' : `${number(oldValue)}s`;
      bits.push(`${label} <span class="delta">${oldText} → ${number(newValue)}s</span>`);
    } else if (key === 'cycle') {
      bits.push(`<span class="unchanged">cycle ${number(newValue)}s unchanged</span>`);
    } else if (key === 'offset') {
      bits.push(`<span class="unchanged">offset ${number(newValue)}s</span>`);
    }
  }
  return bits.join(' · ');
}

function formatCause(m) {
  const cause = m.meta?.cause;
  if (!cause) return 'message emitted by sender';
  const summary = escapeHtml(cause.summary ?? 'sender condition');
  if (!cause.measurement) return summary;
  const x = cause.measurement, th = cause.threshold;
  const measure = `${escapeHtml(x.label)}=${number(x.value)}${x.unit ? ` ${escapeHtml(x.unit)}` : ''}`;
  const threshold = th
    ? `threshold${th.label ? ` ${escapeHtml(th.label)}` : ''} ${escapeHtml(th.operator ?? '')} ${number(th.value)}${th.unit ? ` ${escapeHtml(th.unit)}` : ''}` : '';
  const held = Number.isFinite(cause.held) ? `held ${number(cause.held)}s` : '';
  return `${summary}: <span class="measure">${measure}</span>${threshold || held ? ` <span class="threshold">(${[threshold, held].filter(Boolean).join(', ')})</span>` : ''}`;
}

function formatEffect(m) {
  if (m.dropped) return '<span class="bad">not delivered while the central link is down</span>';
  return escapeHtml(m.meta?.effect?.summary ?? 'receiver inbox updated');
}

function short(d) {
  return Object.entries(d).map(([k, v]) =>
    `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : typeof v === 'object' && v ? JSON.stringify(v).slice(0, 40) : v}`).join(' ');
}

function number(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) : '—';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
