// @ts-check
// actors/midBlockPed.js — Mid-block pedestrian crossing controller for I2–I4.
//
// The light sits 260 m along the I2–I4 diagonal, away from any intersection.
// It finds a safe gap in vehicle flow by coordinating with the nearest
// intersection (I2) rather than independently stopping traffic.
//
// Priority of gap sources:
//   1. Railway preemption dwell (peak + any mode): gates closed → road clear
//   2. Natural red on protecting approach (I2 phase A, S approach red)
//   3. Early gap-out via PED_REQUEST to I2 (off-peak, after gMin served)
//   4. Night: direct vehicle proximity check on the link

import { MSG } from '../messages.js';

const STATE = { IDLE: 'IDLE', WAITING: 'WAITING', WALK: 'WALK', CLEARING: 'CLEARING' };

export class MidBlockPedController {
  /**
   * @param {string} id  unique actor id (e.g. 'MBP-I2-I4-mid')
   * @param {object} spec  entry from MID_BLOCK_PEDS
   * @param {import('../messages.js').MessageBus} bus
   */
  constructor(id, spec, bus) {
    this.id = id;
    this.spec = spec;
    this.bus = bus;
    bus.register(id);

    this.state = STATE.IDLE;
    this.stateT = 0;          // time in current state
    this.buttonPressed = false;

    // Observed state from messages
    this.i2Phase = null;      // last known phase at protecting intersection
    this.i2SignalState = null; // 'GREEN' | 'YELLOW' | 'ALLRED' | 'FLASH'
    this.trainEta = Infinity; // seconds until train reaches crossing B
    this.gatesDown = false;
    this.gatesDownAt = null;
    this.pedRequestSent = false; // have we already asked I2 to gap-out?
    this.i2PhaseGreenT = 0;     // how long I2 has been green on the current phase
  }

  /** Called by operator / UI to register a button press */
  pressButton() {
    if (this.state === STATE.WALK) return;   // ignore while WALK active
    this.buttonPressed = true;
    if (this.state === STATE.IDLE) this._transition(STATE.WAITING, 0);
  }

  /**
   * @param {number} t   sim time
   * @param {number} dt  step size
   * @param {string} mode  'PEAK' | 'OFFPEAK' | 'NIGHT'
   * @param {object} model  TrafficModel (for vehicle proximity check)
   */
  tick(t, dt, mode, model) {
    // --- drain inbox ---
    for (const m of this.bus.drain(this.id)) {
      if (m.type === MSG.STATUS_UPDATE && m.from === this.spec.protectingNode) {
        const prev = this.i2SignalState;
        this.i2SignalState = m.data.state;
        this.i2Phase = m.data.phase;
        // Track how long the protecting phase has been green
        if (m.data.state === 'GREEN') {
          if (prev !== 'GREEN') this.i2PhaseGreenT = 0;
        } else {
          this.i2PhaseGreenT = 0;
        }
      } else if (m.type === MSG.TRAIN_APPROACHING && m.data.crossing === 'B') {
        this.trainEta = m.data.eta;
      } else if (m.type === MSG.GATES_UP && m.data.crossing === 'B') {
        this.gatesDown = false;
        this.trainEta = Infinity;
      }
    }

    // Advance the green timer for the protecting intersection
    if (this.i2SignalState === 'GREEN') this.i2PhaseGreenT += dt;

    // Update trainEta countdown
    if (this.trainEta < Infinity) this.trainEta = Math.max(0, this.trainEta - dt);

    // Detect gates-down (from railway state mirrored in sim)
    // The MidBlockPedController gets gates state injected via tick() below.

    this.stateT += dt;

    switch (this.state) {
      case STATE.IDLE:
        break;

      case STATE.WAITING:
        this._waitingStep(t, dt, mode, model);
        break;

      case STATE.WALK:
        if (this.stateT >= this.spec.walkDuration) {
          this._transition(STATE.CLEARING, t);
        }
        break;

      case STATE.CLEARING:
        if (this.stateT >= this.spec.clearDuration) {
          this.buttonPressed = false;
          this.pedRequestSent = false;
          this._transition(STATE.IDLE, t);
        }
        break;
    }
  }

