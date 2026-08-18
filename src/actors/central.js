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
    this.selfRetimed = new Set(); // alarmed nodes receiving extra discharge green
    this.metered = new Set();     // upstream nodes whose feeding phase is restricted
    this.commandedPlans = {};   // node -> last SET_PLAN successfully delivered
    this.evActive = null;       // {route, legs}
  }

  tick(t, mode) {
    // 1) time-of-day plan selection (a few commands per day, per the brief)
    if (mode !== this.mode) {
      this.mode = mode;
      this.broadcastPlans(t, null, {
        cause: { summary: `time-of-day mode changed to ${mode}` },
        role: 'schedule',
      });
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

  broadcastPlans(t, only = null, context = {}) {
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
      this.sendPlan(node, cmd, t, {
        ...context,
        cause: context.cause ?? { summary: `central resynchronised the ${this.mode} schedule` },
        role: context.role ?? 'schedule',
      });
    }
    // A time-of-day/resync broadcast must not silently drop an active
    // congestion response. The base plans just replaced every override, so
    // rebuild both pieces of the response and its restoration bookkeeping.
    if (Object.keys(this.congested).length) {
      this.retimed.clear();
      this.selfRetimed.clear();
      this.metered.clear();
    }
    for (const key of Object.keys(this.congested)) {
      const [node, approach] = key.split(':');
      this.applyCongestionResponse(node, approach, t, this.congested[key]);
    }
  }

  sendPlan(node, cmd, t, context = {}) {
    const previous = this.commandedPlans[node] ?? { plan: 'ACTUATED', params: {} };
    const roleSummary = {
      'self-retime': 'give the reported approach more discharge green',
      metering: 'restrict the upstream feeding phase',
      restore: 'restore the normal coordinated split',
      schedule: `run the ${this.mode} schedule`,
    }[context.role] ?? 'change the local plan';
    const meta = {
      correlationId: context.correlationId,
      parentType: context.parentType,
      cause: context.cause ?? { summary: 'central plan selection' },
      effect: {
        summary: roleSummary,
        before: clonePlan(previous),
        after: clonePlan(cmd),
      },
      role: context.role,
      reason: context.reason,
      triggeredAt: context.triggeredAt,
    };
    const delivered = this.bus.send('CENTRAL', node, MSG.SET_PLAN, cmd, t, meta);
    if (delivered) this.commandedPlans[node] = clonePlan(cmd);
  }

  // ---- congestion response (accident scenario) --------------------------
  // Meter the inflow: the UPSTREAM neighbor feeding the congested approach
  // gets a fixed plan whose green toward that link is cut; the congested
  // node keeps/gets extra green to drain. Restore normal plans on clear.
  onCongestion(m, t) {
    const key = `${m.from}:${m.data.approach}`;
    if (m.data.active) {
      this.congested[key] = {
        correlationId: m.meta?.correlationId,
        cause: m.meta?.cause,
        parentType: MSG.CONGESTION_ALARM,
        triggeredAt: m.t,
      };
      this.alarms.push({ t, kind: 'CONGESTION', detail: `${m.from} ${m.data.approach} q=${m.data.q}` });
      this.applyCongestionResponse(m.from, m.data.approach, t, this.congested[key]);
    } else {
      delete this.congested[key];
      this.alarms.push({ t, kind: 'CONGESTION_CLEAR', detail: `${m.from} ${m.data.approach}` });
      if (Object.keys(this.congested).length === 0) {
        const nodes = [...this.retimed];
        this.retimed.clear();
        this.selfRetimed.clear();
        this.metered.clear();
        this.broadcastPlans(t, nodes, {           // restore normal plans
          correlationId: m.meta?.correlationId,
          parentType: MSG.CONGESTION_ALARM,
          cause: m.meta?.cause,
          role: 'restore',
          triggeredAt: m.t,
        });
      }
    }
  }

  applyCongestionResponse(node, approach, t, context = {}) {
    this.applySelfRetiming(node, approach, t, context);
    this.applyMetering(node, approach, t, context);
  }

  // Give the alarmed intersection itself more discharge time. Coordinated
  // adaptive control flexes SPLITS, not cycle length: preserving the shared
  // peak cycle and offset keeps the corridor green wave aligned. Eight
  // seconds is roughly one saturation platoon (9.6 veh at 1.2 veh/s), capped
  // so the losing phase always retains its pedestrian-safe minimum.
  applySelfRetiming(node, approach, t, context = {}) {
    const base = this.congestionBasePlan(node);
    const served = ['E', 'W'].includes(approach) ? 'A' : 'B';
    const losing = served === 'A' ? 'B' : 'A';
    const floor = Math.max(CONFIG.minGreen, CONFIG.walkMin);
    const shift = Math.min(CONFIG.congestionGreenShift, Math.max(0, base[`green${losing}`] - floor));
    base[`green${served}`] += shift;
    base[`green${losing}`] -= shift;
    this.sendPlan(node, { plan: 'FIXED', params: base }, t, {
      ...context,
      role: 'self-retime',
      reason: `${node} reported ${approach} queue congestion; phase ${served} gains ${shift.toFixed(1)} s`,
    });
    this.selfRetimed.add(node);
    this.retimed.add(node);
  }

  // Meter the upstream neighbor feeding an INTERNAL congested approach. Its
  // feeding phase is pinned to the pedestrian-safe floor and the remainder
  // moves to the other split. This keeps the existing metering action while
  // retaining the same coordinated cycle and offset.
  applyMetering(node, approach, t, context = {}) {
    const ap = APPROACHES[node][approach];
    if (!ap.link) return;                       // external approach: nothing to meter
    if (this.metered.has(node)) return;         // its congestion is our metering's side effect
    const l = linkById(ap.link);
    const upstream = l.a === node ? l.b : l.a;
    if (this.retimed.has(upstream)) return;     // never cascade-meter an already-metered node
    const base = this.congestionBasePlan(upstream);
    const feedPhase = feedingPhase(upstream, ap.link);
    const otherPhase = feedPhase === 'A' ? 'B' : 'A';
    const effective = base.cycle - 2 * (CONFIG.yellow + CONFIG.allRed);
    base[`green${feedPhase}`] = Math.max(CONFIG.minGreen, CONFIG.walkMin);
    base[`green${otherPhase}`] = effective - base[`green${feedPhase}`];
    this.sendPlan(upstream, { plan: 'FIXED', params: base }, t, {
      ...context,
      role: 'metering',
      reason: `${node} reported ${approach} congestion; ${upstream} meters link ${ap.link} on phase ${feedPhase}`,
    });
    this.metered.add(upstream);
    this.retimed.add(upstream);
  }

  congestionBasePlan(node) {
    const mode = this.mode === 'NIGHT' ? 'OFFPEAK' : this.mode;
    if (this.mode !== 'PEAK') return websterPlan(node, mode, 0);
    const nodes = Object.keys(INTERSECTIONS);
    const netCycle = Math.max(...nodes.map((n) => websterPlan(n, 'PEAK').cycle));
    return websterPlan(node, 'PEAK', corridorOffsets()[node], netCycle);
  }

  // ---- operator: EV corridor --------------------------------------------
  /** legs come from IncidentSystem.dispatchEV: [{node, approach, eta}] */
  commandEVCorridor(legs, t) {
    const correlationId = this.bus.correlation('EV');
    this.evActive = { legs, correlationId };
    for (const [index, leg] of legs.entries()) {
      const eta = leg.eta - t;
      this.bus.send('CENTRAL', leg.node, MSG.PREEMPT,
        { approach: leg.approach, eta: leg.eta }, t, {
          correlationId,
          root: index === 0,
          parentType: index === 0 ? null : MSG.PREEMPT,
          cause: {
            summary: `priority vehicle dispatched toward ${leg.node} ${leg.approach}`,
            measurement: { label: 'eta', value: rounded(eta), unit: 's' },
            threshold: { label: 'green lead', operator: '−', value: CONFIG.evHoldLead, unit: 's' },
            held: 0,
          },
          effect: { summary: `schedule phase ${['E', 'W'].includes(leg.approach) ? 'A' : 'B'} green before arrival` },
          role: 'ev-preempt',
        });
    }
  }
  onEvPassed(node, t) {
    const leg = this.evActive?.legs.find((x) => x.node === node);
    this.bus.send('CENTRAL', node, MSG.RESUME, {}, t, {
      correlationId: this.evActive?.correlationId,
      parentType: MSG.PREEMPT,
      cause: { summary: `priority vehicle passed ${node}${leg ? ` from ${leg.approach}` : ''}` },
      effect: { summary: 'clear EV preempt and recover into the commanded plan' },
      role: 'ev-resume',
    });
  }
  onEvDone(t) { this.evActive = null; }
}

function clonePlan(plan) {
  return { plan: plan.plan, params: { ...(plan.params ?? {}) } };
}

function rounded(n) { return Math.round(n * 10) / 10; }

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
