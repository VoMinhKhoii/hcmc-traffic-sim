// @ts-check
// actors/railway.js — the RailwayController.
// Owns gates, flashers and the per-crossing train signal for every entry in
// CROSSINGS. Turns raw train events into the protocol messages
// TRAIN_APPROACHING / GATES_UP / GATE_FAULT. Traffic lights sense the crossing
// but never control it (per the brief).
//
// Safety rules encoded here (post adversarial review):
//  - the road entry is blocked from LOWERING until the gates are fully OPEN
//    again — never reopened while a train may still occupy the crossing
//  - a gate fault physically closes the crossing (cars held, that crossing's
//    train signal RED, protected intersection holds toward-track reds)
//  - clearing a fault ALWAYS releases the intersection (GATES_UP), even if
//    the gates were already open and no train ever came

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
        correlationId: null,    // one visible chain for this occupied/fault session
      };
    }
  }

  jamGate(name, t) {
    const c = this.crossings[name];
    if (c.fault) return;
    c.fault = true;
    c.correlationId ??= this.bus.correlation('RAIL');
    const faultCause = {
      summary: `crossing ${name} gate fault asserted`,
      measurement: { label: 'fault signal', value: 1, unit: '' },
      threshold: { operator: '≥', value: 1, unit: '' },
      held: 0,
    };
    this.trains.redCrossings[name] = true;              // this crossing's signal → RED
    this.bus.send('RAILWAY', 'CENTRAL', MSG.GATE_FAULT, { crossing: name }, t, {
      correlationId: c.correlationId, root: true, cause: faultCause,
      effect: { summary: `set crossing ${name} train signal RED and close the road crossing` },
    });
    this.bus.send('RAILWAY', 'CENTRAL', MSG.ALARM,
      { kind: 'GATE_JAMMED', detail: `crossing ${name}: trains held at red` }, t, {
        correlationId: c.correlationId, parentType: MSG.GATE_FAULT, cause: faultCause,
        effect: { summary: 'raise an operator-visible alarm in central' },
      });
    // the protected intersection holds toward-track movements red, and the
    // crossing physically closes to road traffic
    this.bus.send('RAILWAY', CROSSINGS[name].intersection, MSG.TRAIN_APPROACHING,
      { crossing: name, eta: 0 }, t, {
        correlationId: c.correlationId, parentType: MSG.GATE_FAULT, cause: {
          summary: `faulted crossing ${name} requires an immediate rail hold`,
          measurement: { label: 'eta', value: 0, unit: 's' },
          threshold: { operator: '≤', value: CONFIG.trainWarning, unit: 's' },
          held: 0,
        },
        effect: { summary: 'enter rail FLUSH, then HOLD movements toward the tracks red' },
      });
    if (c.state === 'OPEN' || c.state === 'RAISING') { c.state = 'LOWERING'; c.stateT = 0; c.flashers = true; }
  }

  clearFault(name, t) {
    const c = this.crossings[name];
    if (!c.fault) return;
    c.fault = false;
    this.trains.redCrossings[name] = false;
    if (c.pendingTrains === 0) {
      if (c.state === 'CLOSED' || c.state === 'LOWERING') this.openGates(name);
      else if (c.state === 'OPEN') {                     // gates never moved: still release the hold
        c.flashers = false;
        this.sendGatesUp(name, t);
      }
    }
  }

  tick(t, dt, trainEvents) {
    for (const ev of trainEvents) {
      const c = this.crossings[ev.crossing];
      if (ev.type === 'APPROACH') {
        c.correlationId ??= this.bus.correlation('RAIL');
        c.pendingTrains++;
        c.flashers = true;
        if (c.state === 'OPEN' || c.state === 'RAISING') { c.state = 'LOWERING'; c.stateT = 0; }
        this.bus.send('RAILWAY', CROSSINGS[ev.crossing].intersection, MSG.TRAIN_APPROACHING,
          { crossing: ev.crossing, eta: ev.eta }, t, {
            correlationId: c.correlationId,
            root: c.pendingTrains === 1,
            cause: {
              summary: `train ${ev.train} entered the warning window for crossing ${ev.crossing}`,
              measurement: { label: 'eta', value: rounded(ev.eta), unit: 's' },
              threshold: { operator: '≤', value: CONFIG.trainWarning, unit: 's' },
              held: 0,
            },
            effect: { summary: 'enter rail FLUSH, then HOLD movements toward the tracks red' },
          });
      } else if (ev.type === 'CLEAR') {
        c.pendingTrains = Math.max(0, c.pendingTrains - 1);
        if (c.pendingTrains === 0 && !c.fault) this.openGates(ev.crossing);
      }
    }
    for (const [name, c] of Object.entries(this.crossings)) {
      c.stateT += dt;
      if (c.state === 'LOWERING' && c.stateT >= CONFIG.gateTime) {
        c.state = 'CLOSED';
        this.model.setGate(name, true, t);
      } else if (c.state === 'RAISING' && c.stateT >= CONFIG.gateTime) {
        if (c.fault || c.pendingTrains > 0) {            // fault/train arrived mid-raise: go back down
          c.state = 'LOWERING'; c.stateT = 0;
        } else {
          c.state = 'OPEN'; c.flashers = false;
          this.model.setGate(name, false, t);            // road entry reopens only NOW
          this.sendGatesUp(name, t);
        }
      }
    }
  }

  openGates(name) {
    const c = this.crossings[name];
    if (c.state === 'CLOSED' || c.state === 'LOWERING') { c.state = 'RAISING'; c.stateT = 0; }
  }

  sendGatesUp(name, t) {
    const c = this.crossings[name];
    this.bus.send('RAILWAY', CROSSINGS[name].intersection, MSG.GATES_UP,
      { crossing: name }, t, {
        correlationId: c.correlationId,
        parentType: MSG.TRAIN_APPROACHING,
        cause: {
          summary: `crossing ${name} gates reached fully open`,
          measurement: { label: 'gate travel', value: CONFIG.gateTime, unit: 's' },
          threshold: { operator: '≥', value: CONFIG.gateTime, unit: 's' },
          held: CONFIG.gateTime,
        },
        effect: { summary: 'release the rail hold and recover into the commanded plan' },
      });
    c.correlationId = null;
  }

  gatesDown() {
    const g = {};
    for (const [n, c] of Object.entries(this.crossings))
      g[n] = c.state !== 'OPEN' || c.fault;   // anything but fully-open counts as down
    return g;
  }
}

function rounded(n) { return Math.round(n * 10) / 10; }
