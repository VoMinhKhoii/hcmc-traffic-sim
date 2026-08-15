// messages.js — the typed message set and the bus.
// THIS FILE IS THE DESIGN REPORT'S MESSAGE TABLE. Every inter-controller
// behavior in the system flows through these nine types and nothing else;
// the QNX port replaces `inbox/send` with MsgSend/MsgReceive, same payloads.

export const MSG = {
  STATUS_UPDATE:     'STATUS_UPDATE',     // local → central: any light-state change {phase, state, mode}
  SET_PLAN:          'SET_PLAN',          // central → local: {plan:'FIXED'|'ACTUATED'|'FLASH', params}
  TRAIN_APPROACHING: 'TRAIN_APPROACHING', // railway → local(I2/I5): {crossing, eta}
  GATES_UP:          'GATES_UP',          // railway → local(I2/I5): {crossing}
  GATE_FAULT:        'GATE_FAULT',        // railway → central: {crossing}
  CONGESTION_ALARM:  'CONGESTION_ALARM',  // local → central: {approach, q, active:bool}
  PREEMPT:           'PREEMPT',           // central → local: {approach, eta}  (priority vehicle)
  RESUME:            'RESUME',            // central → local: end preempt/override, rejoin plan
  ALARM:             'ALARM',             // any → central: operator-visible fault {kind, detail}
};

export class MessageBus {
  constructor() {
    this.inboxes = {};        // actorId -> [{from,type,data,t}]
    this.linkUp = {};         // localId -> bool (comm link to central)
    this.buffered = {};       // localId -> messages held while link down
    this.log = [];            // full traffic, for the event log + audit
    this.onLog = null;
  }
  register(id) { this.inboxes[id] = []; this.linkUp[id] = true; this.buffered[id] = []; }

  send(from, to, type, data = {}, t = 0) {
    const msg = { from, to, type, data, t };
    // central link failure model: traffic between a local and CENTRAL is cut
    const local = from === 'CENTRAL' ? to : to === 'CENTRAL' ? from : null;
    if (local !== null && this.linkUp[local] === false) {
      if (to === 'CENTRAL') this.buffered[from].push(msg);   // local buffers its reports
      this.record({ ...msg, dropped: true });
      return false;
    }
    this.inboxes[to]?.push(msg);
    this.record(msg);
    return true;
  }

  setLink(localId, up, t = 0) {
    const was = this.linkUp[localId];
    this.linkUp[localId] = up;
    if (up && !was) {   // reconnect: flush buffered status reports
      for (const m of this.buffered[localId]) { this.inboxes.CENTRAL?.push(m); this.record({ ...m, flushed: true }); }
      this.buffered[localId] = [];
    }
  }

  drain(id) { const m = this.inboxes[id]; this.inboxes[id] = []; return m; }
  record(m) { this.log.push(m); if (this.log.length > 4000) this.log.shift(); this.onLog?.(m); }
}
