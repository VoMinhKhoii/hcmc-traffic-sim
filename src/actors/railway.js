// @ts-check
// RailwayController: three control states only (OPEN / CLOSED / BROKEN).
// Barrier travel is renderer-only. The controller commands CLOSED immediately,
// blocks the road, and waits independently for physical proved-down feedback.

import { CONFIG } from '../config.js';
import { CROSSINGS, linkById } from '../network.js';
import { MSG } from '../messages.js';

export class RailwayController {
  constructor(bus, model, trains) {
    this.bus = bus; this.model = model; this.trains = trains;
    this.repairSeed = 0x6d2b79f5; // fixed per simulation: repeatable demo and tests
    // The controller waits gateProveTimeout for the hardware to answer. If that
    // window were shorter than the hardware's own travel time, every crossing
    // would fault on every train — a config error, not a railway failure.
    if (CONFIG.gateProveTimeout <= CONFIG.barrierTravel)
      throw new Error(`gateProveTimeout (${CONFIG.gateProveTimeout}s) must exceed `
        + `barrierTravel (${CONFIG.barrierTravel}s), or no barrier can ever prove closed`);
    bus.register('RAILWAY');
    this.crossings = {};
    for (const name of Object.keys(CROSSINGS)) {
      this.crossings[name] = {
        state: 'OPEN',             // OPEN | CLOSED | BROKEN
        flashers: false,
        pendingTrains: 0,
        armFailed: false,          // injected physical failure; not yet a declared fault
        armFailedAt: null,         // when the injection happened (UI only)
        fault: false,              // compatibility/UI flag: true exactly in BROKEN
        provedDown: false,
        proveAt: null,
        proveDeadline: null,
        repairAt: null,
        renderAction: 'UP',        // renderer-only animation input
        // start the raise animation already finished, or every gate renders
        // fully down at t=0 and lifts over the first barrierTravel seconds
        renderActionAt: -CONFIG.barrierTravel,
        correlationId: null,
      };
    }
  }

  // Inject a physical failure. It becomes a system fault only after a later
  // down command fails to produce proof before gateProveTimeout.
  jamGate(name, t) {
    const c = this.crossings[name];
    if (c.armFailed) return;
    c.armFailed = true;
    c.armFailedAt = t;
  }

  // Manual operator repair; automatic repair calls the same transition.
  clearFault(name, t) {
    const c = this.crossings[name];
    if (!c.armFailed && c.state !== 'BROKEN') return;
    c.armFailed = false;
    c.armFailedAt = null;
    if (c.state !== 'BROKEN') return; // injection repaired before it was demanded

    c.fault = false;
    c.repairAt = null;
    this.trains.setCrossingBroken(name, false);
    const primary = CROSSINGS[name].intersection;
    if (c.pendingTrains > 0) {
      // Human repair returns an occupied session to its safe CLOSED output.
      c.state = 'CLOSED';
      c.provedDown = true;
      c.proveAt = null; c.proveDeadline = null;
      c.renderAction = 'DOWN'; c.renderActionAt = t;
      for (const node of this.crossingEnds(name))
        if (node !== primary) this.sendGatesUp(name, node, t, false);
    } else {
      this.transitionOpen(name, t, true);
    }
  }

  tick(t, dt, trainEvents) {
    for (const ev of trainEvents) {
      const c = this.crossings[ev.crossing];
      if (ev.type === 'APPROACH') {
        c.correlationId ??= this.bus.correlation('RAIL');
        c.pendingTrains++;
        c.flashers = true;
        if (c.state === 'OPEN') this.commandClosed(ev.crossing, t);
        // A BROKEN crossing must stay in HOLD until repair. An eta > 0 would put
        // the protected intersection back into FLUSH, greening the phase that
        // feeds a crossing we cannot prove is protected.
        this.sendRailHold(ev.crossing, CROSSINGS[ev.crossing].intersection,
          c.state === 'BROKEN' ? 0 : ev.eta, t, c.pendingTrains === 1);
      } else if (ev.type === 'CLEAR') {
        c.pendingTrains = Math.max(0, c.pendingTrains - 1);
        if (c.pendingTrains === 0 && c.state === 'CLOSED') this.transitionOpen(ev.crossing, t);
      }
    }

    for (const [name, c] of Object.entries(this.crossings)) {
      if (c.state === 'CLOSED' && !c.provedDown) {
        if (!c.armFailed && c.proveAt !== null && t >= c.proveAt) {
          c.provedDown = true;
          c.proveAt = null; c.proveDeadline = null;
        } else if (c.proveDeadline !== null && t + 1e-9 >= c.proveDeadline) {
          // Timestamp the threshold itself, not a floating-point tick just
          // beyond it, so the declared time is exactly auditable.
          this.declareBroken(name, c.proveDeadline);
        }
      }
      if (c.state === 'BROKEN' && c.repairAt !== null && t >= c.repairAt)
        this.clearFault(name, t);
    }
  }

