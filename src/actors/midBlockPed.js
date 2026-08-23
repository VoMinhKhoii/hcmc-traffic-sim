// @ts-check
// actors/midBlockPed.js — Mid-block pedestrian crossing controller for I2–I4.
//
// PEAK:    button → WAITING → fires when gates close (railway dwell clears the road)
// OFFPEAK: button → VEHICLE_GREEN (20s) → VEHICLE_YELLOW (3s) → WALK/red (13s) → CLEARING (2s)
// NIGHT:   button → WAITING → fires when no vehicle detected within 50m

import { MSG } from '../messages.js';

const STATE = {
  IDLE:            'IDLE',
  WAITING:         'WAITING',
  VEHICLE_GREEN:   'VEHICLE_GREEN',   // off-peak: vehicle light counting down green
  VEHICLE_YELLOW:  'VEHICLE_YELLOW',  // off-peak: vehicle light yellow
  WALK:            'WALK',
  CLEARING:        'CLEARING',
};

const OFFPEAK_GREEN_DURATION  = 20;  // s — vehicle green countdown before ped WALK
const OFFPEAK_YELLOW_DURATION =  3;  // s — vehicle yellow after green

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
    this.stateT = 0;
    this.buttonPressed = false;
    this.blockingTraffic = false;  // true while WALK active — queues read this

    // Observed state from messages
    this.i2Phase = null;
    this.i2SignalState = null;
    this.trainEta = Infinity;
    this.gatesDown = false;
    this.gatesDownAt = null;
    this.pedRequestSent = false;
    this.i2PhaseGreenT = 0;
  }

  /** Called by operator / UI to register a button press */
  pressButton() {
    if (this.state === STATE.WALK) return;
    if (this.state !== STATE.IDLE) return;  // already counting down or waiting
    this.buttonPressed = true;
    this._transition(STATE.WAITING);
  }

  /**
   * @param {number} t   sim time
   * @param {number} dt  step size
   * @param {string} mode  'PEAK' | 'OFFPEAK' | 'NIGHT'
   * @param {object} model  TrafficModel
   */
  tick(t, dt, mode, model) {
    // --- drain inbox ---
    for (const m of this.bus.drain(this.id)) {
      if (m.type === MSG.STATUS_UPDATE && m.from === this.spec.protectingNode) {
        const prev = this.i2SignalState;
        this.i2SignalState = m.data.state;
        this.i2Phase = m.data.phase;
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

    if (this.i2SignalState === 'GREEN') this.i2PhaseGreenT += dt;
    if (this.trainEta < Infinity) this.trainEta = Math.max(0, this.trainEta - dt);

    this.stateT += dt;

    switch (this.state) {
      case STATE.IDLE:
        break;

      case STATE.WAITING:
        this._waitingStep(t, dt, mode, model);
        break;

      // --- off-peak countdown states ---
      case STATE.VEHICLE_GREEN:
        if (this.stateT >= OFFPEAK_GREEN_DURATION) {
          this._transition(STATE.VEHICLE_YELLOW);
        }
        break;

      case STATE.VEHICLE_YELLOW:
        if (this.stateT >= OFFPEAK_YELLOW_DURATION) {
          this._startWalk(t);
        }
        break;

      case STATE.WALK:
        if (this.stateT >= this.spec.walkDuration) {
          this._transition(STATE.CLEARING);
        }
        break;

      case STATE.CLEARING:
        if (this.stateT >= this.spec.clearDuration) {
          this.blockingTraffic = false;
          this.buttonPressed = false;
          this.pedRequestSent = false;
          this._transition(STATE.IDLE);
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

    if (this.trainEta <= trainGuardSecs && !this.gatesDown) return;

    // --- PEAK: wait for safety barriers to close, then walk immediately ---
    if (mode === 'PEAK') {
      if (this.gatesDown && this.gatesDownAt !== null) {
        const timeDown = t - this.gatesDownAt;
        if (timeDown >= safetyLagSecs) this._startWalk(t);
      }
      return;
    }

    // --- OFF-PEAK: start the vehicle green countdown immediately ---
    // The countdown itself creates the gap: 20s green warning → 3s yellow → WALK.
    if (mode === 'OFFPEAK') {
      this._transition(STATE.VEHICLE_GREEN);
      return;
    }

    // --- NIGHT: direct proximity check ---
    if (mode === 'NIGHT' && !this._vehicleNearby(model)) {
      this._startWalk(t);
    }
  }

  _startWalk(t) {
    this._transition(STATE.WALK);
    this.blockingTraffic = true;
    this.bus.send(this.id, 'CENTRAL', MSG.STATUS_UPDATE, {
      state: 'WALK', plan: 'MID_BLOCK_PED', phase: null,
    }, t, {
      cause: { summary: 'mid-block pedestrian WALK started on I2–I4' },
      effect: { summary: 'update central status board' },
    });
  }

  _transition(newState) {
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
    }
    return false;
  }

  /** View for renderer — exposes countdown seconds and vehicle light aspect */
  view() {
    const { state, stateT } = this;
    let vehicleAspect = 'green';  // default: vehicles may go
    let countdown = null;

    if (state === STATE.VEHICLE_GREEN) {
      vehicleAspect = 'green';
      countdown = Math.ceil(OFFPEAK_GREEN_DURATION - stateT);
    } else if (state === STATE.VEHICLE_YELLOW) {
      vehicleAspect = 'yellow';
      countdown = Math.ceil(OFFPEAK_YELLOW_DURATION - stateT);
    } else if (state === STATE.WALK || state === STATE.CLEARING) {
      vehicleAspect = 'red';
      if (state === STATE.WALK) countdown = Math.ceil(this.spec.walkDuration - stateT);
    }

    return {
      state,
      walk:           state === STATE.WALK,
      waiting:        state === STATE.WAITING || state === STATE.VEHICLE_GREEN || state === STATE.VEHICLE_YELLOW,
      vehicleAspect,
      countdown,
    };
  }
}
