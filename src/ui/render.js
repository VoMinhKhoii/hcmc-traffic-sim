// @ts-check
// ui/render.js — schematic map: white ground, black road edges, dashed
// intersection boxes, a 3-aspect signal head per approach, double-track
// railway with angle-aligned gates. Labels carry a white halo so nothing
// becomes unreadable where lines cross. Pure read-only view of the sim.

import { CONFIG } from '../config.js';
import { INTERSECTIONS, LINKS, APPROACHES, DIRS, PHASES, CROSSINGS, ROADS, MAIN_PHASE, linkById } from '../network.js';
import { RAIL } from '../physics/trains.js';

const DIRV = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const COL = {
  bg: '#ffffff', edge: '#111111', median: '#111111', box: '#8a8a8a',
  green: '#22b14c', yellow: '#f2d21f', red: '#c62828', unlit: '#d8d8d8', head: '#141414',
  qLow: '#2f7fd4', qMid: '#d99a00', qHigh: '#d32f2f',
  rail: '#c62828', train: '#8e1414', ev: '#0288d1', walk: '#2e7d32',
  label: '#333333', street: '#888888',
};
const HALF = 15;        // road half-width
const TRIM = 24;        // where edge lines stop before an intersection center

export function draw(ctx, sim) {
  const t = sim.t;
  ctx.fillStyle = COL.bg; ctx.fillRect(-200, -200, 2400, 2400);
  ctx.lineCap = 'butt';

  // ---- roads: two edges + broken center median (no lane clutter) --------
  for (const s of roadSegments()) {
    line(ctx, offset(s.a2, s.n, HALF), offset(s.b2, s.n, HALF), COL.edge, 2.4);
    line(ctx, offset(s.a2, s.n, -HALF), offset(s.b2, s.n, -HALF), COL.edge, 2.4);
    line(ctx, add(s.a2, mul(s.u, 10)), add(s.b2, mul(s.u, -10)), COL.median, 1.8);
  }
  for (const l of LINKS) {
    const A = INTERSECTIONS[l.a], B = INTERSECTIONS[l.b];
    streetLabel(ctx, A, B, `${ROADS[l.road] ?? l.road} · ${l.len} m`);
  }

  // ---- dashed intersection boxes ----------------------------------------
  ctx.setLineDash([5, 4]);
  for (const p of Object.values(INTERSECTIONS)) {
    ctx.strokeStyle = COL.box; ctx.lineWidth = 1.2;
    ctx.strokeRect(p.x - HALF - 3, p.y - HALF - 3, 2 * HALF + 6, 2 * HALF + 6);
  }
  ctx.setLineDash([]);

  // ---- railway: double track, angle-aligned gates -----------------------
  const r0 = RAIL.xy(-80), r1 = RAIL.xy(RAIL.total + 80);
  const ru = norm(r0, r1), rn = { x: -ru.y, y: ru.x };   // along / across rail
  ctx.setLineDash([13, 8]);
  for (const off of [-4, 4])
    line(ctx, offset(r0, rn, off), offset(r1, rn, off), COL.rail, 2.6);
  ctx.setLineDash([]);
  streetLabel(ctx, r0, r1, 'Railway — North–South line (Lê Văn Sỹ)', COL.rail, 26);

  for (const [name, c] of Object.entries(CROSSINGS)) {
    const l = linkById(c.link), A = INTERSECTIONS[l.a], B = INTERSECTIONS[l.b];
    const x = A.x + (B.x - A.x) * c.pos, y = A.y + (B.y - A.y) * c.pos;
    const roadAng = Math.atan2(B.y - A.y, B.x - A.x);
    const cr = sim.railway.crossings[name];
    const down = cr.state === 'CLOSED' || cr.state === 'LOWERING';
    ctx.save(); ctx.translate(x, y); ctx.rotate(roadAng);
    ctx.strokeStyle = down || cr.fault ? COL.red : COL.green; ctx.lineWidth = 4.5;
    ctx.beginPath();
    if (down) {   // barriers ACROSS the road, one per side
      ctx.moveTo(-HALF + 2, -HALF); ctx.lineTo(-HALF + 2, HALF);
      ctx.moveTo(HALF - 2, -HALF); ctx.lineTo(HALF - 2, HALF);
    } else {      // barriers raised: short stubs beside the road
      ctx.moveTo(-HALF + 2, -HALF - 10); ctx.lineTo(-HALF + 2, -HALF + 2);
      ctx.moveTo(HALF - 2, HALF + 10); ctx.lineTo(HALF - 2, HALF - 2);
    }
    ctx.stroke();
    if (cr.flashers && Math.floor(t * 2) % 2 === 0) {
      ctx.fillStyle = COL.red;
      ctx.beginPath(); ctx.arc(-HALF - 8, -HALF - 8, 5, 0, 7); ctx.arc(HALF + 8, HALF + 8, 5, 0, 7); ctx.fill();
    }
    ctx.restore();
    // label placed off the rail axis so it never sits on the tracks
    const lx = x + rn.x * 34 - 20, ly = y + rn.y * 34;
    label(ctx, lx, ly, `Crossing ${name}`, down ? COL.red : COL.label, 11, down);
    if (cr.fault) label(ctx, lx, ly + 14, 'GATE FAULT', COL.red, 11, true);
  }

  // ---- vehicles in transit ---------------------------------------------
  ctx.fillStyle = '#3c3c3c';
  for (const p of Object.values(sim.model.pipes)) {
    const from = INTERSECTIONS[p.from];
    const l = p.link, to = INTERSECTIONS[l.a === p.from ? l.b : l.a];
    // keep right-hand side of travel so opposing platoons don't overlap
    const u = norm(from, to), side = { x: -u.y * 5.5, y: u.x * 5.5 };
    for (const e of p.entries) {
      const f = Math.min(1, (t - e.enterT) / (e.arriveAt - e.enterT));
      const n = Math.max(1, Math.round(e.n / 2));   // one dot ≈ two vehicles
      for (let i = 0; i < Math.min(n, 5); i++) {
        const ff = Math.max(0, f - i * 0.025);
        ctx.beginPath();
        ctx.arc(from.x + (to.x - from.x) * ff + side.x, from.y + (to.y - from.y) * ff + side.y, 2.6, 0, 7);
        ctx.fill();
      }
    }
  }

  // ---- intersections: queue bars + signal heads + walk ------------------
  for (const [n, p] of Object.entries(INTERSECTIONS)) {
    const L = sim.locals[n].machine;
    for (const d of DIRS) {
      const v = DIRV[d];
      const q = sim.model.ap(n, d).q;
      const len = Math.min(85, q * 2.4);
      if (len > 1.5) {
        ctx.strokeStyle = q > CONFIG.congestionThreshold ? COL.qHigh : q > CONFIG.congestionThreshold * 0.6 ? COL.qMid : COL.qLow;
        ctx.lineWidth = 5.5;
        ctx.beginPath();
        ctx.moveTo(p.x + v[0] * (HALF + 6) - v[1] * 8, p.y + v[1] * (HALF + 6) + v[0] * 8);
        ctx.lineTo(p.x + v[0] * (HALF + 6 + len) - v[1] * 8, p.y + v[1] * (HALF + 6 + len) + v[0] * 8);
        ctx.stroke();
        if (q >= 8)
          label(ctx, p.x + v[0] * (HALF + 16 + len) - v[1] * 16, p.y + v[1] * (HALF + 16 + len) + v[0] * 16 + 4,
            `(${Math.round(q)})`, COL.label, 11, true);
      }
      drawHead(ctx, n, d, p, v, L, t);
    }
    if (L.walk) label(ctx, p.x - 15, p.y - HALF - 26, 'WALK', COL.walk, 11, true);
    label(ctx, p.x - 9, p.y + 6, n, COL.label, 13, true);
    const pre = sim.locals[n].overlay.active();
    if (pre) label(ctx, p.x - 34, p.y + HALF + 40, pre === 'TRAIN' ? '⛔ RAIL PREEMPT' : '⚡ EV PREEMPT', pre === 'TRAIN' ? COL.red : COL.ev, 11, true);
    if (sim.bus.linkUp[n] === false) label(ctx, p.x - 30, p.y - HALF - 40, '✕ LINK DOWN', COL.red, 11, true);
  }

  // ---- trains: one per track (offset by direction, like real double track)
  for (const tr of sim.trains.trains) {
    const trackOff = tr.dir === 1 ? 4 : -4;
    const a = offset(RAIL.xy(tr.s), rn, trackOff), b = offset(RAIL.xy(tr.s - tr.dir * 120), rn, trackOff);
    ctx.strokeStyle = COL.train; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.lineCap = 'butt';
  }
  label(ctx, r1.x - 155, r1.y - 12,
    sim.trains.signalRed ? 'TRAIN SIGNAL: RED' : 'TRAIN SIGNAL: GREEN',
    sim.trains.signalRed ? COL.red : COL.green, 12, true);

  // ---- EV ---------------------------------------------------------------
  const evp = sim.incidents.evXY();
  if (evp) {
    ctx.fillStyle = Math.floor(t * 4) % 2 ? COL.ev : '#7fd4ff';
    ctx.beginPath(); ctx.arc(evp.x, evp.y, 7, 0, 7); ctx.fill();
    ctx.strokeStyle = '#01579b'; ctx.lineWidth = 1.5; ctx.stroke();
    label(ctx, evp.x + 11, evp.y - 8, 'EV', COL.ev, 12, true);
  }

  // ---- accidents --------------------------------------------------------
  for (const a of sim.incidents.accidents) {
    const l = linkById(a.linkId), A = INTERSECTIONS[l.a], B = INTERSECTIONS[l.b];
    const x = (A.x + B.x) / 2, y = (A.y + B.y) / 2;
    ctx.font = '18px monospace'; ctx.fillStyle = '#e65100'; ctx.fillText('⚠', x - 8, y + 6);
    label(ctx, x + 12, y + 5, 'ACCIDENT', '#e65100', 12, true);
  }

  drawLegend(ctx, 40, 730);
}

