# TIMINGS.md — where every number comes from

Every constant in `src/config.js` traces to a line here. Cite these in the
initial design report ("assumptions used for timing, coordination, and
congestion control" — the brief asks for exactly this).

## 1. Saturation flow — `satFlowPerLane = 0.6 veh/s`

Standard stop-line discharge headway for passenger cars is ~2 s/veh/lane
(0.5 veh/s, ≈1800 veh/h/lane, HCM 2010). HCMC traffic is motorbike-dominated,
which discharges measurably faster; we use 0.6 veh/s/lane (+20%), a documented
motorbike adjustment. All roads have 2 lanes/direction → 1.2 veh/s per approach.

## 2. Yellow — `yellow = 3 s` (ITE kinematic formula)

y = t_r + v / (2a) = 1.0 s + 11.1 / (2 × 3.0) ≈ 2.9 → **3 s**
(reaction 1 s, approach speed 40 km/h = 11.1 m/s, comfortable deceleration
3 m/s²). Under Vietnamese law yellow means stop, so the queue model stops
discharge at yellow onset.

## 3. All-red — `allRed = 2 s`

Clearance = (intersection width + vehicle length) / speed
= (20 m + 5 m) / 11.1 m/s ≈ 2.2 → **2 s**.

## 4. Lost time — `L = 10 s`

Two phase changes per cycle × (3 s yellow + 2 s all-red) = 10 s. This is the
L inside Webster; deleting "real" yellow would silently delete this term.

## 5. Webster cycle & splits (peak fixed plans)

C₀ = (1.5·L + 5) / (1 − Σyᵢ), yᵢ = λ_crit,i / (s·lanes)

Peak demand assumption: main roads (R1 Nguyễn Văn Trỗi, R2 Trần Huy Liệu)
λ = 0.25 veh/s (≈900 veh/h/direction), side roads (R3/R4/R5) λ = 0.10 →
y_main = 0.208, y_side = 0.083. Worst intersection (I5, main×main):
Σy = 0.417 → C₀ = 20 / 0.583 ≈ 34 s → clamped to `cycleMin = 40 s`.

**Network cycle**: all coordinated intersections run the LONGEST individual
Webster cycle (here 40 s) so offsets align — standard coordination practice.

**Preemption-aware calibration**: at 2-minute peak train headways, I1/I2/I5 lose
a large share of green to rail preemption. λ_main = 0.25 is chosen so the
corridor stays stable *including* that loss (verified: zero track-spillback
and bounded queues over a full simulated day, scenario 4). At λ = 0.35 the
network is provably oversaturated — a good "what if demand grows" discussion
point for the report.

Capacity check (I5): green_main 15 s × 1.2 veh/s = 18 veh/cycle vs demand
0.25 × 40 = 10 veh/cycle ✓ (margin absorbs preemption).

## 6. Green-wave offsets — `offset = distance / speed`

40 km/h = 11.1 m/s. Corridor chain I3 → I5 → I6 → I4 (R1 then R2), plus I1 → I2.
| hop | distance | offset (cumulative) |
|---|---|---|
| I3 → I5 (R1) | 430 m | 38.7 s |
| I5 → I6 (R2) | 300 m | 65.7 s |
| I6 → I4 (R2) | 330 m | 95.4 s |
| I1 → I2 (R5) | 120 m | 10.8 s |

Verified in scenario 1: measured offset I3→I5 = 38.7 s, shared network cycle.

## 7. Actuated parameters (off-peak)

min green 7 s (driver expectation + one queued platoon), extension 2 s per
detection, gap-out 3 s (passage time between advance detector and stop line
at 40 km/h ≈ 40 m spacing), max green 40 s (bounds cross-street wait).
Standard NEMA-style vehicle actuation.

## 8. Pedestrian minimum — `walkMin = 12 s`

Crossing a 2×2-lane road ≈ 14 m at 1.2 m/s (design walking speed)
≈ 11.7 → **12 s**. Any green carrying a WALK must be ≥ 12 s; Webster splits
are floored accordingly.

## 9. Railway crossings and preemption timeline

A and B retain their surveyed/modelled **110 m** stop-line pockets. Crossing C
is not placed from an estimate: its canvas position is the analytic
intersection of segment I1–I6 with the infinite line through crossings A and B.
Using 2-D cross products gives the I1–I6 segment fraction
`0.4203083428493677`, hence canvas **(458.7081314233, 433.6246674279)** and
the physical I1 pocket length `450 m × fraction` = **189.1387542822 m**.
Projection onto the A→B rail axis puts C at fraction `0.6476018780256445`
of the modelled 700 m A–B interval, or rail coordinate
**s = 1053.321314618 m** after the 600 m north margin.

Pocket storage thresholds are therefore per-crossing network data
(`CROSSINGS[name].pocketLength`), not one global 110 m constant. At 7 m/veh
and two lanes the nominal pockets are about **31 vehicles** at A/B and
**54 vehicles** at C. The safety invariant compares each live pocket queue
with its own length.

Warning time is 30 s. Reserving 8 s for gate movement and 2 s contingency
leaves `30 − 8 − 2` = **20 s** for `pocketFlush`. At the 1.2 veh/s
two-lane saturation rate that can discharge up to 24 vehicles; the overlay
also advances to HOLD as soon as the sensed pocket phase is empty. This common
20 s is governed by the train warning window rather than pocket length, and
fits A, B, and C inside the same pre-arrival safety timeline. Scenarios
4/8/9/25 verify zero track-spillback under trains, including C.

Train headways per the brief: 2 min peak, ~20 min night (~22:00+).
Simplification (stated): night trains are modeled every night; the brief's
"Friday/Saturday only" detail is a display/report note, not control logic.

## 10. Congestion alarm — threshold 25 veh, persist 20 s, clear at 15

25 veh ≈ 87 m of queue ≈ the shortest link's third; persisting 20 s
(≈ half a cycle) filters normal cyclic queueing. Hysteresis (clear at 15)
prevents alarm flapping.

An active alarm transfers `congestionGreenShift = 8 s` from the other phase
to the alarmed approach's phase at that same intersection. Eight seconds adds
up to 9.6 veh of discharge at the 1.2 veh/s two-lane saturation flow: large
enough to drain a detected queue, but small relative to a coordinated cycle.
The transfer is capped so the losing phase never falls below
`max(minGreen, walkMin) = 12 s`; pedestrians therefore retain a complete
crossing interval. An internal approach also retains the upstream metering
response: its feeder phase is held at that same safe floor and the remaining
effective green goes to the other phase. External approaches have no upstream
node, but now still receive the self-retime.

At peak, both actions flex **splits only**. The Webster network cycle and the
corridor offset stay unchanged. This is the coordinated-adaptive pattern used
by SCATS/SCOOT-style operation: changing one intersection's cycle would make
its offset drift against the shared green wave. When all active alarms clear,
normal Webster splits are broadcast back to every self-retimed or metered
node. Scenarios 13 and 27 verify the response and the external-only restore.

## 11. EV preemption — `evHoldLead = 12 s`

Hold-green must begin ≥ yellow + all-red (5 s) before the EV's ETA plus a
margin for a queue in front of the EV: 12 s. ETAs from map distances at
50 km/h (traffic parts for sirens). Verified in scenario 11 (green at every
ETA along I1→I2→I4).

## 12. Speeds & distances

**Stated model simplification** (from adversarial review): links have no
physical storage cap, so queues can exceed what the pavement would hold and
congestion does not spill back to block upstream discharge. Acceptable for
signal-timing design (the congestion alarm fires long before those regimes);
call it out in the report's assumptions.

Link speed 40 km/h (urban arterial), train 60 km/h, EV 50 km/h. Topology and
distances follow the team's hand-drawn map (approximate, tunable in
`network.js`): I3–I5 430 (Ng.Văn Trỗi), I3–I1 350, I1–I6 450 (Ng.Trọng
Tuyển), I5–I6 300 + I6–I4 330 (Trần Huy Liệu), I1–I2 120, I2–I4 520
(diagonal); crossings A/B are 110 m from I5/I2, while C is the derived
189.138754 m from I1 on I1–I6 described in §9.
