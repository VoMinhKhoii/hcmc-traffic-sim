// physics/trains.js — train schedule + movement along the double-track corridor.
// Emits approach/clear events per crossing; the RailwayController turns those
// into gates, flashers and messages. Trains obey the train signal (red = stop).

import { CONFIG, speedMs } from '../config.js';
import { INTERSECTIONS, CROSSINGS, linkById } from '../network.js';

// Rail geometry: the line through crossing A (on I5–I6) and crossing B (on I1–I2),
// extended 600 m beyond each. Distance A→B along the rail ≈ per drawn map ~700 m.
function crossingXY(name) {
  const c = CROSSINGS[name];
  const l = linkById(c.link);
  const A = INTERSECTIONS[l.a], B = INTERSECTIONS[l.b];
  return { x: A.x + (B.x - A.x) * c.pos, y: A.y + (B.y - A.y) * c.pos };
}
export const RAIL = (() => {
  const a = crossingXY('A'), b = crossingXY('B');
  const dx = b.x - a.x, dy = b.y - a.y;
  const drawLen = Math.hypot(dx, dy);
  const AB = 700;                       // meters between crossings along the rail
  const scale = AB / drawLen;           // meters per canvas unit
  const ux = dx / drawLen, uy = dy / drawLen;
  const margin = 600;                   // rail modeled 600 m past each crossing
  return {
    a, b, ux, uy, scale,
    sA: margin, sB: margin + AB, total: AB + 2 * margin,
    xy(s) { const d = (s - margin) / scale; return { x: a.x + ux * d, y: a.y + uy * d }; },
  };
})();

const TRAIN_LEN = 120; // m

export class TrainSystem {
  constructor() {
    this.trains = [];        // {id, s, dir(+1 A→B / -1), speed, warned:{A,B}, cleared:{A,B}}
    this.nextSpawn = 60;     // first train 1 sim-minute in
    this.nextId = 1;
    this.signalRed = false;  // set by RailwayController on gate fault
    this.events = [];        // {type:'APPROACH'|'CLEAR', crossing, eta}
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
    // every night at 20-min headway; brief's Fri/Sat-only detail is a display note)
    if (t >= this.nextSpawn) {
      this.spawn(this.nextId % 2 === 0 ? 1 : -1);
      this.nextSpawn = t + CONFIG.headway[mode];
    }

    for (const tr of this.trains) {
      // a red train signal stops the train 80 m before its NEXT crossing
      let v = tr.speed;
      if (this.signalRed) {
        const nextS = this.nextCrossingS(tr);
        if (nextS !== null) {
          const stopAt = nextS - tr.dir * 80;
          if (tr.dir === 1 && tr.s + v * dt > stopAt && tr.s <= stopAt) v = Math.max(0, (stopAt - tr.s) / dt);
          if (tr.dir === -1 && tr.s - v * dt < stopAt && tr.s >= stopAt) v = Math.max(0, (tr.s - stopAt) / dt);
          if ((tr.dir === 1 && Math.abs(tr.s - stopAt) < 1) || (tr.dir === -1 && Math.abs(tr.s - stopAt) < 1)) v = 0;
        }
      }
      tr.s += tr.dir * v * dt;

      for (const name of ['A', 'B']) {
        const cs = name === 'A' ? RAIL.sA : RAIL.sB;
        const dist = tr.dir === 1 ? cs - tr.s : tr.s - cs;
        const eta = v > 0 ? dist / v : Infinity;
        if (!tr.warned[name] && dist > 0 && eta <= CONFIG.trainWarning) {
          tr.warned[name] = true;
          this.events.push({ type: 'APPROACH', crossing: name, train: tr.id, eta });
        }
        const back = tr.s - tr.dir * TRAIN_LEN;
        const passed = tr.dir === 1 ? Math.min(tr.s, back) > cs : Math.max(tr.s, back) < cs;
        if (tr.warned[name] && !tr.cleared[name] && passed) {
          tr.cleared[name] = true;
          this.events.push({ type: 'CLEAR', crossing: name, train: tr.id });
        }
      }
    }
    this.trains = this.trains.filter((tr) => tr.s > -TRAIN_LEN - 10 && tr.s < RAIL.total + TRAIN_LEN + 10);
  }

  nextCrossingS(tr) {
    const ahead = ['A', 'B']
      .map((n) => (n === 'A' ? RAIL.sA : RAIL.sB))
      .filter((cs) => (tr.dir === 1 ? cs > tr.s : cs < tr.s));
    if (!ahead.length) return null;
    return tr.dir === 1 ? Math.min(...ahead) : Math.max(...ahead);
  }

  // is any train occupying crossing zone (±60 m)?
  occupying(name) {
    const cs = name === 'A' ? RAIL.sA : RAIL.sB;
    return this.trains.some((tr) => {
      const back = tr.s - tr.dir * TRAIN_LEN;
      return Math.min(tr.s, back) - 60 < cs && Math.max(tr.s, back) + 60 > cs;
    });
  }

  drainEvents() { const e = this.events; this.events = []; return e; }
}