// ---- signal heads ---------------------------------------------------------
function drawHead(ctx, node, d, p, v, L, t) {
  const perp = [-v[1], v[0]];
  const cx = p.x + v[0] * (HALF + 13) + perp[0] * (HALF + 9);
  const cy = p.y + v[1] * (HALF + 13) + perp[1] * (HALF + 9);
  let lit = 'red', blink = false;
  if (L.state === 'GREEN') lit = PHASES[L.phase].includes(d) ? 'green' : 'red';
  else if (L.state === 'YELLOW') lit = PHASES[L.phase].includes(d) ? 'yellow' : 'red';
  else if (L.state === 'FLASH') { lit = PHASES[MAIN_PHASE[node]].includes(d) ? 'yellow' : 'red'; blink = true; }
  const on = !blink || Math.floor(t * 1.6) % 2 === 0;

  ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(perp[1], perp[0]));
  ctx.fillStyle = COL.head;
  roundRect(ctx, -19, -7.5, 38, 15, 6); ctx.fill();
  ['red', 'yellow', 'green'].forEach((c, i) => {
    ctx.fillStyle = c === lit && on ? COL[c] : COL.unlit;
    ctx.beginPath(); ctx.arc(-11.5 + i * 11.5, 0, 4.3, 0, 7); ctx.fill();
  });
  ctx.restore();
}

