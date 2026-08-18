// @ts-check
// verify.js — verification matrix (plan §Verification).
// Run:  node verify.js          (all scenarios)
//       node verify.js 8 11     (selected)
// Prints PASS/FAIL per scenario; exits non-zero on any FAIL.

import { CONFIG } from './src/config.js';
import { MSG } from './src/messages.js';
import { CROSSINGS } from './src/network.js';
import { RAIL } from './src/physics/trains.js';
import { Simulation } from './src/main.js';

const results = [];
const seenTypes = new Set();
function scenario(n, name, fn) {
  if (only.length && !only.includes(n)) return;
  try {
    const notes = fn() ?? '';
    results.push({ n, name, ok: true, notes });
    console.log(`  PASS  ${String(n).padStart(2)}. ${name}${notes ? ` — ${notes}` : ''}`);
  } catch (e) {
    results.push({ n, name, ok: false, notes: e.message });
    console.log(`  FAIL  ${String(n).padStart(2)}. ${name} — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function fresh(hour, opts = {}) {
  const sim = new Simulation();
  sim.clock.startHour = hour;
  if (opts.noTrains) sim.trains.nextSpawn = Infinity;
  sim.bus.onLog = (m) => { if (!m.dropped) seenTypes.add(m.type); };
  return sim;
}
function greenLog(sim) {
  // [{node, phase, start, end}] reconstructed from STATUS_UPDATE traffic
  const greens = [];
  const open = {};
  for (const m of sim.bus.log) {
    if (m.type !== MSG.STATUS_UPDATE || m.dropped) continue;
    if (m.data.state === 'GREEN') open[m.from] = { node: m.from, phase: m.data.phase, start: m.t, preempt: m.data.preempt };
    else if (open[m.from]) { greens.push({ ...open[m.from], end: m.t }); delete open[m.from]; }
  }
  return greens;
}
const only = process.argv.slice(2).map(Number).filter((x) => !isNaN(x));
console.log('HCMC traffic sim — verification matrix\n');

// ---------- foundation sanity (feeds scenario 1/17 conservation) ----------
scenario(0, 'Conservation: vehicles in = out + in-network', () => {
  const sim = fresh(10, { noTrains: true });
  sim.run(600);
  const err = Math.abs(sim.model.conservationError());
  assert(err < 1e-3 * Math.max(1, sim.model.totIn), `conservation error ${err.toFixed(4)}`);
  return `in=${sim.model.totIn.toFixed(0)} out=${sim.model.totOut.toFixed(0)} err=${err.toExponential(1)}`;
});

scenario(1, 'Peak fixed plans: Webster cycles, offsets, bounded queues', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(900);
  for (const [n, b] of Object.entries(sim.central.board)) assert(b.plan === 'FIXED', `${n} not FIXED`);
  const p3 = sim.locals.I3.plan.params, p5 = sim.locals.I5.plan.params;
  assert(p3.cycle >= CONFIG.cycleMin && p3.cycle <= CONFIG.cycleMax, `cycle ${p3.cycle}`);
  assert(Math.abs(p3.cycle - p5.cycle) < 0.01, 'network cycle not shared');
  const off = p5.offset - p3.offset;
  assert(Math.abs(off - 430 / (40 / 3.6)) < 1, `I3→I5 offset ${off.toFixed(1)}s`);
  let maxQ = 0;
  for (const a of Object.values(sim.model.approaches)) maxQ = Math.max(maxQ, a.q);
  assert(maxQ < 60, `queue unbounded: ${maxQ.toFixed(0)} veh`);
  return `net cycle=${p3.cycle.toFixed(0)}s offset(I3→I5)=${off.toFixed(1)}s maxQ=${maxQ.toFixed(1)}`;
});

scenario(2, 'Off-peak actuated: min/max green, gap-out bounds', () => {
  const sim = fresh(10, { noTrains: true });
  sim.run(900);
  for (const [n, b] of Object.entries(sim.central.board)) assert(b.plan === 'ACTUATED', `${n} not ACTUATED`);
  const greens = greenLog(sim).filter((g) => !g.preempt && g.start > 60);
  assert(greens.length > 20, `too few greens observed (${greens.length})`);
  for (const g of greens) {
    const len = g.end - g.start;
    assert(len >= CONFIG.minGreen - 0.3, `${g.node} green ${len.toFixed(1)}s < min`);
    assert(len <= CONFIG.maxGreen * CONFIG.recoveryBoost + 1, `${g.node} green ${len.toFixed(1)}s > max`);
  }
  return `${greens.length} greens all within [${CONFIG.minGreen}, ${CONFIG.maxGreen}]s`;
});

scenario(3, 'Night flash + ped button summons a full cycle', () => {
  const sim = fresh(23.5, { noTrains: true });
  sim.run(120);
  for (const [n, lc] of Object.entries(sim.locals)) assert(lc.machine.state === 'FLASH', `${n} not FLASH`);
  sim.pressPed('I3', 'N');
  let sawGreen = false, backToFlash = false;
  for (let i = 0; i < 1200; i++) {
    sim.step();
    const st = sim.locals.I3.machine.state;
    if (st === 'GREEN') sawGreen = true;
    if (sawGreen && st === 'FLASH') { backToFlash = true; break; }
  }
  assert(sawGreen, 'ped button never produced a green');
  assert(backToFlash, 'never returned to flash');
});

scenario(4, 'Compressed 24h day: mode transitions, no stuck signals', () => {
  const sim = fresh(6);
  const modes = new Set(); const plans = new Set();
  for (let i = 0; i < 864000; i++) {   // 24 h at dt=0.1
    sim.step();
    if (i % 6000 === 0) { modes.add(sim.clock.mode); plans.add(sim.locals.I4.plan.type); }
  }
  assert(modes.size === 3, `modes seen: ${[...modes]}`);
  assert(plans.has('FIXED') && plans.has('ACTUATED') && plans.has('FLASH'), `plans seen: ${[...plans]}`);
  assert(sim.conflictViolations === 0, 'conflicting greens');
  assert(sim.model.safetyViolations.length === 0, `${sim.model.safetyViolations.length} track-spillback events`);
  return `24 h, all 3 modes, ${sim.bus.log.length} recent msgs, 0 violations`;
});

scenario(5, 'Every green→red passes YELLOW(3)→ALLRED(2)', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(600);
  const seq = sim.bus.log.filter((m) => m.type === MSG.STATUS_UPDATE && m.from === 'I1' && !m.dropped);
  let prev = null, checked = 0;
  for (const m of seq) {
    if (prev?.data.state === 'GREEN')
      assert(m.data.state === 'YELLOW' || m.data.state === 'FLASH', `GREEN → ${m.data.state}`);
    if (prev?.data.state === 'YELLOW') {
      assert(m.data.state === 'ALLRED', `YELLOW → ${m.data.state}`);
      assert(Math.abs(m.t - prev.t - CONFIG.yellow) < 0.3, `yellow lasted ${(m.t - prev.t).toFixed(1)}s`);
      checked++;
    }
    if (prev?.data.state === 'ALLRED' && m.data.state === 'GREEN')
      assert(Math.abs(m.t - prev.t - CONFIG.allRed) < 0.3, `all-red lasted ${(m.t - prev.t).toFixed(1)}s`);
    prev = m;
  }
  assert(checked > 5, 'too few transitions observed');
  return `${checked} clearance sequences checked`;
});

scenario(6, 'Peak: WALK every cycle, ≥ walkMin green', () => {
  const sim = fresh(7, { noTrains: true });
  let walksA = 0, walksB = 0;
  for (let i = 0; i < 6000; i++) {
    sim.step();
    const m = sim.locals.I1.machine;
    if (m.walk && m.phase === 'A' && m.stateT < 0.2) walksA++;
    if (m.walk && m.phase === 'B' && m.stateT < 0.2) walksB++;
  }
  assert(walksA > 2 && walksB > 2, `walks A=${walksA} B=${walksB}`);
  const p = sim.locals.I1.plan.params;
  assert(p.greenA >= CONFIG.walkMin && p.greenB >= CONFIG.walkMin, 'green < walk minimum');
  return `WALK served on both phases, greens ≥ ${CONFIG.walkMin}s`;
});

scenario(7, 'Off-peak: no WALK without button; button forces skipped phase', () => {
  CONFIG.demandMultiplier = 0;        // dead of off-peak: no cars at all
  const sim = fresh(10, { noTrains: true });
  sim.run(300);
  let walked = false;
  for (let i = 0; i < 3000; i++) { sim.step(); if (sim.locals.I5.machine.walk) walked = true; }
  assert(!walked, 'WALK shown without any button');
  const before = sim.locals.I5.machine.phase;
  const want = before === 'A' ? 'B' : 'A';
  sim.pressPed('I5', want === 'A' ? 'E' : 'N');   // request the resting phase's crossing
  let served = false;
  for (let i = 0; i < 1200; i++) {
    sim.step();
    const m = sim.locals.I5.machine;
    if (m.state === 'GREEN' && m.phase === want) { served = true; break; }
  }
  CONFIG.demandMultiplier = 1;
  assert(served, 'button did not force the skipped phase');
});

scenario(8, 'Single train at peak: preemption, pocket safe, recovery', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(120);
  sim.forceTrain(1);
  let preempted = false, gatesClosed = false;
  for (let i = 0; i < 12000; i++) {
    sim.step();
    if (sim.locals.I5.overlay.active() === 'TRAIN') preempted = true;
    if (sim.railway.crossings.A.state === 'CLOSED') gatesClosed = true;
  }
  assert(preempted, 'I5 never entered rail preemption');
  assert(gatesClosed, 'gates never closed');
  assert(sim.model.safetyViolations.length === 0, 'vehicles on tracks with train present');
  assert(sim.locals.I5.overlay.rail === null, 'preemption never released');
  assert(sim.railway.crossings.A.state === 'OPEN', 'gates never reopened');
  const gotMsgs = sim.bus.log.filter((m) => m.type === MSG.TRAIN_APPROACHING && m.to === 'I5').length;
  assert(gotMsgs >= 1, 'no TRAIN_APPROACHING to I5');
});

scenario(9, 'Back-to-back trains (2-min headway) handled cleanly', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(60);
  sim.forceTrain(1);
  sim.run(120);
  sim.forceTrain(-1);
  sim.run(600);
  assert(sim.model.safetyViolations.length === 0, 'track spillback');
  for (const [name, c] of Object.entries(CROSSINGS)) {
    assert(sim.railway.crossings[name].state === 'OPEN', `${name} gates stuck`);
    assert(sim.locals[c.intersection].overlay.rail === null, `${c.intersection} preempt stuck`);
  }
  assert(sim.conflictViolations === 0, 'conflicting greens');
});

scenario(10, 'Train at night: I5 exits flash into preemption, returns to flash', () => {
  const sim = fresh(23.5, { noTrains: true });
  sim.run(60);
  assert(sim.locals.I5.machine.state === 'FLASH', 'not flashing at night');
  sim.forceTrain(1);
  let leftFlash = false, back = false;
  for (let i = 0; i < 12000; i++) {
    sim.step();
    const m = sim.locals.I5.machine;
    if (sim.locals.I5.overlay.rail && m.state !== 'FLASH') leftFlash = true;
    if (leftFlash && !sim.locals.I5.overlay.rail && m.state === 'FLASH') { back = true; break; }
  }
  assert(leftFlash, 'never left flash for the train');
  assert(back, 'never returned to flash');
});

scenario(11, 'EV corridor I1→I2→I4: green before each ETA, resumes after', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(120);
  const legs = sim.dispatchEV(['I1', 'I2', 'I4']);
  const checks = {};
  for (let i = 0; i < 6000; i++) {
    sim.step();
    for (const leg of legs) {
      // green at any point in the arrival window (RESUME may begin the
      // transition back the instant the EV clears the stop line)
      if (leg.eta - sim.t >= 0 && leg.eta - sim.t < 0.5) {
        const m = sim.locals[leg.node].machine;
        const wantPhase = ['E', 'W'].includes(leg.approach) ? 'A' : 'B';
        checks[leg.node] ||= m.state === 'GREEN' && m.phase === wantPhase;
      }
    }
    if (sim.incidents.ev?.done) break;
  }
  for (const leg of legs) assert(checks[leg.node], `${leg.node} not green at EV arrival`);
  assert(sim.incidents.ev.done, 'EV never completed the route');
  sim.run(30);
  for (const leg of legs) assert(sim.locals[leg.node].overlay.ev === null, `${leg.node} never RESUMEd`);
  return `ETAs: ${legs.map((l) => `${l.node}@${(l.eta - 120).toFixed(0)}s`).join(' ')}`;
});

scenario(12, 'EV vs train: rail preemption outranks, EV waits at gates', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(60);
  sim.forceTrain(1);              // will close crossing B on the EV's path
  sim.run(30);
  sim.dispatchEV(['I1', 'I2', 'I4']);
  let stalled = false, prevS = -1, trainWon = false, done = false;
  for (let i = 0; i < 12000; i++) {
    sim.step();
    const ev = sim.incidents.ev;
    if (ev && !ev.done) {
      if (Math.abs(ev.s - prevS) < 1e-9 && sim.railway.gatesDown().B) stalled = true;
      prevS = ev.s;
    }
    if (sim.locals.I2.overlay.active() === 'TRAIN') trainWon = true;
    if (ev?.done) { done = true; break; }
  }
  assert(trainWon, 'I2 never prioritized the train over the EV');
  assert(stalled, 'EV drove through closed gates');
  assert(done, 'EV never finished after the train cleared');
});

scenario(13, 'Accident: alarm → central re-times → restore (vs control run)', () => {
  const run = (respond) => {
    const sim = fresh(7, { noTrains: true });
    sim.run(120);
    sim.dropAccident('I6-I4', 'I6', 2, 300);   // block Trần Huy Liệu southbound
    if (!respond) sim.centralAlive = false;    // control run: nobody reacts
    let maxQ = 0;
    for (let i = 0; i < 9000; i++) {           // 900 s covers accident + recovery
      sim.step();
      maxQ = Math.max(maxQ, sim.model.ap('I6', 'N').q);
    }
    return { sim, maxQ };
  };
  const active = run(true), control = run(false);
  const log = active.sim.bus.log;
  assert(log.some((m) => m.type === MSG.CONGESTION_ALARM && m.data.active), 'no alarm raised');
  assert(log.some((m) => m.type === MSG.SET_PLAN && m.to === 'I5' && m.data.plan === 'FIXED' && m.t > 120),
    'central never re-timed the upstream neighbor');
  assert(log.some((m) => m.type === MSG.CONGESTION_ALARM && m.data.active === false), 'alarm never cleared');
  assert(active.maxQ <= control.maxQ + 1, `response made it worse (${active.maxQ.toFixed(0)} vs ${control.maxQ.toFixed(0)})`);
  return `peak queue: with response ${active.maxQ.toFixed(0)} veh, without ${control.maxQ.toFixed(0)} veh`;
});

scenario(14, 'Kill central: locals autonomous, buffer + resync on reconnect', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(120);
  sim.killCentral();
  sim.run(300);
  // locals must keep cycling while central is dead (count via machine, not bus)
  for (const [n, lc] of Object.entries(sim.locals))
    assert(lc.machine.state !== undefined && sim.bus.buffered[n].length > 0, `${n} not buffering while cut off`);
  const buffered = Object.values(sim.bus.buffered).reduce((s, b) => s + b.length, 0);
  assert(buffered > 10, 'no status buffered during outage');
  sim.restoreCentral();
  sim.run(30);
  const flushed = sim.bus.log.filter((m) => m.flushed).length;
  assert(flushed > 0, 'buffer never flushed on reconnect');
  for (const b of Object.values(sim.bus.buffered)) assert(b.length === 0, 'buffer not emptied');
  return `${buffered} msgs buffered, ${flushed} flushed on resync`;
});

scenario(15, 'Kill central during preemption: sequence completes safely', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(60);
  sim.forceTrain(1);
  sim.run(45);                       // preemption underway
  sim.killCentral();
  sim.run(400);
  assert(sim.locals.I5.overlay.rail === null, 'preemption stuck after central died');
  assert(sim.model.safetyViolations.length === 0, 'track spillback');
  assert(sim.conflictViolations === 0, 'conflicting greens');
  const m = sim.locals.I5.machine;
  assert(['GREEN', 'YELLOW', 'ALLRED', 'FLASH'].includes(m.state), 'invalid state');
});

scenario(16, 'Jam gate: train signal RED, alarm, toward-track reds, train stops', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(60);
  sim.jamGate('A');
  assert(sim.trains.signalRed, 'train signal not red');
  sim.run(10);
  assert(sim.central.alarms.some((a) => a.kind === 'GATE_FAULT'), 'no GATE_FAULT alarm at control room');
  sim.forceTrain(1);
  let minDist = Infinity;
  for (let i = 0; i < 6000; i++) {
    sim.step();
    for (const tr of sim.trains.trains) minDist = Math.min(minDist, RAIL.s('A') - tr.s);
  }
  assert(minDist > 0, `train entered jammed crossing (got ${minDist.toFixed(0)}m past stop)`);
  // toward-track approaches held red: I5 sits in HOLD (phase B green at most)
  const m = sim.locals.I5.machine;
  assert(sim.locals.I5.overlay.rail !== null, 'I5 not holding for the fault');
  assert(!(m.state === 'GREEN' && m.phase === 'A'), 'toward-track movement green during fault');
  sim.clearGateFault('A');
  sim.run(600);
  assert(!sim.trains.signalRed, 'signal still red after fix');
  assert(sim.locals.I5.overlay.rail === null, 'hold never released after fix');
});

scenario(17, 'Combined stress: peak + trains + accident + EV', () => {
  const sim = fresh(7);
  sim.trains.nextSpawn = 30;               // natural 2-min peak headway
  sim.run(100);
  sim.dropAccident('I6-I4', 'I6', 1, 300);
  sim.run(50);
  sim.dispatchEV(['I1', 'I2', 'I4']);
  sim.run(750);
  assert(sim.conflictViolations === 0, 'conflicting greens');
  assert(sim.model.safetyViolations.length === 0, 'track spillback');
  const err = Math.abs(sim.model.conservationError());
  assert(err < 1e-3 * sim.model.totIn, `conservation drift ${err.toFixed(3)}`);
  let maxQ = 0;
  for (const a of Object.values(sim.model.approaches)) maxQ = Math.max(maxQ, a.q);
  assert(maxQ < 200, `network gridlocked (${maxQ.toFixed(0)} veh)`);
  return `maxQ=${maxQ.toFixed(0)} veh, conservation err ${err.toExponential(1)}`;
});

// ---- regression scenarios from the Codex adversarial review ---------------

scenario(19, 'Flash exit passes through ALL-RED (never FLASH→GREEN direct)', () => {
  const sim = fresh(23.5, { noTrains: true });
  sim.run(60);
  sim.pressPed('I3', 'N');
  let prev = 'FLASH', sawAllRed = false, entered = false;
  for (let i = 0; i < 1200; i++) {
    sim.step();
    const st = sim.locals.I3.machine.state;
    if (prev === 'FLASH' && st === 'GREEN') throw new Error('FLASH → GREEN with no clearance');
    if (prev === 'FLASH' && st === 'ALLRED') sawAllRed = true;
    if (st === 'GREEN') { entered = true; break; }
    prev = st;
  }
  assert(sawAllRed && entered, 'never served the ped call via all-red clearance');
});

scenario(20, 'Ped button pressed MID-green is served next cycle, not eaten', () => {
  const sim = fresh(7, { noTrains: true });   // peak FIXED: walk shows at green onset
  sim.run(100);
  // wait until I1 is ~5s INTO a phase-B green, then press its crossing button
  while (!(sim.locals.I1.machine.state === 'GREEN' && sim.locals.I1.machine.phase === 'B'
    && sim.locals.I1.machine.stateT > 5)) sim.step();
  sim.pressPed('I1', 'N');
  sim.step();
  assert(sim.model.ap('I1', 'N').pedButton, 'button eaten immediately without WALK');
  // it must survive until the NEXT B-green onset, where WALK serves it
  let servedAtOnset = false;
  for (let i = 0; i < 2000; i++) {
    sim.step();
    const m = sim.locals.I1.machine;
    if (m.state === 'GREEN' && m.phase === 'B' && m.stateT <= 0.2 && m.walk
      && !sim.model.ap('I1', 'N').pedButton) { servedAtOnset = true; break; }
  }
  assert(servedAtOnset, 'button never served at a green onset');
});

scenario(21, 'Gates stay down (and entry closed) until train fully clear', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(60);
  sim.forceTrain(1);
  for (let i = 0; i < 12000; i++) {
    sim.step();
    for (const name of Object.keys(CROSSINGS)) {
      const st = sim.railway.crossings[name].state;
      if (sim.trains.occupying(name))
        assert(st === 'CLOSED' || st === 'LOWERING', `${name} ${st} while train occupies crossing`);
      if (st === 'RAISING') {
        const c = CROSSINGS[name];
        for (const [key, pipe] of Object.entries(sim.model.pipes))
          if (key.startsWith(c.link + ':'))
            assert(!pipe.entryOpen, 'road entry open during RAISING');
      }
    }
  }
});

scenario(22, 'Jam gate with NO train: clear releases the intersection hold', () => {
  const sim = fresh(10, { noTrains: true });
  sim.run(30);
  sim.jamGate('A');
  sim.run(60);
  assert(sim.locals.I5.overlay.rail !== null, 'fault did not hold I5');
  assert(sim.railway.crossings.A.state === 'CLOSED', 'fault did not physically close gates');
  sim.clearGateFault('A');
  sim.run(60);
  assert(sim.locals.I5.overlay.rail === null, 'hold never released after fault cleared (no train ever came)');
  assert(sim.railway.crossings.A.state === 'OPEN', 'gates never reopened');
});

scenario(23, 'EV lifecycle: no double dispatch, none while central dead', () => {
  const sim = fresh(10, { noTrains: true });
  sim.run(30);
  const first = sim.dispatchEV(['I1', 'I2', 'I4']);
  assert(first, 'first dispatch refused');
  assert(sim.dispatchEV(['I3', 'I5', 'I6', 'I4']) === null, 'second EV accepted while first active');
  assert(sim.incidents.ev.route[0] === 'I1', 'first EV overwritten');
  // central dies mid-run: watchdog must still release every preempt
  sim.run(20);
  sim.killCentral();
  sim.run(400);
  for (const n of ['I1', 'I2', 'I4'])
    assert(sim.locals[n].overlay.ev === null, `${n} stuck in EV preempt after central died`);
  assert(sim.dispatchEV(['I1', 'I2', 'I4']) === null, 'dispatch accepted while central offline');
});

scenario(24, 'Platoon inside link when gates close waits at the gate', () => {
  const sim = fresh(10, { noTrains: true });
  sim.run(30);
  const pipe = sim.model.pipes['I3-I5:I3'];   // crossing A sits at 74% of this trip
  const t0 = sim.t, travel = 430 / (40 / 3.6);
  const marked = { enterT: t0, arriveAt: t0 + travel, n: 5 };  // just entered: has NOT crossed yet
  pipe.entries.push(marked);
  sim.model.setGate('A', true, sim.t);
  sim.run(travel + 20);                        // well past its nominal arrival
  assert(pipe.entries.includes(marked) && marked.held, 'platoon crossed a closed gate');
  sim.model.setGate('A', false, sim.t);
  sim.run(travel);
  assert(!pipe.entries.includes(marked), 'held platoon never delivered after reopen');
});

scenario(25, 'Crossing C: I1 train preemption, safe greens, no vehicles on tracks', () => {
  const sim = fresh(7, { noTrains: true });
  sim.run(120);
  sim.forceTrain(1);
  let preempted = false, flushed = false, held = false, gatesClosed = false;
  for (let i = 0; i < 12000; i++) {
    sim.step();
    const rail = sim.locals.I1.overlay.rail;
    const machine = sim.locals.I1.machine;
    if (rail?.crossing === 'C') {
      preempted = true;
      if (rail.stage === 'FLUSH') flushed = true;
      if (rail.stage === 'HOLD') held = true;
    }
    if (sim.trains.occupying('C'))
      assert(!(machine.state === 'GREEN' && machine.phase === 'A'),
        'I1 toward-track phase green while train occupies C');
    if (sim.railway.crossings.C.state === 'CLOSED') gatesClosed = true;
  }
  assert(preempted && flushed && held, 'I1 did not complete C FLUSH → HOLD preemption');
  assert(gatesClosed, 'C gates never closed');
  assert(sim.bus.log.some((m) => m.type === MSG.TRAIN_APPROACHING
    && m.to === 'I1' && m.data.crossing === 'C'), 'no C approach message to I1');
  assert(sim.model.safetyViolations.every((v) => v.crossing !== 'C'),
    'vehicle queue occupied crossing C under train');
  assert(sim.conflictViolations === 0, 'conflicting green during C preemption');
  assert(sim.locals.I1.overlay.rail === null, 'I1 C preemption never recovered');
  assert(sim.railway.crossings.C.state === 'OPEN', 'C gates never reopened');
});

scenario(26, 'Jam gate C: C signal red, I1 holds, train stops and fault recovers', () => {
  const sim = fresh(7, { noTrains: true });
  sim.trains.signalRed = true;
  assert(Object.values(sim.trains.redCrossings).every(Boolean),
    'legacy signalRed setter did not set every crossing');
  sim.trains.signalRed = false;
  assert(Object.values(sim.trains.redCrossings).every((red) => !red),
    'legacy signalRed setter did not clear every crossing');
  sim.run(60);
  sim.jamGate('C');
  assert(sim.trains.redCrossings.C && sim.trains.signalRed, 'C train signal not red');
  sim.run(10);
  assert(sim.central.alarms.some((a) => a.kind === 'GATE_FAULT'), 'no C gate-fault alarm');
  sim.forceTrain(1);
  let minDistance = Infinity;
  for (let i = 0; i < 6000; i++) {
    sim.step();
    for (const tr of sim.trains.trains)
      minDistance = Math.min(minDistance, RAIL.s('C') - tr.s);
  }
  assert(minDistance > 0, `train entered jammed C crossing (${minDistance.toFixed(1)} m)`);
  const m = sim.locals.I1.machine;
  assert(sim.locals.I1.overlay.rail?.crossing === 'C', 'I1 not holding for C fault');
  assert(!(m.state === 'GREEN' && m.phase === 'A'), 'toward-track phase green during C fault');
  assert(sim.model.safetyViolations.every((v) => v.crossing !== 'C'),
    'vehicle queue occupied faulted crossing C');
  assert(sim.conflictViolations === 0, 'conflicting green during C fault');
  sim.clearGateFault('C');
  sim.run(600);
  assert(!sim.trains.redCrossings.C && !sim.trains.signalRed, 'C signal stayed red after repair');
  assert(sim.locals.I1.overlay.rail === null, 'I1 hold never released after C repair');
  assert(sim.railway.crossings.C.state === 'OPEN', 'C gates never reopened after repair');
});

scenario(27, 'Peak congestion flexes own split and restores an external approach', () => {
  const previousMultiplier = CONFIG.demandMultiplier;
  CONFIG.demandMultiplier = 1.5;
  try {
    const sim = fresh(7);
    sim.run(1);
    const baseline = { ...sim.locals.I5.plan.params };
    let alarm = null;
    for (let i = 0; i < 6000 && !alarm; i++) {
      sim.step();
      alarm = sim.bus.log.find((m) => m.type === MSG.CONGESTION_ALARM
        && m.from === 'I5' && m.data.approach === 'E' && m.data.active);
    }
    assert(alarm, 'I5:E external congestion alarm never fired');
    sim.step(); // central consumes the alarm and the local consumes SET_PLAN
    const adjusted = [...sim.bus.log].reverse().find((m) => m.type === MSG.SET_PLAN
      && m.to === 'I5' && m.t >= alarm.t && m.data.plan === 'FIXED');
    assert(adjusted, 'congested node I5 did not receive its own SET_PLAN');
    assert(adjusted.data.params.greenA > baseline.greenA,
      `I5 phase A did not gain green (${baseline.greenA.toFixed(1)} → ${adjusted.data.params.greenA.toFixed(1)})`);
    assert(Math.abs(adjusted.data.params.cycle - baseline.cycle) < 1e-9,
      `coordinated cycle changed (${baseline.cycle} → ${adjusted.data.params.cycle})`);
    assert(!sim.central.metered.has('I5'), 'external-only I5:E response incorrectly marked I5 as metered');

    CONFIG.demandMultiplier = 0;
    for (let i = 0; i < 12000 && Object.keys(sim.central.congested).length; i++) sim.step();
    assert(Object.keys(sim.central.congested).length === 0, 'I5:E alarm never cleared');
    assert(Math.abs(sim.locals.I5.plan.params.greenA - baseline.greenA) < 1e-9
      && Math.abs(sim.locals.I5.plan.params.greenB - baseline.greenB) < 1e-9,
      'self-retimed I5 did not restore its baseline Webster split');
    assert(!sim.central.retimed.has('I5'), 'restored self-retimed node remains in bookkeeping');
    return `I5 A ${baseline.greenA.toFixed(1)}→${adjusted.data.params.greenA.toFixed(1)}→${sim.locals.I5.plan.params.greenA.toFixed(1)}s; cycle ${baseline.cycle.toFixed(1)}s`;
  } finally {
    CONFIG.demandMultiplier = previousMultiplier;
  }
});

scenario(18, 'Architecture audit: all coordination via the 9 typed messages', () => {
  const all = Object.values(MSG);
  const missing = all.filter((t) => !seenTypes.has(t));
  assert(missing.length === 0, `message types never exercised: ${missing.join(', ')}`);
  return `all ${all.length} message types exercised across scenarios`;
});

// ---------------------------------------------------------------------------
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} scenarios passed`);
process.exit(fails.length ? 1 : 0);
