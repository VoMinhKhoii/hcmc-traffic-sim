// @ts-check
// actors/local/controller.js — the LocalController actor (one per I1..I6).
// It may see ONLY: (a) its own sensors, (b) its inbox. All coordination is
// typed messages. It always owns its own lights — central commands select
// patterns, they never set a light. If the central link dies, the last plan
// keeps running and status reports are buffered (bus handles the buffering).

import { CONFIG } from '../../config.js';
import { DIRS, PHASES } from '../../network.js';
import { MSG } from '../../messages.js';
import { SignalMachine } from './phases.js';
import { fixedStep, actuatedStep, flashStep } from './plans.js';
import { PreemptionOverlay } from './preemption.js';

export class LocalController {
  constructor(node, bus) {
    this.node = node;
    this.bus = bus;
    bus.register(node);
    this.machine = new SignalMachine(node);
    this.overlay = new PreemptionOverlay(node);
    this.plan = { type: 'ACTUATED', params: {} };   // safe default before first SET_PLAN
    this.mem = {};                                   // plan scratch (flash cycle etc.)
    this.congestion = {};                            // dir -> {since, alarmed}
    for (const d of DIRS) this.congestion[d] = { since: null, alarmed: false };
  }

  /** @param {number} t @param {number} dt @param {object} sensors sensor view from physics */
  tick(t, dt, sensors) {
    // 1) inbox
    for (const m of this.bus.drain(this.node)) {
      switch (m.type) {
        case MSG.SET_PLAN: this.plan = { type: m.data.plan, params: m.data.params ?? {} }; break;
        case MSG.TRAIN_APPROACHING: this.overlay.onTrainApproaching(m.data.crossing, t); break;
        case MSG.GATES_UP: this.overlay.onGatesUp(t); break;
        case MSG.PREEMPT: this.overlay.onPreempt(m.data.approach, m.data.eta); break;
        case MSG.RESUME: this.overlay.onResume(t); break;
      }
    }

    // 2) preemption overlay outranks the plan
    const preempted = this.overlay.step(this.machine, sensors, t);

    // 3) otherwise run the commanded pattern
    if (!preempted) {
      const boost = this.overlay.recoveryBoost(t);
      if (this.plan.type === 'FIXED') fixedStep(this.machine, this.plan.params, t);
      else if (this.plan.type === 'FLASH') flashStep(this.machine, sensors, this.mem);
      else actuatedStep(this.machine, sensors, boost);
    } else if (this.machine.state === 'FLASH') {
      // preemption during night flash: exit into full signal operation
      this.machine.exitFlash('A');
    }

    // 4) advance the state machine + WALK indication
    this.machine.tick(dt);
    this.machine.walk = this.machine.state === 'GREEN' &&
      this.machine.stateT <= Math.max(CONFIG.walkMin, 0) &&
      (this.plan.type === 'FIXED' || PHASES[this.machine.phase].some((d) => sensors[d].pedButton));

    // 5) served ped buttons clear when their phase goes green
    if (this.machine.state === 'GREEN') return this.report(t, sensors, PHASES[this.machine.phase]);
    this.report(t, sensors, []);
  }

  report(t, sensors, servedDirs) {
    // congestion detector (the density-threshold idea): alarm after persist,
    // clear with hysteresis
    for (const d of DIRS) {
      const c = this.congestion[d], q = sensors[d].q;
      if (q >= CONFIG.congestionThreshold) {
        c.since ??= t;
        if (!c.alarmed && t - c.since >= CONFIG.congestionPersist) {
          c.alarmed = true;
          this.bus.send(this.node, 'CENTRAL', MSG.CONGESTION_ALARM, { approach: d, q: Math.round(q), active: true }, t);
        }
      } else if (q <= CONFIG.congestionClear) {
        c.since = null;
        if (c.alarmed) {
          c.alarmed = false;
          this.bus.send(this.node, 'CENTRAL', MSG.CONGESTION_ALARM, { approach: d, q: Math.round(q), active: false }, t);
        }
      }
    }
    // status on every light-state change
    if (this.machine.changed) {
      this.machine.changed = false;
      this.bus.send(this.node, 'CENTRAL', MSG.STATUS_UPDATE, {
        state: this.machine.state, phase: this.machine.phase,
        plan: this.plan.type, preempt: this.overlay.active(),
      }, t);
    }
    return servedDirs;
  }

  lights() { return this.machine.view(); }
}
