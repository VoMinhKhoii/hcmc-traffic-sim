// @ts-check
// ui/eventlog.js — the control-room display: live message-bus traffic,
// per-intersection status board, and the operator alarm list.

import { MSG } from '../messages.js';

const TYPECOL = {
  [MSG.STATUS_UPDATE]: '#6b7c8c', [MSG.SET_PLAN]: '#4aa3ff',
  [MSG.TRAIN_APPROACHING]: '#ff8b5a', [MSG.GATES_UP]: '#37d67a',
  [MSG.GATE_FAULT]: '#ff5a5a', [MSG.CONGESTION_ALARM]: '#ffd23f',
  [MSG.PREEMPT]: '#4ad9ff', [MSG.RESUME]: '#b3ff66', [MSG.ALARM]: '#ff5a5a',
};

export function buildEventLog(logRoot, boardRoot, sim) {
  let showStatus = false;
  logRoot.innerHTML = `<h3>Message traffic <label class="tiny"><input type="checkbox" id="c-status"> show STATUS_UPDATE</label></h3><div id="log-lines"></div>`;
  const lines = logRoot.querySelector('#log-lines');
  logRoot.querySelector('#c-status').onchange = (e) => { showStatus = e.target.checked; };

  sim.bus.onLog = (m) => {
    if (m.type === MSG.STATUS_UPDATE && !showStatus && !m.dropped && !m.flushed) return;
    const el = document.createElement('div');
    el.className = 'msg';
    const tag = m.dropped ? ' ✕dropped' : m.flushed ? ' ↻flushed' : '';
    el.innerHTML = `<span class="t">${m.t.toFixed(0)}s</span> <span style="color:${TYPECOL[m.type] ?? '#fff'}">${m.type}</span> <span class="ft">${m.from}→${m.to}${tag}</span> <span class="d">${short(m.data)}</span>`;
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

function short(d) {
  return Object.entries(d).map(([k, v]) =>
    `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : typeof v === 'object' && v ? JSON.stringify(v).slice(0, 40) : v}`).join(' ');
}
