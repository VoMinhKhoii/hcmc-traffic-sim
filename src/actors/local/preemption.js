// @ts-check
// actors/local/preemption.js — overlays that OUTRANK the running plan.
// Priority order (fixed, stated in the report): TRAIN > EV > normal plan.
//
// Rail preemption at every intersection named by CROSSINGS:
//   FLUSH — green for the pocket phase so vehicles trapped between stop line
//           and tracks clear through the intersection. Physics already blocks
//           entry TOWARD the closed gates, so this green cannot feed the tracks.
//   HOLD  — green for the cross street while the train passes; all movements
//           toward the tracks stay red.
//   ends on GATES_UP → recovery boost repays the held queues.
//
// EV preemption: PREEMPT{approach, eta} from central. The local schedules its
// own safe transition so the EV's approach is green by eta − evHoldLead, holds
// until RESUME.

import { CONFIG } from '../../config.js';
import { PHASES, CROSSINGS } from '../../network.js';

export class PreemptionOverlay {
  constructor(node) {
    this.node = node;
    this.rail = null;   // {crossing, stage:'FLUSH'|'HOLD', t0}
    this.ev = null;     // {approach, eta, active:bool}
    this.recoveryUntil = 0;   // boost first greens after an overlay ends
    // which of this node's phases feeds/drains the crossing (null if none)
    const entry = Object.entries(CROSSINGS).find(([, c]) => c.intersection === node);
    this.railCrossing = entry?.[0] ?? null;
    const c = entry?.[1];
    this.pocketPhase = c ? (PHASES.A.includes(c.pocketApproach) ? 'A' : 'B') : null;
  }

  onTrainApproaching(crossing, t, meta = {}) {
    if (crossing === this.railCrossing) this.rail = {
      crossing, stage: 'FLUSH', t0: t, meta,
    };
  }
  onGatesUp(t, meta = {}) {
    if (this.rail) { this.rail = null; this.recoveryUntil = t + 30; }
  }
  onPreempt(approach, eta, meta = {}, commandedAt = 0) {
    this.ev = { approach, eta, active: false, meta, commandedAt };
  }
  onResume(t, meta = {}) { if (this.ev) { this.ev = null; this.recoveryUntil = t + 30; } }

  /**
   * Apply the overlay. Returns true if it controlled the machine this tick
   * (plan logic must then be skipped).
   */
  step(machine, sensors, t) {
    if (this.rail) {
      const holdPhase = this.pocketPhase === 'A' ? 'B' : 'A';
      if (this.rail.stage === 'FLUSH') {
        machine.requestPhase(this.pocketPhase);
        const pocketDirs = PHASES[this.pocketPhase];
        const pocketEmpty = pocketDirs.every((d) => sensors[d].q < 0.5);
        if (t - this.rail.t0 >= CONFIG.pocketFlush || pocketEmpty) this.rail.stage = 'HOLD';
      } else {
        machine.requestPhase(holdPhase);   // cross street keeps moving; toward-track red
      }
      return true;
    }
    if (this.ev) {
      // watchdog: if RESUME never arrives (central died mid-run, message
      // dropped), release on our own well after the ETA — a local controller
      // must never stay preempted forever on a lost message
      if (t > this.ev.eta + 90) { this.onResume(t); return false; }
      const clearance = CONFIG.yellow + CONFIG.allRed;
      if (t >= this.ev.eta - CONFIG.evHoldLead - clearance) {
        this.ev.active = true;
        const ph = PHASES.A.includes(this.ev.approach) ? 'A' : 'B';
        machine.requestPhase(ph);
        return true;
      }
    }
    return false;
  }

  recoveryBoost(t) { return t < this.recoveryUntil ? CONFIG.recoveryBoost : 1; }
  active() { return this.rail ? 'TRAIN' : this.ev?.active ? 'EV' : null; }
}
