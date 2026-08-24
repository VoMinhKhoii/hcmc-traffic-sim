// config.js — every tunable number in ONE place.
// Each constant's derivation lives in TIMINGS.md (same key names).

export const CONFIG = {
  // simulation clock
  dt: 0.1,              // s of sim time per physics step
  timeScale: 30,        // sim seconds per wall second (slider 1–120)
  startHour: 6.0,       // sim starts 06:00

  // road physics
  satFlowPerLane: 0.6,  // veh/s/lane discharge on green (motorbike-adjusted; car-only ≈0.5)
  lanes: 2,             // per direction, all roads
  // Discharge capacity of ONE approach (both lanes). Demand λ below is quoted at
  // this same scope, so y = λ / satFlowPerApproach compares like with like.
  get satFlowPerApproach() { return this.satFlowPerLane * this.lanes; },   // 1.2 veh/s
  vehicleLength: 7,     // m of road one queued vehicle occupies
  speedKmh: 40,         // free-flow link speed
  evSpeedKmh: 50,       // priority vehicle speed (traffic parts)

  // signal timing (derived in TIMINGS.md)
  yellow: 3,            // s — ITE kinematic formula @40km/h
  allRed: 2,            // s — intersection width / speed
  minGreen: 7,          // s — actuated minimum
  maxGreen: 40,         // s — actuated cap
  gapOut: 3,            // s without detection ends actuated green
  walkMin: 12,          // s — 2x2-lane crossing / 1.2 m/s
  cycleMin: 40, cycleMax: 120,   // Webster clamp

  // congestion alarm (density threshold idea)
  congestionThreshold: 25,  // veh queued on one approach
  congestionPersist: 20,    // s above threshold before alarm
  congestionClear: 15,      // veh to clear alarm (hysteresis)
  congestionGreenShift: 8,  // s transferred to an alarmed phase; cycle stays fixed

  // railway
  trainWarning: 30,     // s before train reaches a crossing
  barrierTravel: 8,     // s the SIMULATED HARDWARE takes to answer 'proved down'
                        // (also the on-screen animation). The controller never
                        // branches on it; only gateProveTimeout decides anything.
  gateProveTimeout: 10, // s from down command to failure-to-prove fault
  gateRepairMin: 300,   // s automatic human-repair delay (demo minimum)
  gateRepairMax: 900,   // s automatic human-repair delay (demo maximum)
  trainSpeedKmh: 60,
  headway: { PEAK: 120, OFFPEAK: 600, NIGHT: 1200 }, // s between trains

  // incidents
  accidentDuration: 300,   // s default

  // demand λ (veh/s per APPROACH — both lanes, same scope as satFlowPerApproach)
  // calibrated so the network is BUSY but stable at peak even though rail
  // preemption steals green time at I1/I2/I5 every 2 minutes (see TIMINGS.md §5)
  demand: {
    PEAK:    { main: 0.25, side: 0.10 },
    OFFPEAK: { main: 0.15, side: 0.06 },
    NIGHT:   { main: 0.04, side: 0.012 },
  },
  demandMultiplier: 1.0,   // global slider

  // night flash: cautious flow through intersection, fraction of sat flow
  flashFactorMain: 0.7,    // flashing yellow — proceed with caution
  flashFactorSide: 0.3,    // flashing red — stop then go

  // preemption
  pocketFlush: 20,         // s of track-clearance green (fits inside 30 s warning)
  evHoldLead: 12,          // s before ETA the EV approach must be green
  recoveryBoost: 1.3,      // first-green multiplier repaying held queues
};

// Pedestrian-safety invariant, checked at startup: the split calculation floors each
// phase at walkMin and then rebalances the pair to fill the cycle, so a green can be
// pulled back UNDER the floor unless both phases fit at the shortest cycle we publish.
// Nothing downstream re-checks it — fixed-time is a pure clock — so it fails loudly here.
{
  const lost = 2 * (CONFIG.yellow + CONFIG.allRed);
  const effective = CONFIG.cycleMin - lost;
  if (effective < 2 * CONFIG.walkMin) {
    throw new Error(
      `config: cycleMin ${CONFIG.cycleMin}s leaves ${effective}s of green, but two phases each ` +
      `need walkMin ${CONFIG.walkMin}s to cross. Raise cycleMin to ${2 * CONFIG.walkMin + lost}s ` +
      `or lower walkMin to ${effective / 2}s.`);
  }
}

// time-of-day → mode. Peak 6:30–9:30 & 16:00–19:00, night 23:00–4:00.
export function modeAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  if ((h >= 6.5 && h < 9.5) || (h >= 16 && h < 19)) return 'PEAK';
  if (h >= 23 || h < 4) return 'NIGHT';
  return 'OFFPEAK';
}

export const speedMs = (kmh) => kmh / 3.6;
