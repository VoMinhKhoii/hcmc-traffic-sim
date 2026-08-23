// physics/queues.js — the macroscopic traffic model.
// Each approach is a number (queued vehicles). Arrivals compound it, green
// discharges it at saturation flow, departures re-appear downstream after a
// travel delay. This is exactly the world an inductive-loop sensor can see.

import { CONFIG, speedMs } from '../config.js';
import {
  INTERSECTIONS, LINKS, APPROACHES, PHASES, DIRS, CROSSINGS, MAIN_PHASE,
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
        // crossFrac: where along this DIRECTED trip the rail crossing sits
        // (null if the link has no crossing)
        const crossFrac = l.crossing ? (from === l.a
          ? CROSSINGS[l.crossing.name].pos
          : 1 - CROSSINGS[l.crossing.name].pos) : null;
        this.pipes[`${l.id}:${from}`] = {
          link: l, from, entries: [],   // {enterT, arriveAt, n}
          entryOpen: true,              // false while boom gates are down
          capFactor: 1,                 // accident throttle on entering this link
          crossFrac, gateDown: false, closeT: 0,
          // mid-block pedestrian hold: mirrors the gate mechanism but keyed
          // by pedestrian WALK rather than a physical boom gate.
          pedFrac: null,   // fractional stop position along this directed pipe (null = no MBP)
          pedDown: false,  // true while pedestrian WALK is active
        };
      }
    }
    // conservation ledger
    this.totIn = 0; this.totOut = 0;
    this.safetyViolations = [];  // vehicles standing on tracks while train present
    // pocket bookkeeping: vehicles between stop line and tracks. Arrivals while
    // the gates are down wait at the GATE (far side), so they are not in the
    // pocket — we snapshot the pocket at gate-close and only let it shrink.
    this.pocket = Object.fromEntries(Object.keys(CROSSINGS)
      .map((name) => [name, { closed: false, q: 0 }]));
  }

  ap(node, dir) { return this.approaches[`${node}:${dir}`]; }

  // ---- one physics step -------------------------------------------------
  // lights: { I1: {state:'GREEN'|'YELLOW'|'ALLRED'|'FLASH', green:'A'|'B'|null}, ... }
  // gatesDown/trainAt are keyed by every name in CROSSINGS.
  // mbpBlocked: { [linkId]: { frac: number, holdT: number } } — links with an
  //   active pedestrian WALK; frac is the stop position (0=from-node, 1=to-node).
  step(dt, t, mode, lights, gatesDown = {}, trainAt = {}, mbpBlocked = {}) {
    // --- sync mid-block pedestrian hold state into pipes ---
    // This mirrors how setGate() works: when a WALK starts we snapshot closeT,
    // and when it ends we release held platoons from the stop point.
    for (const [key, p] of Object.entries(this.pipes)) {
      const linkId = p.link.id;
      const blocked = mbpBlocked[linkId];
      if (blocked && !p.pedDown) {
        // WALK just started: lock entry and record the fractional stop point
        // from the perspective of traffic travelling FROM p.from.
        p.pedDown = true;
        // frac in mbpBlocked is always measured from the canonical link.a end.
        // Flip it for traffic travelling in the opposite direction.
        p.pedFrac = p.from === p.link.a ? blocked.frac : 1 - blocked.frac;
      } else if (!blocked && p.pedDown) {
        // WALK ended (clearing finished): release held platoons from the stop point.
        p.pedDown = false;
        for (const e of p.entries) {
          if (e.pedHeld) {
            // resume: remaining travel is proportional to the part of the link
            // beyond the stop point, same arithmetic as gate release.
            const remainFrac = 1 - p.pedFrac;
            e.arriveAt = t + (e.arriveAt - e.enterT) * remainFrac;
            e.enterT = t;
            e.fromFrac = p.pedFrac;
            e.pedHeld = false;
          }
        }
        p.pedFrac = null;
        p.pedHoldT = null;
      }
    }

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

    // 2) pipe deliveries (vehicles finishing a link). A platoon that had NOT
    // yet passed the rail crossing when the gates closed waits AT the gate —
    // it does not teleport across a closed crossing. Likewise, platoons that
    // have not yet reached the mid-block pedestrian stop point wait there.
    for (const p of Object.values(this.pipes)) {
      if (!p.entries.length) continue;
      const dest = feedsApproach(p.link.id, p.from);
      const da = this.ap(dest.node, dest.dir);
      const keep = [];
      for (const e of p.entries) {
        // railway gate hold
        if (p.gateDown && p.crossFrac !== null &&
            (e.held || e.enterT + (e.arriveAt - e.enterT) * p.crossFrac > p.closeT)) {
          e.held = true;
          keep.push(e);
          continue;
        }
        // mid-block pedestrian hold: clamp any platoon that has not yet
        // passed the stop point. A platoon's fractional progress at time t is
        //   f = (t - enterT) / (arriveAt - enterT)
        // so it reaches pedFrac at t = enterT + pedFrac*(arriveAt-enterT).
        // If that moment is still in the future (> t now), it hasn't passed yet.
        if (p.pedDown && p.pedFrac !== null) {
          const passT = e.enterT + p.pedFrac * (e.arriveAt - e.enterT);
          if (e.pedHeld || passT > t) {
            e.pedHeld = true;
            keep.push(e);
            continue;
          }
        }
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
          // must match the DISPLAYED aspect: flashing yellow = main phase
          factor = PHASES[MAIN_PHASE[node]].includes(d) ? CONFIG.flashFactorMain : CONFIG.flashFactorSide;
        if (factor === 0 || a.q <= 0) continue;

        const tgt = throughTarget(node, d);
        let capFactor = 1;
        if (tgt.type === 'link') {
          const p = this.pipes[`${tgt.link}:${node}`];
          if (!p.entryOpen) continue;          // boom gate down: hold at stop line
          capFactor = p.capFactor;             // accident throttle
        }
        // pedestrian WALK: block discharge on the outbound link for this approach.
        // throughTarget gives the INBOUND side; we need the pipe keyed by the
        // link the approach actually feeds INTO (the approach's own link, from node).
        const outAp = APPROACHES[node][d];
        if (outAp?.link) {
          const outPipe = this.pipes[`${outAp.link}:${node}`];
          if (outPipe?.pedDown) continue;
        }
        const rate = CONFIG.satFlowPerLane * CONFIG.lanes * factor * capFactor;
        const n = Math.min(a.q, rate * dt);
        a.q -= n;
        if (tgt.type === 'exit') this.totOut += n;
        else {
          const p = this.pipes[`${tgt.link}:${node}`];
          const travel = p.link.len / speedMs(CONFIG.speedKmh);
          // coalesce into ~2s platoon buckets (one entry per platoon, not per
          // tick); the bucket arrives when its LAST vehicle would (never early)
          const last = p.entries[p.entries.length - 1];
          if (last && t - last.enterT < 2) { last.n += n; last.arriveAt = t + travel; }
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
      if (trainAt[name] && qMeters > c.pocketLength)
        this.safetyViolations.push({ t, crossing: name, qMeters });
    }
  }

  // ---- controls from railway / incidents --------------------------------
  setGate(crossName, down, t = 0) {
    const c = CROSSINGS[crossName];
    const l = c.link, link = LINKS.find((x) => x.id === l);
    // gates block NEW entry to the crossing link AND hold in-transit platoons
    for (const from of [link.a, link.b]) {
      const pipe = this.pipes[`${l}:${from}`];
      pipe.entryOpen = !down;
      if (down && !pipe.gateDown) { pipe.gateDown = true; pipe.closeT = t; }
      if (!down && pipe.gateDown) {
        pipe.gateDown = false;
        // held platoons resume FROM THE GATE: remaining trip is the part of
        // the link beyond the crossing
        for (const e of pipe.entries)
          if (e.held) {
            e.arriveAt = t + (e.arriveAt - e.enterT) * (1 - pipe.crossFrac);
            e.enterT = t;
            e.fromFrac = pipe.crossFrac;   // renderer: resume FROM the gate, not the link start
            e.held = false;
          }
      }
    }
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