// ---- road geometry helpers ------------------------------------------------
function roadSegments() {
  const segs = [];
  const push = (A, B, trimA, trimB) => {
    const u = norm(A, B), n = { x: -u.y, y: u.x };
    segs.push({ a2: add(A, mul(u, trimA)), b2: add(B, mul(u, -trimB)), u, n });
  };
  for (const l of LINKS) push(INTERSECTIONS[l.a], INTERSECTIONS[l.b], TRIM, TRIM);
  for (const [nn, aps] of Object.entries(APPROACHES))
    for (const d of DIRS) if (aps[d].ext) {
      const p = INTERSECTIONS[nn], v = DIRV[d];
      push(p, { x: p.x + v[0] * 85, y: p.y + v[1] * 85 }, TRIM, 0);
    }
  return segs;
}
const add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });
const mul = (u, k) => ({ x: u.x * k, y: u.y * k });
const offset = (p, n, k) => ({ x: p.x + n.x * k, y: p.y + n.y * k });
function norm(a, b) { const d = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; }
function line(ctx, a, b, col, w) {
  ctx.strokeStyle = col; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function streetLabel(ctx, a, b, text, col = COL.street, off = 22) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  let ang = Math.atan2(b.y - a.y, b.x - a.x);
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
  ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
  ctx.font = 'italic 11px monospace'; ctx.textAlign = 'center';
  haloText(ctx, text, 0, -off, col);
  ctx.restore(); ctx.textAlign = 'left';
}