  /** Inject gates state each tick from main loop */
  setGatesDown(down, t) {
    if (down && !this.gatesDown) {
      this.gatesDown = true;
      this.gatesDownAt = t;
    } else if (!down) {
      this.gatesDown = false;
      this.gatesDownAt = null;
    }
  }

  _waitingStep(t, dt, mode, model) {
    const { protectingNode, protectingPhase, trainGuardSecs, safetyLagSecs } = this.spec;

    // Safety guard: never start WALK if train is imminent
    if (this.trainEta <= trainGuardSecs) return;

    // Universal safe condition: I2 phase A is GREEN means the S approach
    // (protectingPhase B, N+S) is red and vehicles have already cleared.
    // This single check covers all modes — natural red, post-flush dwell,
    // and post-PED_REQUEST gap-out.
    const approachSafe = this.i2SignalState === 'GREEN' && this.i2Phase === 'A';

    // Additional peak check: when gates are down we still require the same
    // condition (protecting phase green has ended) before walking.
    if (this.gatesDown && this.gatesDownAt !== null) {
      const timeDown = t - this.gatesDownAt;
      if (timeDown >= safetyLagSecs && approachSafe) {
        this._startWalk(t);
        return;
      }
    }

    // All modes: fire whenever I2 phase A is green (S approach red)
    if (approachSafe) {
      this._startWalk(t);
      return;
    }

    // --- OFF-PEAK: request early gap-out after gMin ---
    // If I2 is stuck on protecting phase B, nudge it to switch after gMin.
    if (mode === 'OFFPEAK'
        && this.i2SignalState === 'GREEN'
        && this.i2Phase === protectingPhase
        && this.i2PhaseGreenT >= 7
        && !this.pedRequestSent) {
      this.pedRequestSent = true;
      this.bus.send(this.id, protectingNode, MSG.PED_REQUEST,
        { linkId: this.spec.linkId }, t, {
          cause: { summary: 'mid-block pedestrian waiting; I2 phase B has served gMin' },
          effect: { summary: 'I2 will gap-out phase B early if no vehicle detection' },
        });
    }

    // --- NIGHT: direct proximity check (no gap-out request needed) ---
    if (mode === 'NIGHT' && !this._vehicleNearby(model)) {
      this._startWalk(t);
    }
  }

  _startWalk(t) {
    this._transition(STATE.WALK, t);
    this.bus.send(this.id, 'CENTRAL', MSG.STATUS_UPDATE, {
      state: 'WALK', plan: 'MID_BLOCK_PED', phase: null,
    }, t, {
      cause: { summary: 'mid-block pedestrian WALK started on I2–I4' },
      effect: { summary: 'update central status board' },
    });
  }

  _transition(newState, t) {
    this.state = newState;
    this.stateT = 0;
  }

  /** True if any in-transit vehicle is within nearVehicleMetres of this crossing */
  _vehicleNearby(model) {
    const { linkId, frac, nearVehicleMetres } = this.spec;
    const link = Object.values(model.pipes).find(
      (p) => p.link && p.link.id === linkId,
    );
    if (!link) return false;
    const linkLen = link.link.len;
    const threshold = nearVehicleMetres / linkLen;
    for (const e of link.entries) {
      if (Math.abs(e.frac - frac) < threshold) return true;
      // Also check vehicles that haven't reached their computed fraction yet
      if (e.frac === undefined) {
        // Estimate current frac from enterT/arriveAt
        // (pipes store raw progress; skip if not computable)
      }
    }
    return false;
  }

  /** View for renderer */
  view() {
    return {
      state: this.state,
      walk: this.state === STATE.WALK,
      waiting: this.state === STATE.WAITING,
    };
  }
}