  commandClosed(name, t) {
    const c = this.crossings[name];
    c.state = 'CLOSED';
    c.provedDown = false;
    c.proveAt = t + CONFIG.barrierTravel;
    c.proveDeadline = t + CONFIG.gateProveTimeout;
    c.renderAction = 'DOWN'; c.renderActionAt = t;
    this.model.setGate(name, true, t); // block both directions on transition
  }

  declareBroken(name, t) {
    const c = this.crossings[name];
    if (c.state === 'BROKEN') return;
    c.state = 'BROKEN'; c.fault = true;
    c.proveAt = null; c.proveDeadline = null;
    c.repairAt = t + this.repairDelay();
    c.correlationId ??= this.bus.correlation('RAIL');
    this.trains.setCrossingBroken(name, true);
    const cause = {
      summary: `crossing ${name} failed to prove closed after a down command`,
      measurement: { label: 'proof wait', value: CONFIG.gateProveTimeout, unit: 's' },
      threshold: { operator: '≥', value: CONFIG.gateProveTimeout, unit: 's' },
      held: CONFIG.gateProveTimeout,
    };
    this.bus.send('RAILWAY', 'CENTRAL', MSG.GATE_FAULT, { crossing: name }, t, {
      correlationId: c.correlationId, root: true, cause,
      effect: { summary: `set crossing ${name} train signal RED and keep the road link closed` },
    });
    this.bus.send('RAILWAY', 'CENTRAL', MSG.ALARM,
      { kind: 'GATE_NOT_PROVED', detail: `crossing ${name}: arm failed; trains held at red` }, t, {
        correlationId: c.correlationId, parentType: MSG.GATE_FAULT, cause,
        effect: { summary: 'raise an operator-visible alarm in central' },
      });
    // Immediate HOLD at both link ends: only each feeding phase is suppressed.
    for (const node of this.crossingEnds(name)) this.sendRailHold(name, node, 0, t, false);
  }

  transitionOpen(name, t, allEnds = false) {
    const c = this.crossings[name];
    c.state = 'OPEN'; c.provedDown = false;
    c.proveAt = null; c.proveDeadline = null;
    c.flashers = false;
    c.renderAction = 'UP'; c.renderActionAt = t;
    this.model.setGate(name, false, t);
    const nodes = allEnds ? this.crossingEnds(name) : [CROSSINGS[name].intersection];
    for (const node of nodes) this.sendGatesUp(name, node, t, true);
    c.correlationId = null;
  }

  sendRailHold(name, node, eta, t, root) {
    const c = this.crossings[name];
    this.bus.send('RAILWAY', node, MSG.TRAIN_APPROACHING,
      { crossing: name, eta }, t, {
        correlationId: c.correlationId, root,
        parentType: eta <= 0 ? MSG.GATE_FAULT : undefined,
        cause: {
          summary: eta <= 0
            ? `faulted crossing ${name} requires an indefinite feeding-movement hold`
            : `train entered the warning window for crossing ${name}`,
          measurement: { label: 'eta', value: rounded(eta), unit: 's' },
          threshold: { operator: '≤', value: CONFIG.trainWarning, unit: 's' },
          held: 0,
        },
        effect: { summary: eta <= 0
          ? 'hold only the movement feeding the crossing link red'
          : 'enter rail FLUSH, then HOLD the movement toward the tracks red' },
      });
  }

  sendGatesUp(name, node, t, normalClear) {
    const c = this.crossings[name];
    this.bus.send('RAILWAY', node, MSG.GATES_UP, { crossing: name }, t, {
      correlationId: c.correlationId,
      parentType: normalClear ? MSG.TRAIN_APPROACHING : MSG.GATE_FAULT,
      cause: { summary: normalClear
        ? `crossing ${name} control transitioned OPEN after the train cleared`
        : `crossing ${name} was repaired` },
      effect: { summary: 'release the rail hold and recover into the commanded plan' },
    });
  }

  crossingEnds(name) {
    const link = linkById(CROSSINGS[name].link);
    return [link.a, link.b];
  }

  repairDelay() {
    const lo = Math.min(CONFIG.gateRepairMin, CONFIG.gateRepairMax);
    const hi = Math.max(CONFIG.gateRepairMin, CONFIG.gateRepairMax);
    if (hi === lo) return lo;
    // Mulberry32: deterministic, local, and never coupled to Math.random().
    let x = this.repairSeed += 0x6d2b79f5;
    x = Math.imul(x ^ x >>> 15, x | 1);
    x ^= x + Math.imul(x ^ x >>> 7, x | 61);
    const u = ((x ^ x >>> 14) >>> 0) / 4294967296;
    return lo + (hi - lo) * u;
  }

  gatesDown() {
    return Object.fromEntries(Object.entries(this.crossings)
      .map(([name, c]) => [name, c.state !== 'OPEN']));
  }
}

function rounded(n) { return Number.isFinite(n) ? Math.round(n * 10) / 10 : n; }
