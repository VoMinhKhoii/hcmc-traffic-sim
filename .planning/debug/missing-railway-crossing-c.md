# Missing railway crossing C

Status: resolved

## Symptoms

- Expected: every road crossed by the A–B railway has gates, train events,
  local preemption, rendering, controls, and safety checks.
- Actual: the rail axis intersects I1–I6 but only A and B existed in network
  and train state, so trains traversed a live road near canvas (459, 433).

## Root cause and evidence

The static `CROSSINGS` map and I1–I6 link metadata omitted C. In addition,
`TrainSystem` enumerated `['A', 'B']` for warning/clear events, next-crossing
selection and occupancy, initialized only A/B train signals, and `Simulation`
constructed only A/B occupancy flags. `TrafficModel` likewise initialized only
A/B pockets and compared all crossings against one global 110 m threshold.

The railway controller and renderer already iterated `CROSSINGS`, so after the
missing data was supplied they required no crossing-specific branch. Controls
still explicitly listed A/B; the local panel exposed only aggregate preemption.

## Geometry

- A canvas: (686.046511627907, 157.2093023255814)
- B canvas: (335, 584.0384615384615)
- I1–I6 intersection fraction: 0.4203083428493677
- C canvas: (458.70813142332315, 433.6246674279494)
- C distance from I1: 189.13875428221547 m
- C A→B rail fraction: 0.6476018780256445
- C rail coordinate after 600 m margin: 1053.3213146179512 m

`src/network.js` computes the fraction by a 2-D segment/line cross product;
`src/physics/trains.js` independently computes every crossing's rail coordinate
by projection onto the A–B unit axis.

## Fix

- Add C to network data and mark I1–I6; store per-crossing pocket lengths.
- Derive all train crossing coordinates/signals/events and main-loop occupancy
  from `Object.keys(CROSSINGS)`.
- Build traffic pockets generically and use each crossing's pocket length.
- Route C railway messages to I1; make controls generic and expose FLUSH/HOLD
  plus crossing name in the I1 panel.
- Extend verification with C preemption/safety and C jam/recovery scenarios.

## Verification

- `node verify.js`: 27/27 scenarios passed, including C preemption and C jam.
- `node --check`: passed for every edited JavaScript file and `src/ui/render.js`.
