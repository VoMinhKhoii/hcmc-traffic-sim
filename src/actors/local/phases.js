// actors/local/phases.js — the signal state machine.
// One phase green at a time; every green→red passes YELLOW(3s)→ALLRED(2s).
// The machine is the ONLY thing that changes light state, so the safety
// invariant (no conflicting greens) holds by construction.

import { CONFIG } from '../../config.js';
import { PHASES } from '../../network.js';

export class SignalMachine {
  constructor(node) {
    this.node = node;
    this.phase = 'A';          // phase whose lights are (or will next be) green
    this.state = 'GREEN';      // GREEN | YELLOW | ALLRED | FLASH
    this.stateT = 0;           // seconds in current state
    this.pending = null;       // phase to serve after clearance
    this.walk = false;         // WALK shown for current phase's parallel crossings
    this.changed = true;       // set on any state change (drives STATUS_UPDATE)
  }

  greenDirs() { return this.state === 'GREEN' ? PHASES[this.phase] : []; }

  // request switch to `phase` (no-op if already there or already clearing).
  // Leaving FLASH goes through ALL-RED first: traffic was moving under
  // flashing yellow, so a direct jump to a conflicting green is unsafe.
  requestPhase(phase) {
    if (this.state === 'FLASH') { this.pending = phase; this.setState('ALLRED'); return; }
    if (this.phase === phase && this.state === 'GREEN') return;
    if (this.pending) return;
    if (this.state === 'GREEN') { this.pending = phase; this.setState('YELLOW'); }
  }

  enterFlash() { if (this.state !== 'FLASH') { this.pending = null; this.setState('FLASH'); } }
  exitFlash(phase = 'A') { if (this.state === 'FLASH') { this.pending = phase; this.setState('ALLRED'); } }

  setState(state, phase = null) {
    this.state = state; this.stateT = 0; this.changed = true;
    if (phase) this.phase = phase;
  }

  tick(dt) {
    this.stateT += dt;
    if (this.state === 'YELLOW' && this.stateT >= CONFIG.yellow) this.setState('ALLRED');
    else if (this.state === 'ALLRED' && this.stateT >= CONFIG.allRed) {
      const next = this.pending ?? (this.phase === 'A' ? 'B' : 'A');
      this.pending = null;
      this.setState('GREEN', next);
    }
  }

  // light state as physics + renderer see it
  view() { return { state: this.state, green: this.state === 'GREEN' ? this.phase : null, walk: this.walk }; }
}
