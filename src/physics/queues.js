// physics/queues.js — the macroscopic traffic model.
// Each approach is a number (queued vehicles). Arrivals compound it, green
// discharges it at saturation flow, departures re-appear downstream after a
// travel delay. This is exactly the world an inductive-loop sensor can see.

import { CONFIG, speedMs } from '../config.js';
import {
  INTERSECTIONS, LINKS, APPROACHES, PHASES, DIRS, CROSSINGS,
  throughTarget, approachClass, feedsApproach,
} from '../network.js';

export class TrafficModel {
  constructor() {
    this.approaches = {};   // "I1:N" -> approach state
    this.pipes = {};        // "I1-I3:I1" -> in-transit vehicles (directed)
    for (const node of Object.keys(INTERSECTIONS)) {
      for (const d of DIRS) {
        this.approaches[`${node}:${d}`] = {
          node, dir: d, cls: approachClass(node, d),
          q: 0,              // queued vehicles
          lastArrival: -1e9, // sim time of last arrival (actuated detector)
          pedButton: false,  // pushed and not yet served
          arrivedFrac: 0,    // fractional accumulator for detection events
        };
      }
    }
    for (const l of LINKS) {
      for (const from of [l.a, l.b]) {
        this.pipes[`${l.id}:${from}`] = {
          link: l, from, entries: [],   // {enterT, arriveAt, n}
          entryOpen: true,              // false while boom gates are down
          capFactor: 1,                 // accident throttle on entering this link
        };
      }
    }
    // conservation ledger
    this.totIn = 0; this.totOut = 0;
    this.safetyViolations = [];  // vehicles standing on tracks while train present
    // pocket bookkeeping: vehicles between stop line and tracks. Arrivals while
    // the gates are down wait at the GATE (far side), so they are not in the
    // pocket — we snapshot the pocket at gate-close and only let it shrink.
    this.pocket = { A: { closed: false, q: 0 }, B: { closed: false, q: 0 } };
  }

  ap(node, dir) { return this.approaches[`${node}:${dir}`]; }

  // ---- one physics step -------------------------------------------------
  // lights: { I1: {state:'GREEN'|'YELLOW'|'ALLRED'|'FLASH', green:'A'|'B'|null}, ... }
  // gatesDown: {A:bool, B:bool}; trainAt: {A:bool, B:bool} (train occupying crossing zone)
  step(dt, t, mode, lights, gatesDown = {}, trainAt = {}) {
    // 1) external arrivals
    for (const a of Object.values(this.approaches)) {
      const spec = APPROACHES[a.node][a.dir];
      if (!spec.ext) continue;
      const lam = CONFIG.demand[mode][a.cls] * CONFIG.demandMultiplier;
      const add = lam * dt;
      a.q += add; this.totIn += add;
      a.arrivedFrac += add;
      if (a.arrivedFrac >= 1) { a.arrivedFrac -= 1; a.lastArrival = t; }
    }

    // 2) pipe deliveries (vehicles finishing a link)
    for (const p of Object.values(this.pipes)) {
      if (!p.entries.length) continue;
      const dest = feedsApproach(p.link.id, p.from);
      const da = this.ap(dest.node, dest.dir);
      const keep = [];
      for (const e of p.entries) {
        if (e.arriveAt <= t) {
          da.q += e.n; da.arrivedFrac += e.n;
          if (da.arrivedFrac >= 1) { da.arrivedFrac -= 1; da.lastArrival = t; }
        } else keep.push(e);
      }
      p.entries = keep;
    }

    // 3) discharge on green / flash
    for (const [node, L] of Object.entries(lights)) {
      for (const d of DIRS) {
        const a = this.ap(node, d);
        let factor = 0;
        if (L.state === 'GREEN' && L.green && PHASES[L.green].includes(d)) factor = 1;
        else if (L.state === 'FLASH')
          factor = a.cls === 'main' ? CONFIG.flashFactorMain : CONFIG.flashFactorSide;
        if (factor === 0 || a.q <= 0) continue;

        const tgt = throughTarget(node, d);
        let capFactor = 1;
        if (tgt.type === 'link') {
          const p = this.pipes[`${tgt.link}:${node}`];
          if (!p.entryOpen) continue;             // gate down: hold at stop line
          capFactor = p.capFactor;                // accident throttle
        }
        const rate = CONFIG.satFlowPerLane * CONFIG.lanes * factor * capFactor;
        const n = Math.min(a.q, rate * dt);
        a.q -= n;
        if (tgt.type === 'exit') this.totOut += n;
        else {
          const p = this.pipes[`${tgt.link}:${node}`];
          const travel = p.link.len / speedMs(CONFIG.speedKmh);
          // coalesce into ~2s platoon buckets (one entry per platoon, not per tick)
          const last = p.entries[p.entries.length - 1];
          if (last && t - last.enterT < 2) last.n += n;
          else p.entries.push({ enterT: t, arriveAt: t + travel, n });
        }
      }
    }

    // 4) railway safety check: does the PRE-CLOSURE pocket queue still reach
    // back over the tracks while a train is present?
    for (const [name, c] of Object.entries(CROSSINGS)) {
      const a = this.ap(c.intersection, c.pocketApproach);
      const p = this.pocket[name];
      if (p.closed) p.q = Math.min(p.q, a.q);        // discharge shrinks it; gate-side arrivals don't grow it
      const qMeters = (p.q * CONFIG.vehicleLength) / CONFIG.lanes;
      if (trainAt[name] && qMeters > CONFIG.crossingPocket)
        this.safetyViolations.push({ t, crossing: name, qMeters });
    }
  }

  // ---- controls from railway / incidents --------------------------------
  setGate(crossName, down) {
    const c = CROSSINGS[crossName];
    const l = c.link;
    // gates block NEW entry to the crossing link from both ends
    this.pipes[`${l}:${LINKS.find((x) => x.id === l).a}`].entryOpen = !down;
    this.pipes[`${l}:${LINKS.find((x) => x.id === l).b}`].entryOpen = !down;
    const p = this.pocket[crossName];
    if (down && !p.closed) { p.closed = true; p.q = this.ap(c.intersection, c.pocketApproach).q; }
    if (!down) p.closed = false;
  }
  setAccident(linkId, from, factor) {
    this.pipes[`${linkId}:${from}`].capFactor = factor;
  }

  // ---- sensor view (all a local controller may see about itself) --------
  sensors(node, t) {
    const s = {};
    for (const d of DIRS) {
      const a = this.ap(node, d);
      s[d] = {
        q: a.q,
        detection: t - a.lastArrival < CONFIG.gapOut || a.q >= 1,
        pedButton: a.pedButton,
      };
    }
    return s;
  }
  pressPed(node, dir) { this.ap(node, dir).pedButton = true; }
  clearPed(node, dirs) { for (const d of dirs) this.ap(node, d).pedButton = false; }

  // ---- accounting -------------------------------------------------------
  inNetwork() {
    let n = 0;
    for (const a of Object.values(this.approaches)) n += a.q;
    for (const p of Object.values(this.pipes)) for (const e of p.entries) n += e.n;
    return n;
  }
  conservationError() { return this.totIn - this.totOut - this.inNetwork(); }
}
