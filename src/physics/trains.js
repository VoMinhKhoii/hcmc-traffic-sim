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

export const TRAIN_LEN = 120; // m
export const TRAIN_SAFE_GAP = 100; // m beyond the leading train's rear
const TRAIN_ACCEL = 0.5;           // m/s² after a restriction clears
const SEPARATION_BRAKE = 1.0;      // m/s² maximum following-train brake

export class TrainSystem {
  constructor() {
    this.trains = [];        // {id, s, dir(+1 A→B / -1), velocity, warned, cleared}
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

  setCrossingBroken(name, broken) {
    this.redCrossings[name] = broken;
    if (broken) {
      for (const tr of this.trains) {
        const next = this.nextCrossing(tr);
        if (next?.name === name) this.ensureBrake(tr, next);
      }
    } else {
      for (const tr of this.trains)
        if (tr.brake?.crossing === name) tr.brake = null;
    }
  }

  forceTrain(dir = 1) { this.spawn(dir); }

  spawn(dir) {
    const sameDirection = this.trains.filter((tr) => tr.dir === dir);
    const rear = sameDirection.length
      ? sameDirection.reduce((a, b) => dir * a.s < dir * b.s ? a : b)
      : null;
    const entry = dir === 1 ? 0 : RAIL.total;
    const s = rear
      ? (dir === 1
        ? Math.min(entry, rear.s - TRAIN_LEN - TRAIN_SAFE_GAP)
        : Math.max(entry, rear.s + TRAIN_LEN + TRAIN_SAFE_GAP))
      : entry;
    // Enter at a speed the following model could itself have reached here, not
    // at line speed. Spawning at line speed one safe-gap behind a stopped queue
    // forces a 16.7 -> 0 m/s step on the very first tick.
    const freeGap = rear
      ? Math.max(0, dir * (rear.s - s) - TRAIN_LEN - TRAIN_SAFE_GAP)
      : Infinity;
    const velocity = rear
      ? Math.min(speedMs(CONFIG.trainSpeedKmh),
        Math.sqrt(rear.velocity ** 2 + 2 * SEPARATION_BRAKE * freeGap))
      : speedMs(CONFIG.trainSpeedKmh);
    this.trains.push({
      id: this.nextId++, dir,
      s,
      velocity,
      brake: null,
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

    // Move each direction front-to-back so a follower can brake for the
    // already-updated position of the train ahead. Front-to-front separation
    // is train length + 100 m, so rendered train bodies never overlap.
    for (const dir of [1, -1]) {
      const line = this.trains.filter((tr) => tr.dir === dir)
        .sort((a, b) => dir * b.s - dir * a.s);
      let ahead = null;
      for (const tr of line) {
        const v0 = tr.velocity;
        const next = this.nextCrossing(tr);
        if (next && this.redCrossings[next.name]) this.ensureBrake(tr, next);
        else if (tr.brake && !this.redCrossings[tr.brake.crossing]) tr.brake = null;

        let v1;
        if (tr.brake && this.redCrossings[tr.brake.crossing])
          v1 = Math.max(0, v0 - tr.brake.decel * dt);
        else
          v1 = Math.min(speedMs(CONFIG.trainSpeedKmh), v0 + TRAIN_ACCEL * dt);

        if (ahead) {
          const gap = dir * (ahead.s - tr.s);
          const freeGap = Math.max(0, gap - TRAIN_LEN - TRAIN_SAFE_GAP);
          const safeV = Math.sqrt(ahead.velocity ** 2 + 2 * SEPARATION_BRAKE * freeGap);
          if (v1 > safeV) v1 = Math.max(safeV, v0 - SEPARATION_BRAKE * dt);
        }

        let nextS = tr.s + dir * (v0 + v1) * 0.5 * dt;
        if (tr.brake && this.redCrossings[tr.brake.crossing]) {
          const stopQ = dir * tr.brake.stopAt;
          if (dir * nextS >= stopQ || (v1 === 0 && stopQ - dir * nextS < 0.05)) {
            nextS = tr.brake.stopAt;
            v1 = 0;
          }
        }
        if (ahead) {
          const maxQ = dir * ahead.s - TRAIN_LEN - TRAIN_SAFE_GAP;
          if (dir * nextS > maxQ) {
            nextS = dir * maxQ;
            v1 = Math.min(v1, ahead.velocity);
          }
        }
        tr.s = nextS;
        tr.velocity = v1;
        ahead = tr;

        for (const name of Object.keys(CROSSINGS)) {
          const cs = RAIL.s(name);
          const dist = tr.dir === 1 ? cs - tr.s : tr.s - cs;
          const eta = tr.velocity > 0 ? dist / tr.velocity : Infinity;
          if (!tr.warned[name] && dist > 0 && eta <= CONFIG.trainWarning) {
            tr.warned[name] = true;
            this.events.push({ type: 'APPROACH', crossing: name, train: tr.id, eta });
          }
          const back = tr.s - tr.dir * TRAIN_LEN;
          const passed = tr.dir === 1 ? back > cs + 80 : back < cs - 80;
          if (tr.warned[name] && !tr.cleared[name] && passed) {
            tr.cleared[name] = true;
            this.events.push({ type: 'CLEAR', crossing: name, train: tr.id });
          }
        }
      }
    }
    // Entry-side coordinates may be outside the clipped map when a long fault
    // queues back beyond the modeled corridor. Remove only after the train has
    // exited at the far end of its direction of travel.
    this.trains = this.trains.filter((tr) => tr.dir === 1
      ? tr.s < RAIL.total + TRAIN_LEN + 10
      : tr.s > -TRAIN_LEN - 10);
  }

  nextCrossing(tr) {
    const ahead = Object.keys(CROSSINGS)
      .map((name) => ({ name, s: RAIL.s(name) }))
      .filter((c) => (tr.dir === 1 ? c.s > tr.s : c.s < tr.s));
    if (!ahead.length) return null;
    return ahead.reduce((m, c) => (tr.dir === 1 ? (c.s < m.s ? c : m) : (c.s > m.s ? c : m)));
  }

  ensureBrake(tr, crossing) {
    if (tr.brake?.crossing === crossing.name) return;
    const signalAt = crossing.s - tr.dir * 80;
    const distance = tr.dir * (signalAt - tr.s);
    // Zone 3 is excluded by the proved-down fault timing. If a red is somehow
    // asserted with the train already past the protecting signal, brake as hard
    // as the model allows from where it actually is — never place the stopping
    // point behind the train, which would teleport it backwards.
    const stopAt = distance > 0 ? signalAt : tr.s;
    const decel = distance > 0
      ? tr.velocity ** 2 / (2 * distance)
      : SEPARATION_BRAKE;
    tr.brake = { crossing: crossing.name, stopAt, decel };
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
