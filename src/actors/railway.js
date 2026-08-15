// @ts-check
// actors/railway.js — the RailwayController.
// Owns gates, flashers and the train signal at crossings A (I5) and B (I2).
// Turns raw train events into the protocol messages TRAIN_APPROACHING /
// GATES_UP / GATE_FAULT. Traffic lights sense the crossing but never control
// it (per the brief); a jammed gate turns the train signal RED and raises an
// alarm in the control room.

import { CONFIG } from '../config.js';
import { CROSSINGS } from '../network.js';
import { MSG } from '../messages.js';

export class RailwayController {
  constructor(bus, model, trains) {
    this.bus = bus; this.model = model; this.trains = trains;
    bus.register('RAILWAY');
    this.crossings = {};
    for (const name of Object.keys(CROSSINGS)) {
      this.crossings[name] = {
        state: 'OPEN',          // OPEN | LOWERING | CLOSED | RAISING
        stateT: 0,
        flashers: false,
        pendingTrains: 0,       // approach/clear bookkeeping (2-min headways overlap)
        fault: false,
      };
    }
  }

  jamGate(name, t) {
    const c = this.crossings[name];
    c.fault = true;
    this.trains.signalRed = true;                       // train gets a red light
    this.bus.send('RAILWAY', 'CENTRAL', MSG.GATE_FAULT, { crossing: name }, t);
    this.bus.send('RAILWAY', 'CENTRAL', MSG.ALARM, { kind: 'GATE_JAMMED', detail: `crossing ${name}: trains held at red` }, t);
    // the protected intersection holds toward-track movements red, exactly as
    // it does for a passing train:
    this.bus.send('RAILWAY', CROSSINGS[name].intersection, MSG.TRAIN_APPROACHING, { crossing: name, eta: 0 }, t);
  }
  clearFault(name, t) {
    const c = this.crossings[name];
    c.fault = false;
    if (!Object.values(this.crossings).some((x) => x.fault)) this.trains.signalRed = false;
    if (c.pendingTrains === 0) this.openGates(name, t);
  }

  tick(t, dt, trainEvents) {
    for (const ev of trainEvents) {
      const c = this.crossings[ev.crossing];
      if (ev.type === 'APPROACH') {
        c.pendingTrains++;
        c.flashers = true;
        if (c.state === 'OPEN' || c.state === 'RAISING') { c.state = 'LOWERING'; c.stateT = 0; }
        this.bus.send('RAILWAY', CROSSINGS[ev.crossing].intersection, MSG.TRAIN_APPROACHING,
          { crossing: ev.crossing, eta: ev.eta }, t);
      } else if (ev.type === 'CLEAR') {
        c.pendingTrains = Math.max(0, c.pendingTrains - 1);
        if (c.pendingTrains === 0 && !c.fault) this.openGates(ev.crossing, t);
      }
    }
    for (const [name, c] of Object.entries(this.crossings)) {
      c.stateT += dt;
      if (c.state === 'LOWERING' && c.stateT >= CONFIG.gateTime) {
        c.state = 'CLOSED'; this.model.setGate(name, true);
      } else if (c.state === 'RAISING' && c.stateT >= CONFIG.gateTime) {
        c.state = 'OPEN'; c.flashers = false;
        this.bus.send('RAILWAY', CROSSINGS[name].intersection, MSG.GATES_UP, { crossing: name }, t);
      }
    }
  }

  openGates(name, t) {
    const c = this.crossings[name];
    if (c.state === 'CLOSED' || c.state === 'LOWERING') {
      c.state = 'RAISING'; c.stateT = 0;
      this.model.setGate(name, false);
    }
  }

  gatesDown() {
    const g = {};
    for (const [n, c] of Object.entries(this.crossings))
      g[n] = c.state === 'CLOSED' || c.state === 'LOWERING' || c.fault;
    return g;
  }
}
