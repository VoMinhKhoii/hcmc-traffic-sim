// @ts-check
// ui/render.js — schematic map: white ground, black road edges, dashed
// intersection boxes, a 3-aspect signal head per approach, double-track
// railway with angle-aligned gates. Labels carry a white halo so nothing
// becomes unreadable where lines cross. Pure read-only view of the sim.

import { CONFIG } from '../config.js';
import {
  INTERSECTIONS, LINKS, APPROACHES, DIRS, PHASES, CROSSINGS, ROADS,
  MAIN_PHASE, linkById, approachVector, feedsApproach,
} from '../network.js';
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
const EDGE_WIDTH = 2.4;
const LANE_OFFSET = 8;
const HEAD_CLEARANCE = 3;
const APPROACH_STUB_LENGTH = 85;
// With the fixed world-to-screen translation in index.html, the 1150 x 1000
// world viewport exposes these coordinates. Geometry that represents the map
// (rather than the white overscan used to clear the canvas) stays inside it.
const WORLD_BOUNDS = { left: -50, top: -30, right: 1100, bottom: 970 };
// The fitted view always exposes at least x=-50..1100 and y=-30..970.
// Keep UI-like annotations inside a slightly inset, geometry-independent area.
const MAP_LABEL_BOUNDS = { left: 16, top: 12, right: 1084, bottom: 952 };