// every label gets a white halo so it stays readable over lines
function label(ctx, x, y, txt, col, size = 10, bold = false) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px monospace`;
  haloText(ctx, txt, x, y, col);
}
function haloText(ctx, txt, x, y, col) {
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round';
  ctx.strokeText(txt, x, y);
  ctx.fillStyle = col; ctx.fillText(txt, x, y);
}

function drawLegend(ctx, x, y) {
  const rows = [
    ['head', null, 'signal head per approach (lit aspect = current light)'],
    ['bar', COL.qLow, 'queue bar: waiting vehicles (blue→amber→red = worse)'],
    ['dot', '#3c3c3c', 'moving platoon (≈2 vehicles per dot)'],
    ['gate', COL.red, 'boom gates: bars across road = closed'],
    ['bar', COL.train, 'train (one per track, direction = track side)'],
    ['dot', COL.ev, 'priority vehicle (EV) · WALK = pedestrian signal'],
    ['txt', COL.label, 'click an intersection to open its local controller'],
  ];
  ctx.fillStyle = 'rgba(255,255,255,0.93)';
  ctx.strokeStyle = '#bbbbbb'; ctx.lineWidth = 1;
  ctx.fillRect(x - 12, y - 22, 400, rows.length * 19 + 32);
  ctx.strokeRect(x - 12, y - 22, 400, rows.length * 19 + 32);
  label(ctx, x, y - 6, 'LEGEND', '#555', 11, true);
  rows.forEach((r, i) => {
    const yy = y + 14 + i * 19;
    if (r[0] === 'dot') { ctx.fillStyle = r[1]; ctx.beginPath(); ctx.arc(x + 7, yy - 4, 4.5, 0, 7); ctx.fill(); }
    else if (r[0] === 'bar') { ctx.strokeStyle = r[1]; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x, yy - 4); ctx.lineTo(x + 14, yy - 4); ctx.stroke(); }
    else if (r[0] === 'gate') { ctx.strokeStyle = r[1]; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x + 3, yy - 9); ctx.lineTo(x + 3, yy + 1); ctx.moveTo(x + 10, yy - 9); ctx.lineTo(x + 10, yy + 1); ctx.stroke(); }
    else if (r[0] === 'head') {
      ctx.fillStyle = COL.head; roundRect(ctx, x - 1, yy - 10, 30, 12, 4); ctx.fill();
      [COL.red, COL.yellow, COL.green].forEach((c, j) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x + 5 + j * 9, yy - 4, 3.2, 0, 7); ctx.fill(); });
    }
    label(ctx, x + 24, yy, r[2], '#444', 11);
  });
}
