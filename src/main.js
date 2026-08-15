// @ts-check
// main.js — wiring. Builds the world, runs the tick loop:
//   physics → sensor events → actors → light states → (render).
// Headless-friendly: no DOM here; ui/ imports this and drives it.

import { CONFIG } from './config.js';
import { INTERSECTIONS } from './network.js';
import { SimClock } from './clock.js';
import { TrafficModel } from './physics/queues.js';
import { TrainSystem } from './physics/trains.js';
import { IncidentSystem } from './physics/incidents.js';
import { MessageBus } from './messages.js';
import { LocalController } from './actors/local/controller.js';
import { CentralController } from './actors/central.js';
import { RailwayController } from './actors/railway.js';

export class Simulation {
  constructor() {
    this.clock = new SimClock();
    this.bus = new MessageBus();
    this.model = new TrafficModel();
    this.trains = new TrainSystem();
    this.incidents = new IncidentSystem(this.model);
    this.central = new CentralController(this.bus);
    this.railway = new RailwayController(this.bus, this.model, this.trains);
    this.locals = {};
    for (const node of Object.keys(INTERSECTIONS)) this.locals[node] = new LocalController(node, this.bus);
    this.centralAlive = true;
    this.conflictViolations = 0;   // safety invariant counter (checked every tick)
  }

  get t() { return this.clock.t; }

  step() {
    const dt = CONFIG.dt, t = this.clock.t, mode = this.clock.mode;

    // physics
    this.trains.step(dt, t, mode);
    this.railway.tick(t, dt, this.trains.drainEvents());
    const gatesDown = this.railway.gatesDown();
    this.incidents.step(dt, t, gatesDown);
    const lights = {};
    for (const [n, lc] of Object.entries(this.locals)) lights[n] = lc.lights();
    const trainAt = { A: this.trains.occupying('A'), B: this.trains.occupying('B') };
    this.model.step(dt, t, mode, lights, gatesDown, trainAt);

    // EV progress events → central issues RESUME per intersection
    for (const ev of this.incidents.drainEvents()) {
      if (!this.centralAlive) continue;
      if (ev.type === 'EV_PASSED') this.central.onEvPassed(ev.node, t);
      else if (ev.type === 'EV_DONE') this.central.onEvDone(t);
    }

    // actors
    if (this.centralAlive) this.central.tick(t, mode);
    for (const [node, lc] of Object.entries(this.locals)) {
      const served = lc.tick(t, dt, this.model.sensors(node, t));
      if (served?.length) this.model.clearPed(node, served);
    }

    // safety invariant: at most one phase green per intersection — enforced by
    // the SignalMachine, verified here every tick anyway
    for (const lc of Object.values(this.locals)) {
      const v = lc.machine;
      if (v.state === 'GREEN' && !['A', 'B'].includes(v.phase)) this.conflictViolations++;
    }

    this.clock.advance(dt);
  }

  /** run n sim-seconds headless */
  run(seconds) { const steps = Math.round(seconds / CONFIG.dt); for (let i = 0; i < steps; i++) this.step(); }

  // ---- operator console (the scenario buttons) --------------------------
  dispatchEV(route = ['I1', 'I2', 'I4']) {
    // dispatch is a CENTRAL operator action: refuse while central is offline
    // (an EV with no preemption would sail through reds), and one EV at a time
    if (!this.centralAlive) return null;
    if (this.incidents.ev && !this.incidents.ev.done) return null;
    const legs = this.incidents.dispatchEV(route, this.t);
    this.central.commandEVCorridor(legs, this.t);
    return legs;
  }
  dropAccident(linkId, from, lanesBlocked = 1, duration = CONFIG.accidentDuration) {
    this.incidents.dropAccident(linkId, from, lanesBlocked, duration, this.t);
  }
  killCentral() {
    this.centralAlive = false;
    for (const n of Object.keys(this.locals)) this.bus.setLink(n, false, this.t);
  }
  restoreCentral() {
    this.centralAlive = true;
    for (const n of Object.keys(this.locals)) this.bus.setLink(n, true, this.t);
    this.central.broadcastPlans(this.t);   // resync after reconnect
  }
  jamGate(name) { this.railway.jamGate(name, this.t); }
  clearGateFault(name) { this.railway.clearFault(name, this.t); }
  forceTrain(dir = 1) { this.trains.forceTrain(dir); }
  pressPed(node, dir) { this.model.pressPed(node, dir); }
}
