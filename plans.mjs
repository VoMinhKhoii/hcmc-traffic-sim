// Print the peak plan every intersection actually receives, and show how it is derived.
// Nothing here is hand-written: the numbers come from the running simulation.
//   node plans.mjs
import { CONFIG } from './src/config.js';
import { Simulation } from './src/main.js';

const sim = new Simulation();
sim.clock.startHour = 8;          // 08:00 → PEAK
sim.run(400);                     // let central publish and locals adopt

const L = 2 * (CONFIG.yellow + CONFIG.allRed);

console.log(`\nPEAK plans at 08:00 — cycle ${CONFIG.cycleMin}s, lost time ${L}s, so ${CONFIG.cycleMin - L}s of green to share\n`);
console.log('node    cycle  green A  green B   offset   A+B   main road  check');
console.log('─'.repeat(74));

for (const id of Object.keys(sim.locals)) {
  const p = sim.locals[id].plan?.params;
  if (!p) continue;
  const sum = p.greenA + p.greenB;
  const main = p.greenA > p.greenB ? 'A' : p.greenB > p.greenA ? 'B' : '—';
  const ok = Math.abs(sum + L - p.cycle) < 1e-9 ? 'A+B+10=40 ✓' : 'MISMATCH';
  console.log(
    `${id.padEnd(6)} ${p.cycle.toFixed(1).padStart(5)}  ${p.greenA.toFixed(1).padStart(6)}  ` +
    `${p.greenB.toFixed(1).padStart(6)}  ${(p.offset ?? 0).toFixed(1).padStart(7)}  ` +
    `${sum.toFixed(1).padStart(4)}   ${main.padStart(6)}     ${ok}`
  );
}

console.log(`\nwalkMin floor = ${CONFIG.walkMin}s — a phase can never drop below it,`);
console.log(`so the widest possible peak split is ${CONFIG.cycleMin - L - CONFIG.walkMin}/${CONFIG.walkMin}.\n`);

// Off-peak has no plan at all — measure what the cycle actually does.
const o = new Simulation();
o.clock.startHour = 12;
o.run(200);
const m = o.locals.I1.machine;
let last = null; const starts = [];
for (let i = 0; i < 40000; i++) {
  o.step();
  const st = `${m.state}:${m.phase}`;
  if (st === 'GREEN:A' && last !== 'GREEN:A') starts.push(o.t);
  last = st;
}
const lens = starts.slice(1).map((t, i) => t - starts[i]);
const mn = Math.min(...lens), mx = Math.max(...lens);
const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
console.log(`OFF-PEAK at I1 — no published plan; ${lens.length} measured cycles`);
console.log(`  ${lens.slice(0, 10).map((x) => x.toFixed(1)).join('  ')} ...`);
console.log(`  min ${mn.toFixed(1)}s  max ${mx.toFixed(1)}s  mean ${avg.toFixed(1)}s  fixed? ${mn === mx}\n`);

// ---- derivation: where each split comes from -------------------------------
import { INTERSECTIONS, PHASES, MAIN_PHASE, approachClass } from './src/network.js';
const s = CONFIG.satFlowPerApproach;
const eff = CONFIG.cycleMin - L;
console.log('Derivation — 30 s shared in proportion to demand, floored at walkMin\n');
console.log('node   main   y.A     y.B     raw A   raw B    after 12 s floor');
console.log('─'.repeat(70));
for (const node of Object.keys(INTERSECTIONS)) {
  const y = { A: 0, B: 0 };
  for (const ph of ['A', 'B'])
    for (const d of PHASES[ph])
      y[ph] = Math.max(y[ph], CONFIG.demand.PEAK[approachClass(node, d)] / s);
  const rawA = eff * (y.A / (y.A + y.B)), rawB = eff - rawA;
  let gA = Math.max(CONFIG.walkMin, rawA);
  let gB = Math.max(CONFIG.walkMin, eff - gA);
  gA = eff - gB;
  console.log(
    `${node.padEnd(6)} ${MAIN_PHASE[node].padStart(3)}  ${y.A.toFixed(3)}  ${y.B.toFixed(3)}   ` +
    `${rawA.toFixed(1).padStart(5)}  ${rawB.toFixed(1).padStart(5)}    ${gA.toFixed(1)} / ${gB.toFixed(1)}`
  );
}
console.log();
// ---- which approach is main / side at every node ---------------------------
import { APPROACHES, DIRS, linkById } from './src/network.js';
console.log('Approach classes — phase A = E,W   phase B = N,S\n');
console.log('node   dir  phase  road        class    λ (peak)');
console.log('─'.repeat(58));
for (const node of Object.keys(INTERSECTIONS)) {
  for (const d of ['E', 'W', 'N', 'S']) {
    const ap = APPROACHES[node][d]; if (!ap) continue;
    const ph = PHASES.A.includes(d) ? 'A' : 'B';
    const road = ap.ext ? `(external)` : linkById(ap.link).road;
    const cls = approachClass(node, d);
    console.log(`${node.padEnd(6)} ${d.padEnd(4)} ${ph.padEnd(6)} ${road.padEnd(11)} ${cls.padEnd(8)} ${CONFIG.demand.PEAK[cls]}`);
  }
  console.log('─'.repeat(58));
}
