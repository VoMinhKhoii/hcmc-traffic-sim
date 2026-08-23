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
//   A BROKEN crossing sends eta = 0, which enters HOLD directly and stays there
//   until the crossing is repaired — there is no flush for a crossing we cannot
//   prove is protected.
//
// EV preemption: PREEMPT{approach, eta} from central. The local schedules its
// own safe transition so the EV's approach is green by eta − evHoldLead, holds
// until RESUME.

import { CONFIG } from '../../config.js';
import { PHASES, CROSSINGS, APPROACHES, OPPOSITE } from '../../network.js';

export class PreemptionOverlay {
  constructor(node) {
    this.node = node;
    this.rail = null;   // {crossing, stage:'FLUSH'|'HOLD', t0}
    this.ev = null;     // {approach, eta, active:bool}
    this.recoveryUntil = 0;   // boost first greens after an overlay ends
    // A BROKEN crossing holds the movement feeding its link at BOTH ends.
    // Map crossing -> phase which discharges into that link from this node.
    this.railPhases = {};
    for (const [name, c] of Object.entries(CROSSINGS)) {
      const linkApproach = Object.entries(APPROACHES[node])
        .find(([, ap]) => ap.link === c.link)?.[0];
      if (!linkApproach) continue;
      const feedingApproach = OPPOSITE[linkApproach];
      this.railPhases[name] = PHASES.A.includes(feedingApproach) ? 'A' : 'B';
    }
  }

  onTrainApproaching(crossing, eta, t, meta = {}) {
    if (this.railPhases[crossing]) this.rail = {
      crossing, stage: eta <= 0 ? 'HOLD' : 'FLUSH', t0: t, meta,
    };
  }
  onGatesUp(t, meta = {}, crossing = null) {
    // Only the crossing that raised this hold may release it. Today the endpoint
    // pairs are disjoint so any message would be the right one, but that is a
    // property of the current map, not of the design.
    if (!this.rail) return;
    if (crossing && this.rail.crossing !== crossing) return;
    this.rail = null; this.recoveryUntil = t + 30;
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
      const feedingPhase = this.railPhases[this.rail.crossing];
      const holdPhase = feedingPhase === 'A' ? 'B' : 'A';
      if (this.rail.stage === 'FLUSH') {
        machine.requestPhase(feedingPhase);
        const pocketDirs = PHASES[feedingPhase];
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
