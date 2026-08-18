// physics/trains.js — train schedule + movement along the double-track corridor.
// Emits approach/clear events per crossing; the RailwayController turns those
// into gates, flashers and messages. Trains obey the train signal (red = stop).

import { CONFIG, speedMs } from '../config.js';
import { INTERSECTIONS, CROSSINGS, linkById } from '../network.js';

// Rail geometry: the line through reference crossings A and B, extended 600 m
// beyond the outermost modeled crossing. Every crossing's rail coordinate is
// computed by projection onto that axis (C is not a special case).
function crossingXY(name) {
  const c = CROSSINGS[name];
  const l = linkById(c.link);
  const A = INTERSECTIONS[l.a], B = INTERSECTIONS[l.b];
  return { x: A.x + (B.x - A.x) * c.pos, y: A.y + (B.y - A.y) * c.pos };
}
export const RAIL = (() => {
  const names = Object.keys(CROSSINGS);
  const a = crossingXY('A'), b = crossingXY('B');
  const dx = b.x - a.x, dy = b.y - a.y;
  const drawLen = Math.hypot(dx, dy);
  const AB = 700;                       // meters between crossings along the rail
  const scale = AB / drawLen;           // meters per canvas unit
  const ux = dx / drawLen, uy = dy / drawLen;
  const margin = 600;                   // rail modeled 600 m past each crossing
  const offsets = Object.fromEntries(names.map((name) => {
    const p = crossingXY(name);
    return [name, ((p.x - a.x) * ux + (p.y - a.y) * uy) * scale];
  }));
  const minOffset = Math.min(...Object.values(offsets));
  const maxOffset = Math.max(...Object.values(offsets));
  const crossingS = Object.fromEntries(names
    .map((name) => [name, margin + offsets[name] - minOffset]));
  const origin = {
    x: a.x + ux * minOffset / scale,
    y: a.y + uy * minOffset / scale,
  };
  return {
    a, b, ux, uy, scale, crossingS,
    total: maxOffset - minOffset + 2 * margin,
    s(name) { return crossingS[name]; },
    xy(s) {
      const d = (s - margin) / scale;
      return { x: origin.x + ux * d, y: origin.y + uy * d };
    },
  };
})();

const TRAIN_LEN = 120; // m

export class TrainSystem {
  constructor() {
    this.trains = [];        // {id, s, dir(+1 A→B / -1), speed, warned, cleared}
    this.nextSpawn = 60;     // first train 1 sim-minute in
    this.nextId = 1;
    this.redCrossings = Object.fromEntries(Object.keys(CROSSINGS)
      .map((name) => [name, false]));  // per-crossing train signal (gate fault)
    this.lastMode = null;
    this.events = [];        // {type:'APPROACH'|'CLEAR', crossing, eta}
  }

  // legacy aggregate view: red if ANY crossing signal is red
  get signalRed() { return Object.values(this.redCrossings).some(Boolean); }
  set signalRed(v) {
    for (const name of Object.keys(CROSSINGS)) this.redCrossings[name] = v;
  }

  forceTrain(dir = 1) { this.spawn(dir); }

  spawn(dir) {
    this.trains.push({
      id: this.nextId++, dir,
      s: dir === 1 ? 0 : RAIL.total,
      speed: speedMs(CONFIG.trainSpeedKmh),
      warned: {}, cleared: {},
    });
  }

  step(dt, t, mode) {
    // scheduled spawns (assumption noted in TIMINGS.md: night trains modeled
    // every night at 20-min headway; brief's Fri/Sat-only detail is a display
    // note). On a mode change, re-anchor the schedule to the NEW headway so a
    // pre-peak spawn doesn't leave peak running on the off-peak timetable.
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      if (Number.isFinite(this.nextSpawn))   // Infinity = scheduler disabled (tests)
        this.nextSpawn = Math.min(this.nextSpawn, t + CONFIG.headway[mode]);
    }
    if (t >= this.nextSpawn) {
      this.spawn(this.nextId % 2 === 0 ? 1 : -1);
      this.nextSpawn = t + CONFIG.headway[mode];
    }

    for (const tr of this.trains) {
      // a red signal at a SPECIFIC crossing stops the train 80 m before THAT
      // crossing; a healthy crossing on the same corridor is unaffected
      let v = tr.speed;
      const next = this.nextCrossing(tr);
      if (next && this.redCrossings[next.name]) {
        const stopAt = next.s - tr.dir * 80;
        if (tr.dir === 1 && tr.s + v * dt > stopAt && tr.s <= stopAt) v = Math.max(0, (stopAt - tr.s) / dt);
        if (tr.dir === -1 && tr.s - v * dt < stopAt && tr.s >= stopAt) v = Math.max(0, (tr.s - stopAt) / dt);
        if (Math.abs(tr.s - stopAt) < 1) v = 0;
      }
      tr.s += tr.dir * v * dt;

      for (const name of Object.keys(CROSSINGS)) {
        const cs = RAIL.s(name);
        const dist = tr.dir === 1 ? cs - tr.s : tr.s - cs;
        const eta = v > 0 ? dist / v : Infinity;
        if (!tr.warned[name] && dist > 0 && eta <= CONFIG.trainWarning) {
          tr.warned[name] = true;
          this.events.push({ type: 'APPROACH', crossing: name, train: tr.id, eta });
        }
        // CLEAR only once the train's REAR is past the crossing's occupancy
        // zone (+80 m), so gates never begin raising under an occupying train
        const back = tr.s - tr.dir * TRAIN_LEN;
        const passed = tr.dir === 1 ? back > cs + 80 : back < cs - 80;
        if (tr.warned[name] && !tr.cleared[name] && passed) {
          tr.cleared[name] = true;
          this.events.push({ type: 'CLEAR', crossing: name, train: tr.id });
        }
      }
    }
    this.trains = this.trains.filter((tr) => tr.s > -TRAIN_LEN - 10 && tr.s < RAIL.total + TRAIN_LEN + 10);
  }

  nextCrossing(tr) {
    const ahead = Object.keys(CROSSINGS)
      .map((name) => ({ name, s: RAIL.s(name) }))
      .filter((c) => (tr.dir === 1 ? c.s > tr.s : c.s < tr.s));
    if (!ahead.length) return null;
    return ahead.reduce((m, c) => (tr.dir === 1 ? (c.s < m.s ? c : m) : (c.s > m.s ? c : m)));
  }

  // is any train occupying crossing zone (±60 m)?
  occupying(name) {
    const cs = RAIL.s(name);
    return this.trains.some((tr) => {
      const back = tr.s - tr.dir * TRAIN_LEN;
      return Math.min(tr.s, back) - 60 < cs && Math.max(tr.s, back) + 60 > cs;
    });
  }

  drainEvents() { const e = this.events; this.events = []; return e; }
}
