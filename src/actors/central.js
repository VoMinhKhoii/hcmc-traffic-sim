// @ts-check
// actors/central.js — the CentralController (control room).
// Monitors (status board), selects patterns a few times a day, and issues
// override commands. It NEVER sets a light: locals always own their lights.

import { CONFIG } from '../config.js';
import { INTERSECTIONS, APPROACHES, linkById } from '../network.js';
import { MSG } from '../messages.js';
import { websterPlan, corridorOffsets } from './local/plans.js';

export class CentralController {
  constructor(bus) {
    this.bus = bus;
    bus.register('CENTRAL');
    this.mode = null;
    this.board = {};            // node -> last STATUS_UPDATE (the status display)
    this.alarms = [];           // operator-visible alarms
    this.congested = {};        // "node:dir" -> true while alarm active
    this.retimed = new Set();   // nodes currently on a congestion-adjusted plan
    this.evActive = null;       // {route, legs}
  }

  tick(t, mode) {
    // 1) time-of-day plan selection (a few commands per day, per the brief)
    if (mode !== this.mode) {
      this.mode = mode;
      this.broadcastPlans(t);
    }
    // 2) inbox
    for (const m of this.bus.drain('CENTRAL')) {
      switch (m.type) {
        case MSG.STATUS_UPDATE: this.board[m.from] = { ...m.data, t: m.t }; break;
        case MSG.GATE_FAULT:
          this.alarms.push({ t, kind: 'GATE_FAULT', detail: `crossing ${m.data.crossing}` });
          break;
        case MSG.ALARM: this.alarms.push({ t, kind: m.data.kind, detail: m.data.detail }); break;
        case MSG.CONGESTION_ALARM: this.onCongestion(m, t); break;
      }
    }
  }

  broadcastPlans(t, only = null) {
    const offs = corridorOffsets();
    const nodes = Object.keys(INTERSECTIONS);
    // network cycle: every coordinated intersection shares the LONGEST Webster
    // cycle so the offsets line up into real green waves (standard practice)
    const netCycle = Math.max(...nodes.map((n) => websterPlan(n, 'PEAK').cycle));
    for (const node of nodes) {
      if (only && !only.includes(node)) continue;
      let cmd;
      if (this.mode === 'PEAK') cmd = { plan: 'FIXED', params: websterPlan(node, 'PEAK', offs[node], netCycle) };
      else if (this.mode === 'NIGHT') cmd = { plan: 'FLASH', params: {} };
      else cmd = { plan: 'ACTUATED', params: {} };
      this.bus.send('CENTRAL', node, MSG.SET_PLAN, cmd, t);
    }
  }

  // ---- congestion response (accident scenario) --------------------------
  // Meter the inflow: the UPSTREAM neighbor feeding the congested approach
  // gets a fixed plan whose green toward that link is cut; the congested
  // node keeps/gets extra green to drain. Restore normal plans on clear.
  onCongestion(m, t) {
    const key = `${m.from}:${m.data.approach}`;
    if (m.data.active) {
      this.congested[key] = true;
      this.alarms.push({ t, kind: 'CONGESTION', detail: `${m.from} ${m.data.approach} q=${m.data.q}` });
      const ap = APPROACHES[m.from][m.data.approach];
      if (!ap.link) return;                       // external approach: nothing to meter
      const l = linkById(ap.link);
      const upstream = l.a === m.from ? l.b : l.a;
      // upstream: fixed plan with the phase feeding this link shortened 40%
      const base = websterPlan(upstream, this.mode === 'NIGHT' ? 'OFFPEAK' : this.mode, 0);
      // cut hard: metering only works if capacity drops BELOW the arrival rate
      const feedPhase = feedingPhase(upstream, ap.link);
      if (feedPhase === 'A') base.greenA = Math.max(CONFIG.minGreen, base.greenA * 0.35);
      else base.greenB = Math.max(CONFIG.minGreen, base.greenB * 0.35);
      base.cycle = base.greenA + base.greenB + 2 * (CONFIG.yellow + CONFIG.allRed);
      this.bus.send('CENTRAL', upstream, MSG.SET_PLAN, { plan: 'FIXED', params: base }, t);
      this.retimed.add(upstream);
    } else {
      delete this.congested[key];
      this.alarms.push({ t, kind: 'CONGESTION_CLEAR', detail: `${m.from} ${m.data.approach}` });
      if (Object.keys(this.congested).length === 0) {
        const nodes = [...this.retimed];
        this.retimed.clear();
        this.broadcastPlans(t, nodes);            // restore normal plans
      }
    }
  }

  // ---- operator: EV corridor --------------------------------------------
  /** legs come from IncidentSystem.dispatchEV: [{node, approach, eta}] */
  commandEVCorridor(legs, t) {
    this.evActive = { legs };
    for (const leg of legs)
      this.bus.send('CENTRAL', leg.node, MSG.PREEMPT, { approach: leg.approach, eta: leg.eta }, t);
  }
  onEvPassed(node, t) { this.bus.send('CENTRAL', node, MSG.RESUME, {}, t); }
  onEvDone(t) { this.evActive = null; }
}

function feedingPhase(node, linkId) {
  // which of `node`'s phases discharges INTO linkId? The approach OPPOSITE the
  // one connected to linkId sends its through traffic there.
  for (const [d, ap] of Object.entries(APPROACHES[node])) {
    if (ap.link === linkId) {
      const opp = { N: 'S', S: 'N', E: 'W', W: 'E' }[d];
      return ['E', 'W'].includes(opp) ? 'A' : 'B';
    }
  }
  return 'A';
}
