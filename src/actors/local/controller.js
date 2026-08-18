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
    this.planCommand = { from: 'LOCAL', t: 0, meta: {
      cause: { summary: 'safe startup default' },
      effect: { summary: 'run actuated control until central commands a plan' },
    } };
    this.mem = {};                                   // plan scratch (flash cycle etc.)
    this.congestion = {};                            // dir -> {since, alarmed}
    for (const d of DIRS) this.congestion[d] = {
      since: null, alarmed: false, alarmedAt: null, correlationId: null,
    };
  }

  /** @param {number} t @param {number} dt @param {object} sensors sensor view from physics */
  tick(t, dt, sensors) {
    // 1) inbox
    for (const m of this.bus.drain(this.node)) {
      switch (m.type) {
        case MSG.SET_PLAN:
          this.plan = { type: m.data.plan, params: m.data.params ?? {} };
          this.planCommand = { from: m.from, t: m.t, meta: m.meta };
          break;
        case MSG.TRAIN_APPROACHING: this.overlay.onTrainApproaching(m.data.crossing, t, m.meta); break;
        case MSG.GATES_UP: this.overlay.onGatesUp(t, m.meta); break;
        case MSG.PREEMPT: this.overlay.onPreempt(m.data.approach, m.data.eta, m.meta, m.t); break;
        case MSG.RESUME: this.overlay.onResume(t, m.meta); break;
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
    }

    // 4) advance the state machine
    this.machine.tick(dt);

    // 5) WALK is latched at GREEN ONSET only (a mid-green press waits for the
    // next cycle — there may not be enough green left to cross), and buttons
    // are cleared ONLY when their WALK is actually displayed.
    const m = this.machine;
    let served = [];
    if (m.state === 'GREEN' && m.stateT <= dt + 1e-9) {
      const btn = PHASES[m.phase].some((d) => sensors[d].pedButton);
      m.walk = this.plan.type === 'FIXED' || btn;
      if (m.walk) served = PHASES[m.phase];
    } else if (m.state !== 'GREEN' || m.stateT > CONFIG.walkMin) {
      m.walk = false;
    }
    return this.report(t, sensors, served);
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
          c.alarmedAt = t;
          c.correlationId = this.bus.correlation('CONG');
          const held = t - c.since;
          this.bus.send(this.node, 'CENTRAL', MSG.CONGESTION_ALARM,
            { approach: d, q: rounded(q), active: true }, t, {
              correlationId: c.correlationId,
              root: true,
              cause: numericCause('queue', q, 'veh', '≥', CONFIG.congestionThreshold, held,
                `${d} queue stayed above the congestion threshold`),
              effect: { summary: 'ask central to increase discharge and meter any upstream feeder' },
            });
        }
      } else if (q <= CONFIG.congestionClear) {
        const held = c.since === null ? 0 : t - c.since;
        c.since = null;
        if (c.alarmed) {
          c.alarmed = false;
          this.bus.send(this.node, 'CENTRAL', MSG.CONGESTION_ALARM,
            { approach: d, q: rounded(q), active: false }, t, {
              correlationId: c.correlationId,
              root: true,
              cause: numericCause('queue', q, 'veh', '≤', CONFIG.congestionClear, held,
                `${d} queue crossed the clear threshold`),
              effect: { summary: 'ask central to restore the normal coordinated split' },
              role: 'clear',
            });
          c.alarmedAt = null;
          c.correlationId = null;
        }
      }
    }
    // status on every light-state change
    if (this.machine.changed) {
      this.machine.changed = false;
      this.bus.send(this.node, 'CENTRAL', MSG.STATUS_UPDATE, {
        state: this.machine.state, phase: this.machine.phase,
        plan: this.plan.type, preempt: this.overlay.active(),
      }, t, {
        cause: { summary: `local signal changed to ${this.machine.state}${this.machine.state === 'GREEN' ? ` ${this.machine.phase}` : ''}` },
        effect: { summary: 'update the central status board' },
      });
    }
    return servedDirs;
  }

  lights() { return this.machine.view(); }
}

function rounded(n) { return Math.round(n * 10) / 10; }

function numericCause(label, value, unit, operator, threshold, held, summary) {
  return {
    summary,
    measurement: { label, value: rounded(value), unit },
    threshold: { operator, value: threshold, unit },
    held,
  };
}
