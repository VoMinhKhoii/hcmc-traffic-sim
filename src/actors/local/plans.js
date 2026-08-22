// @ts-check
// actors/local/plans.js — the three light-sequence patterns a local can run,
// selected by SET_PLAN from central (matches the brief's pattern list):
//   FIXED    — Webster cycle + splits + corridor offset (peak, coordinated)
//   ACTUATED — min green / extend / gap-out / max green / skip-empty (off-peak)
//   FLASH    — night: main flashes yellow, side flashes red; ped button
//              summons one full signal cycle, then back to flash
// A plan only ever asks the SignalMachine to change phase; it never touches
// light state directly.

import { CONFIG, speedMs } from '../../config.js';
import { PHASES, APPROACHES, DIRS, MAIN_PHASE, linkById, approachClass } from '../../network.js';

// ---------- FIXED (Webster) ------------------------------------------------

/**
 * Build a Webster fixed plan for one intersection.
 * Flow ratio per phase y = λ_crit / (s·lanes); C = (1.5L+5)/(1−Σy), L = 10 s
 * (two phase changes × (3 s yellow + 2 s all-red)). Splits ∝ y, offset =
 * upstream travel time along the coordinated corridor.
 * Coordinated plans pass `cycleOverride` = the NETWORK cycle (max of all
 * intersections' Webster cycles) so every intersection shares one cycle and
 * the offsets produce real green waves.
 * @param {string} node @param {'PEAK'|'OFFPEAK'|'NIGHT'} mode
 */
export function websterPlan(node, mode, offset = 0, cycleOverride = null) {
  const s = CONFIG.satFlowPerApproach;
  const y = { A: 0, B: 0 };
  for (const ph of /** @type {const} */ (['A', 'B'])) {
    for (const d of PHASES[ph]) {
      const lam = CONFIG.demand[mode][approachClass(node, d)];
      y[ph] = Math.max(y[ph], lam / s);
    }
  }
  const L = 2 * (CONFIG.yellow + CONFIG.allRed);
  const denom = Math.max(0.15, 1 - y.A - y.B);
  const C = cycleOverride ??
    Math.min(CONFIG.cycleMax, Math.max(CONFIG.cycleMin, (1.5 * L + 5) / denom));
  const effective = C - L;
  let greenA = Math.max(CONFIG.walkMin, effective * (y.A / (y.A + y.B)));
  let greenB = Math.max(CONFIG.walkMin, effective - greenA);
  greenA = effective - greenB;
  return { cycle: C, greenA, greenB, offset };
}

// Corridor offsets for the green waves:
//   R1→R2 chain: I3 → I5 → I6 → I4 (Ng.Văn Trỗi then down Trần Huy Liệu)
//   R5 hop:      I1 → I2
export function corridorOffsets() {
  const tt = (id) => linkById(id).len / speedMs(CONFIG.speedKmh);
  const i5 = tt('I3-I5'), i6 = i5 + tt('I5-I6');
  return { I3: 0, I5: i5, I6: i6, I4: i6 + tt('I6-I4'), I1: 0, I2: tt('I1-I2') };
}

/**
 * Fixed plan step: where in the cycle should we be? Request that phase.
 * Cycle layout: [greenA | Y+AR | greenB | Y+AR], anchored to sim time − offset.
 * Phase B is requested AT pos = greenA so the machine's own yellow+all-red
 * lands inside the clearance window (not appended after it).
 */
export function fixedStep(machine, params, t) {
  const L2 = CONFIG.yellow + CONFIG.allRed;
  const pos = mod(t - params.offset, params.cycle);
  const want = (pos < params.greenA || pos >= params.greenA + L2 + params.greenB) ? 'A' : 'B';
  machine.requestPhase(want);
}

// ---------- ACTUATED -------------------------------------------------------

/**
 * Actuated step. `sensors` is the local sensor view {dir:{q,detection,pedButton}}.
 * Rests on the current green when the other phase has no demand (skip-empty).
 */
export function actuatedStep(machine, sensors, boost = 1) {
  if (machine.state !== 'GREEN') return;
  const cur = machine.phase, other = cur === 'A' ? 'B' : 'A';
  const demand = (ph) => PHASES[ph].some((d) => sensors[d].q >= 1 || sensors[d].detection || sensors[d].pedButton);
  if (!demand(other)) return;                                   // rest / skip empty phase
  const gapped = !PHASES[cur].some((d) => sensors[d].detection);
  const tG = machine.stateT;
  const minG = Math.max(CONFIG.minGreen, machine.walk ? CONFIG.walkMin : 0) * boost;
  if ((tG >= minG && gapped) || tG >= CONFIG.maxGreen * boost) machine.requestPhase(other);
}

// ---------- FLASH (night) --------------------------------------------------

/**
 * Flash step. Normally holds FLASH. A pedestrian button summons one full
 * cycle: exit flash into the phase WHOSE GREEN CARRIES THE REQUESTED WALK,
 * hold it for the walk minimum, then serve the other phase briefly, then
 * back to flash. State kept in `mem` (per-controller scratch).
 */
export function flashStep(machine, sensors, mem) {
  if (machine.state === 'FLASH') {
    const req = DIRS.find((d) => sensors[d].pedButton);
    if (req) {
      const ph = PHASES.A.includes(req) ? 'A' : 'B';
      machine.exitFlash(ph);
      mem.flashCycle = { served: ph, stage: 0 };
    }
    return;
  }
  if (machine.state !== 'GREEN') return;          // let clearance intervals finish
  const fc = mem.flashCycle;
  if (!fc) { machine.enterFlash(); return; }      // e.g. back from preemption → re-enter flash
  if (fc.stage === 0 && machine.stateT >= CONFIG.walkMin + 2) {
    fc.stage = 1;
    machine.requestPhase(machine.phase === 'A' ? 'B' : 'A');
  } else if (fc.stage === 1 && machine.phase !== fc.served && machine.stateT >= CONFIG.minGreen) {
    mem.flashCycle = null;
    machine.enterFlash();
  }
}

export function mainPhaseOf(node) { return MAIN_PHASE[node]; }
function mod(x, m) { return ((x % m) + m) % m; }
