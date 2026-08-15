// physics/incidents.js — accidents (link capacity drops) and the priority
// vehicle entity. Both are OPERATOR-triggered inputs; the control system's
// response to them lives in the actors, not here.

import { CONFIG, speedMs } from '../config.js';
import { INTERSECTIONS, APPROACHES, LINKS, DIRS, OPPOSITE, CROSSINGS, linkById } from '../network.js';

export class IncidentSystem {
  constructor(model) {
    this.model = model;
    this.accidents = [];   // {linkId, from, factor, until}
    this.ev = null;        // active priority vehicle
    this.events = [];      // {type:'EV_PASSED'|'EV_DONE', node}
  }

  // ---- accident ---------------------------------------------------------
  dropAccident(linkId, from, lanesBlocked = 1, duration = CONFIG.accidentDuration, t = 0) {
    const factor = lanesBlocked >= CONFIG.lanes ? 0 : 0.5;
    this.accidents.push({ linkId, from, factor, until: t + duration });
    // apply the WORST active factor on this directed link, not the newest
    const active = this.accidents.filter((a) => a.linkId === linkId && a.from === from);
    this.model.setAccident(linkId, from, Math.min(...active.map((a) => a.factor)));
  }

  // ---- priority vehicle -------------------------------------------------
  // route: ordered intersection ids, e.g. ['I1','I2','I4']
  dispatchEV(route, t) {
    const legs = [];
    let dist = 200;                       // EV starts 200 m outside the network
    const speed = speedMs(CONFIG.evSpeedKmh);
    for (let i = 0; i < route.length; i++) {
      const node = route[i];
      // approach side: opposite the exit toward route[1] for the entry node,
      // else the side connected to the previous node
      const approach = i === 0
        ? OPPOSITE[dirFrom(route[0], route[1])]
        : dirFrom(route[i], route[i - 1]);
      legs.push({ node, approach, atDist: dist, eta: t + dist / speed });
      if (i < route.length - 1) dist += linkBetween(route[i], route[i + 1]).len;
    }
    this.ev = { route, legs, s: 0, speed, t0: t, idx: 0, done: false };
    return legs;                          // central uses these ETAs for PREEMPT
  }

  step(dt, t, gatesDown) {
    // accident expiry: recompute each affected directed link's factor from the
    // accidents STILL active (overlapping accidents must not restore early)
    const expired = this.accidents.filter((a) => t >= a.until);
    if (expired.length) {
      this.accidents = this.accidents.filter((a) => t < a.until);
      for (const x of expired) {
        const remaining = this.accidents.filter((a) => a.linkId === x.linkId && a.from === x.from);
        this.model.setAccident(x.linkId, x.from, remaining.length ? Math.min(...remaining.map((a) => a.factor)) : 1);
      }
    }

    // EV movement: sirens clear traffic, but gates + trains outrank the EV.
    const ev = this.ev;
    if (ev && !ev.done) {
      let v = ev.speed;
      const gate = this.gateAheadOnRoute(ev);
      if (gate && gatesDown[gate.name] && gate.atDist - ev.s < 60 && gate.atDist > ev.s) v = 0;
      ev.s += v * dt;
      while (ev.idx < ev.legs.length && ev.s >= ev.legs[ev.idx].atDist) {
        this.events.push({ type: 'EV_PASSED', node: ev.legs[ev.idx].node });
        ev.idx++;
      }
      if (ev.idx >= ev.legs.length && ev.s > ev.legs[ev.legs.length - 1].atDist + 150) {
        ev.done = true;
        this.events.push({ type: 'EV_DONE' });
      }
    }
  }

  // nearest crossing AHEAD of the EV on its route (a passed crossing no longer
  // matters, and a route may cross both A and B)
  gateAheadOnRoute(ev) {
    let best = null;
    for (let i = 0; i < ev.route.length - 1; i++) {
      const l = linkBetween(ev.route[i], ev.route[i + 1]);
      for (const [name, c] of Object.entries(CROSSINGS)) {
        if (c.link !== l.id) continue;
        const along = l.a === ev.route[i] ? c.pos : 1 - c.pos;  // c.pos is fraction from l.a
        const atDist = ev.legs[i].atDist + along * l.len;
        if (atDist > ev.s && (!best || atDist < best.atDist)) best = { name, atDist };
      }
    }
    return best;
  }

  drainEvents() { const e = this.events; this.events = []; return e; }

  // EV canvas position for rendering
  evXY() {
    const ev = this.ev;
    if (!ev || ev.done) return null;
    // walk the polyline: pre-run segment then node-to-node
    let remaining = ev.s;
    const pts = ev.route.map((n) => INTERSECTIONS[n]);
    // entry point: 200m before first node, along direction from first to second, reversed
    const d0 = norm(pts[0], pts[1]);
    const scale0 = linkBetween(ev.route[0], ev.route[1]).len / dist2(pts[0], pts[1]);
    let prev = { x: pts[0].x - d0.x * (200 / scale0), y: pts[0].y - d0.y * (200 / scale0) };
    const segs = [{ from: prev, to: pts[0], len: 200 }];
    for (let i = 0; i < pts.length - 1; i++)
      segs.push({ from: pts[i], to: pts[i + 1], len: linkBetween(ev.route[i], ev.route[i + 1]).len });
    for (const s of segs) {
      if (remaining <= s.len) {
        const f = remaining / s.len;
        return { x: s.from.x + (s.to.x - s.from.x) * f, y: s.from.y + (s.to.y - s.from.y) * f };
      }
      remaining -= s.len;
    }
    const last = segs[segs.length - 1];
    return { x: last.to.x, y: last.to.y };
  }
}

function linkBetween(a, b) {
  const l = LINKS.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  if (!l) throw new Error(`no link ${a}-${b}`);
  return l;
}
function dirFrom(node, from) {
  for (const d of DIRS) {
    const ap = APPROACHES[node][d];
    if (ap.link) { const l = linkById(ap.link); if (l.a === from || l.b === from) return d; }
  }
  throw new Error(`no approach at ${node} from ${from}`);
}
function dist2(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function norm(a, b) { const d = dist2(a, b); return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; }