export function draw(ctx, sim) {
  const t = sim.t;
  const placedLabels = [];
  const roads = roadSegments();
  ctx.fillStyle = COL.bg; ctx.fillRect(-200, -200, 2400, 2400);
  ctx.lineCap = 'butt';

  // ---- roads: two edges + solid center line (no lane clutter) -----------
  for (const s of roads) {
    line(ctx, offset(s.a2, s.n, HALF), offset(s.b2, s.n, HALF), COL.edge, EDGE_WIDTH);
    line(ctx, offset(s.a2, s.n, -HALF), offset(s.b2, s.n, -HALF), COL.edge, EDGE_WIDTH);
    line(ctx, add(s.a2, mul(s.u, 10)), add(s.b2, mul(s.u, -10)), COL.median, 1.8);
  }
  for (const l of LINKS) {
    const A = INTERSECTIONS[l.a], B = INTERSECTIONS[l.b];
    // The 120 m I1-I2 link has no clear span between its two node boxes.
    if (Math.hypot(B.x - A.x, B.y - A.y) >= 170)
      placedLabels.push(streetLabel(ctx, A, B, `${ROADS[l.road] ?? l.road} · ${l.len} m`));
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
  ctx.save();
  clipToBounds(ctx, WORLD_BOUNDS);
  ctx.setLineDash([13, 8]);
  for (const off of [-4, 4])
    line(ctx, offset(r0, rn, off), offset(r1, rn, off), COL.rail, 2.6);
  ctx.setLineDash([]);
  placedLabels.push(streetLabel(ctx, r0, r1,
    'Railway — North–South line (Lê Văn Sỹ)', COL.rail, 26, MAP_LABEL_BOUNDS));
  ctx.restore();

  // ---- vehicles in transit ---------------------------------------------
  ctx.fillStyle = '#3c3c3c';
  for (const p of Object.values(sim.model.pipes)) {
    const from = INTERSECTIONS[p.from];
    const l = p.link, to = INTERSECTIONS[l.a === p.from ? l.b : l.a];
    // Use the destination's actual approach geometry, including the I2-I4
    // diagonal, and stay on the right side of inbound travel.
    const dest = feedsApproach(l.id, p.from);
    const inboundOut = approachVector(dest.node, dest.dir);
    const side = mul({ x: inboundOut.y, y: -inboundOut.x }, LANE_OFFSET);
    for (const e of p.entries) {
      // progress along the link, respecting the crossing: held platoons queue
      // just BEFORE the gate; released ones resume from it (fromFrac)
      const base = e.fromFrac ?? 0;
      let f = base + (1 - base) * Math.min(1, (t - e.enterT) / (e.arriveAt - e.enterT));
      if (e.held) f = Math.min(f, p.crossFrac - 0.015);
      // Pipe entries are real-valued, ~2 s coalesced platoons. Honest rounding
      // keeps sub-0.5 buckets invisible; every rounded vehicle gets one dot.
      const n = Math.round(e.n);
      const vehicleFrac = (CONFIG.vehicleLength / CONFIG.lanes) / l.len;
      for (let i = 0; i < n; i++) {
        const ff = Math.max(0, f - i * vehicleFrac);
        ctx.beginPath();
        ctx.arc(from.x + (to.x - from.x) * ff + side.x, from.y + (to.y - from.y) * ff + side.y, 2.6, 0, 7);
        ctx.fill();
      }
    }
  }

  // ---- intersections: queued vehicles + signal heads + walk -------------
  // All approach furniture follows the ACTUAL road direction (diagonals
  // included), placed on the right-hand side of incoming traffic.
  for (const [n, p] of Object.entries(INTERSECTIONS)) {
    const L = sim.locals[n].machine;
    for (const d of DIRS) {
      const w = approachVector(n, d);            // unit vector out along the road
      const rside = { x: w.y, y: -w.x };         // right side of INCOMING traffic
      const q = sim.model.ap(n, d).q;
      const count = Math.round(q);
      const qColor = q > CONFIG.congestionThreshold ? COL.qHigh
        : q > CONFIG.congestionThreshold * 0.6 ? COL.qMid : COL.qLow;
      const geom = queueGeometry(n, d);
      const shown = Math.min(count, geom.capacity);
      for (let i = 0; i < shown; i++) {
        const dist = geom.start + i * geom.spacing;
        ctx.fillStyle = qColor;
        ctx.beginPath();
        ctx.arc(p.x + w.x * dist + rside.x * LANE_OFFSET,
          p.y + w.y * dist + rside.y * LANE_OFFSET, 2.4, 0, 7);
        ctx.fill();
      }
      const clipped = count > geom.capacity;
      if (clipped) drawQueueClamp(ctx, p, w, rside, geom.end, qColor);
      if (q >= 8) {
        const labelDist = Math.min(geom.end, geom.start + Math.max(0, shown - 1) * geom.spacing) + 14;
        const text = clipped ? `(${count} · clipped)` : `(${count})`;
        const pos = boundedLabelPosition(ctx,
          p.x + w.x * labelDist + rside.x * LANE_OFFSET,
          p.y + w.y * labelDist + rside.y * LANE_OFFSET,
          text, 11, true, WORLD_BOUNDS);
        label(ctx, pos.x, pos.y, text, qColor, 11, true, 'center', 'middle');
      }
      drawHead(ctx, n, d, p, w, rside, L, t);
    }
    // Centered, opaque badges remain legible without following (and landing
    // on) a diagonal road. Stack transient state immediately around the box.
    let topBadgeY = p.y - HALF - 15;
    if (L.walk) { statusBadge(ctx, p.x, topBadgeY, 'WALK', COL.walk); topBadgeY -= 18; }
    if (sim.bus.linkUp[n] === false) statusBadge(ctx, p.x, topBadgeY, '✕ LINK DOWN', COL.red);
    label(ctx, p.x, p.y + 1, n, COL.label, 13, true, 'center', 'middle');
    const pre = sim.locals[n].overlay.active();
    if (pre) statusBadge(ctx, p.x, p.y + HALF + 18,
      pre === 'TRAIN' ? '⛔ RAIL PREEMPT' : '⚡ EV PREEMPT',
      pre === 'TRAIN' ? COL.red : COL.ev);
  }

  // ---- trains: one per track (offset by direction), white-outlined so they
  // read as vehicles on the track rather than more red line-work
  ctx.save();
  clipToBounds(ctx, WORLD_BOUNDS);
  ctx.lineCap = 'round';
  for (const tr of sim.trains.trains) {
    const trackOff = tr.dir === 1 ? 5 : -5;
    const a = offset(RAIL.xy(tr.s), rn, trackOff), b = offset(RAIL.xy(tr.s - tr.dir * 120), rn, trackOff);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = COL.train; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.restore();

  // ---- crossings drawn ABOVE the trains: gates must stay visible ---------
  for (const [name, c] of Object.entries(CROSSINGS)) {
    const l = linkById(c.link), A = INTERSECTIONS[l.a], B = INTERSECTIONS[l.b];
    const x = A.x + (B.x - A.x) * c.pos, y = A.y + (B.y - A.y) * c.pos;
    const roadAng = Math.atan2(B.y - A.y, B.x - A.x);
    const cr = sim.railway.crossings[name];
    const down = cr.state !== 'OPEN';
    const arm = barrierDownFraction(cr, t);
    ctx.save(); ctx.translate(x, y); ctx.rotate(roadAng);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 7.5;   // halo separates gates from train
    gateBars(ctx, arm);
    ctx.strokeStyle = down ? COL.red : COL.green; ctx.lineWidth = 4.5;   // BROKEN implies down
    gateBars(ctx, arm);
    ctx.lineCap = 'butt';
    if (cr.flashers && Math.floor(t * 2) % 2 === 0) {
      ctx.fillStyle = COL.red;
      ctx.beginPath(); ctx.arc(-HALF - 8, -HALF - 8, 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(HALF + 8, HALF + 8, 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // Try both sides of the railway, with modest along-track nudges. Measured
    // boxes keep crossing names clear of roads, street names, the rail name,
    // and crossing labels selected earlier in this pass.
    const text = `Crossing ${name}`;
    const indication = cr.fault || cr.armFailed;
    const pos = crossingLabelPosition(ctx, { x, y }, text, down, indication,
      ru, rn, roads, placedLabels);
    label(ctx, pos.x, pos.y, text, down ? COL.red : COL.label,
      11, down, 'center', 'middle');
    if (indication) label(ctx, pos.x, pos.y + 14,
      cr.fault ? 'GATE FAULT' : 'ARM FAILED', cr.fault ? COL.red : '#e65100',
      11, true, 'center', 'middle');
    placedLabels.push(pos.box);
  }

  // Fixed map-status chip: never follows an off-canvas rail endpoint.
  statusBadge(ctx, 112, 688,
    sim.trains.signalRed ? 'TRAIN SIGNAL: RED' : 'TRAIN SIGNAL: GREEN',
    sim.trains.signalRed ? COL.red : COL.green);

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
// Heads are AXIS-ALIGNED with a fixed, familiar aspect order — vertical heads
// read red-top→green-bottom, horizontal heads red-left→green-right — no
// matter which way the road runs. Orientation: perpendicular to the road's
// dominant axis. Placed outside the road on the right of incoming traffic.
function drawHead(ctx, node, d, p, w, rside, L, t) {
  let lit = 'red', blink = false;
  if (L.state === 'GREEN') lit = PHASES[L.phase].includes(d) ? 'green' : 'red';
  else if (L.state === 'YELLOW') lit = PHASES[L.phase].includes(d) ? 'yellow' : 'red';
  else if (L.state === 'FLASH') { lit = PHASES[MAIN_PHASE[node]].includes(d) ? 'yellow' : 'red'; blink = true; }
  const on = !blink || Math.floor(t * 1.6) % 2 === 0;

  const vertical = Math.abs(w.x) >= Math.abs(w.y);   // E-W-ish road → vertical head
  const headW = vertical ? 15 : 38, headH = vertical ? 38 : 15;
  // An axis-aligned rectangle's projection onto an arbitrary unit axis is
  // |axis.x|*width/2 + |axis.y|*height/2. Include both projections so the
  // head clears the road edge laterally and the node box longitudinally at
  // every road angle, not just horizontal/vertical ones.
  const lateralOffset = HALF + EDGE_WIDTH / 2 + HEAD_CLEARANCE
    + Math.abs(rside.x) * headW / 2 + Math.abs(rside.y) * headH / 2;
  const longitudinalOffset = HALF + 3 + HEAD_CLEARANCE
    + Math.abs(w.x) * headW / 2 + Math.abs(w.y) * headH / 2;
  const cx = p.x + w.x * longitudinalOffset + rside.x * lateralOffset;
  const cy = p.y + w.y * longitudinalOffset + rside.y * lateralOffset;
  ctx.fillStyle = COL.head;
  roundRect(ctx, cx - headW / 2, cy - headH / 2, headW, headH, 6);
  ctx.fill();
  ['red', 'yellow', 'green'].forEach((c, i) => {
    ctx.fillStyle = c === lit && on ? COL[c] : COL.unlit;
    ctx.beginPath();
    if (vertical) ctx.arc(cx, cy - 11.5 + i * 11.5, 4.3, 0, 7);
    else ctx.arc(cx - 11.5 + i * 11.5, cy, 4.3, 0, 7);
    ctx.fill();
  });
}

function barrierDownFraction(c, t) {
  if (c.renderAction === 'DOWN') {
    const animationT = c.armFailed && !c.provedDown
      ? Math.min(t, c.armFailedAt ?? t) : t;
    return clamp((animationT - c.renderActionAt) / CONFIG.barrierTravel, 0, 1);
  }
  return 1 - clamp((t - c.renderActionAt) / CONFIG.barrierTravel, 0, 1);
}

function gateBars(ctx, downFraction) {
  const f = clamp(downFraction, 0, 1);
  const mix = (up, down) => up + (down - up) * f;
  ctx.beginPath();
  ctx.moveTo(-HALF + 2, mix(-HALF - 10, -HALF));
  ctx.lineTo(-HALF + 2, mix(-HALF + 2, HALF));
  ctx.moveTo(HALF - 2, mix(HALF + 10, -HALF));
  ctx.lineTo(HALF - 2, mix(HALF - 2, HALF));
  ctx.stroke();
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
      push(p, {
        x: p.x + v[0] * APPROACH_STUB_LENGTH,
        y: p.y + v[1] * APPROACH_STUB_LENGTH,
      }, TRIM, 0);
    }
  return segs;
}

// Queue spacing is the model's per-lane standing footprint, converted from
// metres with the actual link scale. Boundary stubs borrow a connected link's
// scale because they have no modeled length, and clamp at the visible stub.
// Internal queues stop before the upstream node box: the model has no storage
// limit/spillback, so drawing farther would claim physics that does not exist.
function queueGeometry(node, dir) {
  const ap = APPROACHES[node][dir];
  const p = INTERSECTIONS[node];
  let metresPerCanvasUnit;
  let end = APPROACH_STUB_LENGTH;
  if (ap.link) {
    const l = linkById(ap.link);
    const other = INTERSECTIONS[l.a === node ? l.b : l.a];
    const canvasLength = Math.hypot(other.x - p.x, other.y - p.y);
    metresPerCanvasUnit = l.len / canvasLength;
    end = canvasLength - (HALF + 6);
  } else {
    const opposite = { N: 'S', S: 'N', E: 'W', W: 'E' }[dir];
    const fallback = APPROACHES[node][opposite].link
      ? linkById(APPROACHES[node][opposite].link)
      : LINKS.find((l) => l.a === node || l.b === node);
    const other = INTERSECTIONS[fallback.a === node ? fallback.b : fallback.a];
    metresPerCanvasUnit = fallback.len / Math.hypot(other.x - p.x, other.y - p.y);
  }
  const start = HALF + 6;
  const spacing = (CONFIG.vehicleLength / CONFIG.lanes) / metresPerCanvasUnit;
  const w = approachVector(node, dir);
  const rside = { x: w.y, y: -w.x };
  const origin = add(p, mul(rside, LANE_OFFSET));
  // Include the overflow clamp's full footprint (along/across the queue) and
  // stroke width. This applies to internal links and boundary stubs alike.
  const padX = Math.max(2.4, Math.abs(w.x) * 3 + Math.abs(rside.x) * 5 + 1);
  const padY = Math.max(2.4, Math.abs(w.y) * 3 + Math.abs(rside.y) * 5 + 1);
  end = Math.min(end, rayDistanceInsideBounds(origin, w, WORLD_BOUNDS, padX, padY));
  const capacity = Math.max(0, Math.floor((end - start) / spacing) + 1);
  return { start, end, spacing, capacity };
}

function drawQueueClamp(ctx, p, w, rside, dist, color) {
  const center = add(add(p, mul(w, dist)), mul(rside, LANE_OFFSET));
  ctx.strokeStyle = color; ctx.lineWidth = 1.8;
  for (const along of [-3, 3]) {
    const c = add(center, mul(w, along));
    ctx.beginPath();
    ctx.moveTo(c.x + rside.x * 5, c.y + rside.y * 5);
    ctx.lineTo(c.x - rside.x * 5, c.y - rside.y * 5);
    ctx.stroke();
  }
}
const add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });
const mul = (u, k) => ({ x: u.x * k, y: u.y * k });
const offset = (p, n, k) => ({ x: p.x + n.x * k, y: p.y + n.y * k });
function norm(a, b) { const d = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; }
function line(ctx, a, b, col, w) {
  ctx.strokeStyle = col; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
}
function clipToBounds(ctx, bounds) {
  ctx.beginPath();
  ctx.rect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  ctx.clip();
}

function rayDistanceInsideBounds(origin, direction, bounds, padX, padY) {
  let distance = Infinity;
  if (direction.x > 0) distance = Math.min(distance, (bounds.right - padX - origin.x) / direction.x);
  if (direction.x < 0) distance = Math.min(distance, (bounds.left + padX - origin.x) / direction.x);
  if (direction.y > 0) distance = Math.min(distance, (bounds.bottom - padY - origin.y) / direction.y);
  if (direction.y < 0) distance = Math.min(distance, (bounds.top + padY - origin.y) / direction.y);
  return Math.max(0, distance);
}

function boundedLabelPosition(ctx, x, y, text, size, bold, bounds) {
  ctx.save();
  ctx.font = `${bold ? 'bold ' : ''}${size}px monospace`;
  const halfWidth = ctx.measureText(text).width / 2 + 2; // include text halo
  ctx.restore();
  const halfHeight = size / 2 + 2;
  return {
    x: clamp(x, bounds.left + halfWidth, bounds.right - halfWidth),
    y: clamp(y, bounds.top + halfHeight, bounds.bottom - halfHeight),
  };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function streetLabel(ctx, a, b, text, col = COL.street, off = 22, bounds = null) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  let ang = Math.atan2(b.y - a.y, b.x - a.x);
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
  ctx.save();
  ctx.font = 'italic 11px monospace';
  const metrics = ctx.measureText(text);
  const w = metrics.width + 5, h = 15;
  const ex = Math.abs(Math.cos(ang)) * w / 2 + Math.abs(Math.sin(ang)) * h / 2;
  const ey = Math.abs(Math.sin(ang)) * w / 2 + Math.abs(Math.cos(ang)) * h / 2;
  let cx = mx + Math.sin(ang) * off;
  let cy = my - Math.cos(ang) * off;
  if (bounds) {
    cx = clamp(cx, bounds.left + ex, bounds.right - ex);
    cy = clamp(cy, bounds.top + ey, bounds.bottom - ey);
  }
  ctx.translate(cx, cy); ctx.rotate(ang);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  haloText(ctx, text, 0, 0, col);
  ctx.restore();
  return { left: cx - ex, right: cx + ex, top: cy - ey, bottom: cy + ey };
}

function crossingLabelPosition(ctx, crossing, text, bold, fault, ru, rn, roads, labels) {
  ctx.save();
  ctx.font = `${bold ? 'bold ' : ''}11px monospace`;
  const faultWidth = fault ? ctx.measureText('GATE FAULT').width : 0;
  const w = Math.max(ctx.measureText(text).width, faultWidth) + 6;
  ctx.restore();
  const h = fault ? 29 : 15;
  const normalOffset = 52;
  const candidates = [];
  for (const side of [1, -1]) {
    for (const along of [0, 28, -28, 56, -56]) {
      const x = crossing.x + rn.x * normalOffset * side + ru.x * along;
      const y = crossing.y + rn.y * normalOffset * side + ru.y * along;
      const box = { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 };
      if (!containsBox(MAP_LABEL_BOUNDS, box)) continue;
      const roadClearance = Math.min(...roads.map((road) =>
        pointSegmentDistance({ x, y }, road.a2, road.b2)));
      const labelClearance = labels.length
        ? Math.min(...labels.map((other) => boxDistance(box, other)))
        : 100;
      const overlaps = labels.reduce((sum, other) => sum + overlapArea(box, other), 0);
      candidates.push({ x, y: fault ? y - 7 : y, box,
        score: roadClearance + Math.min(labelClearance, 100) * 1.5 - overlaps * 1000 });
    }
  }
  // Current map geometry always yields candidates; retain a bounded fallback
  // so future crossings near an edge cannot make rendering fail.
  if (!candidates.length) {
    const x = clamp(crossing.x + rn.x * normalOffset,
      MAP_LABEL_BOUNDS.left + w / 2, MAP_LABEL_BOUNDS.right - w / 2);
    const y = clamp(crossing.y + rn.y * normalOffset,
      MAP_LABEL_BOUNDS.top + h / 2, MAP_LABEL_BOUNDS.bottom - h / 2);
    return { x, y: fault ? y - 7 : y,
      box: { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 },
      score: -Infinity };
  }
  return candidates.reduce((best, candidate) =>
    !best || candidate.score > best.score ? candidate : best, null);
}

function containsBox(bounds, box) {
  return box.left >= bounds.left && box.right <= bounds.right
    && box.top >= bounds.top && box.bottom <= bounds.bottom;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function boxDistance(a, b) {
  const dx = Math.max(b.left - a.right, a.left - b.right, 0);
  const dy = Math.max(b.top - a.bottom, a.top - b.bottom, 0);
  return Math.hypot(dx, dy);
}

function overlapArea(a, b) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// every label gets a white halo so it stays readable over lines
function label(ctx, x, y, txt, col, size = 10, bold = false, align = 'left', baseline = 'alphabetic') {
  ctx.save();
  ctx.font = `${bold ? 'bold ' : ''}${size}px monospace`;
  ctx.textAlign = align; ctx.textBaseline = baseline;
  haloText(ctx, txt, x, y, col);
  ctx.restore();
}
function haloText(ctx, txt, x, y, col) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round';
  ctx.strokeText(txt, x, y);
  ctx.fillStyle = col; ctx.fillText(txt, x, y);
  ctx.restore();
}

function statusBadge(ctx, x, y, txt, col) {
  ctx.save();
  ctx.font = 'bold 11px monospace';
  const padX = 5, h = 15, w = ctx.measureText(txt).width + padX * 2;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = col; ctx.lineWidth = 1;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 4);
  ctx.fill(); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = col; ctx.fillText(txt, x, y + 0.5);
  ctx.restore();
}

function drawLegend(ctx, x, y) {
  const rows = [
    ['head', null, 'signal head per approach (lit aspect = current light)'],
    ['dot', COL.qLow, 'waiting vehicle: 1 dot = 1 vehicle (clipped label = off-link total)'],
    ['dot', '#3c3c3c', 'moving vehicle: 1 dot = 1 vehicle'],
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
