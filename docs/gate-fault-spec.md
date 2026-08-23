# Boom gate fault — consolidated spec

Design decision record for the QNX implementation. The simulator is scaffolding;
this document is what gets ported. Written 2026-08-18, superseding the four-state
gate model in Figure 2 of `docs/diagrams.html`.

---

## 1. Gate state machine — three states

A state must fully determine the system's outputs. Split a state only when the
outputs differ. By that test:

| State | Road | Train signal | Alarm | Leaves this state when |
|---|---|---|---|---|
| `OPEN` | passable | clear | none | a train is warned |
| `CLOSED` | blocked | clear — train proceeds | none | the train has cleared |
| `BROKEN` | blocked, and stays blocked | **danger — trains held** | raised to control room | a human repairs it |

Three distinct output rows, so three states and no more. Barrier travel time is
**not** a state. `barrierTravel` (8 s) models the *actuator* — how long the simulated
hardware takes before it reports "proved down" — and sets the length of the
on-screen animation. The control logic never branches on it: the only thing that
decides anything is whether proof arrives before `gateProveTimeout`. In the QNX
port `barrierTravel` disappears entirely, because the proof comes from a real sensor.

---

## 2. What "broken" means, and how it is detected

You cannot predict a fault and you cannot detect one in the abstract. You detect
the **absence of an expected confirmation**:

> The controller commands the barrier down. The barrier is expected to report
> "proved down" within `gateProveTimeout`. If that report does not arrive, the
> gate is `BROKEN`.

This is the only modelled fault: **failure to prove closed**. Consequences:

- `BROKEN` means *the crossing is not protected*. That is why trains must be held
  — not out of caution, but because the road is genuinely open to the tracks.
- No continuous health monitoring is needed. The one moment the barrier's health
  matters is the moment it is asked to close, and that is when it is checked.
- A barrier that fails *stuck down* is the safe failure (road blocked, crossing
  protected, trains unaffected). It is **out of scope** — see §6.

### Detection timing

| Event | Time | Train distance |
|---|---|---|
| Barrier commanded down | T − 30 s | 500.0 m |
| Proof due | T − 20 s | 333.3 m |
| Fault declared, train braking begins | T − 20 s | 333.3 m |

The train stops at the protecting signal, 80 m short of the crossing, so it has
253.3 m to run, not 333.3 m. Deceleration required: **0.548 m/s²**. Normal
service braking is roughly 0.5–1.0 m/s², so the train stops comfortably without
resorting to emergency braking. The fault is always caught with enough room.

---

## 3. Road response

On entering `BROKEN`, the crossing's link is closed **in both directions and to
every movement that feeds it**, and it stays closed until repair.

Worked example, crossing A on Nguyễn Văn Trỗi (link I3–I5):

- No new vehicle may enter link I3–I5 from either end.
- I3 holds phase A (east/west) — that is the phase whose through movement
  discharges eastward into the link.
- I5 holds phase A for the same reason in the opposite direction.
- Phase B (north/south) keeps cycling normally at both. Cross traffic is not
  punished for a fault on the rail corridor.

**Holding the whole phase costs nothing here, and that is not a coincidence.**
On a four-way two-phase intersection, the approach that *feeds* a link and the
approach that is *fed by* it sit opposite each other, so they are always in the
same phase. At I3, phase A is {W feeds the blocked link, E is fed by it}; with
the link closed, E has no arrivals at all. So the only movement with traffic to
lose is the one that had to be held anyway. No per-approach red signal is needed,
which keeps the QNX implementation to a phase-level hold.

Measured with repair pinned off: phase-A green share falls to **0.0%** at both
I3 and I5, both link directions close, and the feeding queues grow unbounded
(90+ vehicles after 400 s) exactly as the no-spillback assumption predicts.

**This needs no new mechanism.** It is the existing rail `HOLD` overlay, simply
never released until the fault clears. That is the whole implementation.

Vehicles already inside the link when the fault is declared are **out of scope**;
they are assumed to clear on their own.

---

## 4. Train response

The 500 m figure is not a cliff. Deceleration needed to stop is v² / 2d, so the
correct model is three zones, not two:

| Zone | Distance to the protecting signal | Required braking | Outcome |
|---|---|---|---|
| 1 | > 496 m (576 m to the crossing) | ≤ 0.28 m/s² | stops comfortably on service brake |
| 2 | 139 – 496 m (219–576 m to the crossing) | 0.28 – 1.0 m/s² | stops, firmer braking |
| 3 | < 139 m (219 m to the crossing) | > 1.0 m/s² | **cannot stop** — train will occupy the crossing |

Zone 3 is 8.3 seconds of running time.

**Zone 3 cannot occur under this fault model.** The fault is declared at 333 m
(zone 2), so a train warned normally always has room to stop. Zone 3 would only
arise from a *different* fault — a barrier that proved closed and then lost proof,
e.g. struck by a vehicle — which is deliberately not modelled.

No train may enter a crossing in `BROKEN`. Trains queue behind the protecting
signal until repair.

---

## 5. Repair

Repair is a human action with no fixed duration. Modelled as a random interval:

| Parameter | Demo default | Realistic |
|---|---|---|
| `gateRepairMin` | 300 s | 1800 s |
| `gateRepairMax` | 900 s | 5400 s |

**Why the demo default is shorter.** A held main-road approach fills at the peak
arrival rate of 0.25 veh/s. Over a realistic 1-hour repair that is **900 vehicles
queued on one approach**, which is both unwatchable and physically meaningless in
a model with no spillback. The 5–15 minute demo range keeps queues in the low
hundreds while still clearly showing the failure.

---

## 6. Stated simplifications

Say these out loud in the report; naming them is what separates a model from a toy.

- **Only one gate fault is modelled: failure to prove closed.** A barrier stuck
  down is the safe failure and is excluded.
- **No spillback.** A blocked link has no storage limit, so a held queue grows as
  a number without physically jamming the intersection behind it.
- **Vehicles trapped inside a blocked link are assumed to clear themselves.**
- **Braking is modelled as constant deceleration**, ignoring brake build-up delay
  and driver/ATP reaction time.

---

## 7. Every metric

### Train

| Quantity | Value | Source |
|---|---|---|
| Speed | 60 km/h = 16.667 m/s | `trainSpeedKmh` |
| Length | 120 m | `TRAIN_LEN` |
| Warning lead | 30 s | `trainWarning` |
| Warning distance | 500.0 m | 30 × 16.667 |
| Clear condition | rear past crossing + 80 m | 200 m of travel past the crossing |
| Service braking | 0.28 m/s² → stops in 496 m | v² / 2d |
| Emergency braking | 1.0 m/s² → stops in 139 m | v² / 2a |
| Peak headway | 120 s | `headway.PEAK` |
| Off-peak / night headway | 600 s / 1200 s | `headway` |

### Gate

| Quantity | Value | Source |
|---|---|---|
| Barrier travel | 8 s | `barrierTravel` — simulated actuator + animation; no control decision reads it |
| Proof timeout | 10 s | `barrierTravel` + 2 s margin; asserted > `barrierTravel` at startup |
| Fault declared at | T − 20 s / 333.3 m | 30 s lead − 10 s timeout |
| Deceleration then required | 0.548 m/s² | v² / 2d over 253.3 m to the protecting signal |
| Repair time | 300–900 s demo, 1800–5400 s realistic | proposed |

### Crossing geometry

| Crossing | Street / link | Link length | Pocket | Protecting intersection |
|---|---|---|---|---|
| A | Nguyễn Văn Trỗi, I3–I5 | 430 m | 110 m | I5 (W approach) |
| B | diagonal to Duy Tân, I2–I4 | 520 m | 110 m | I2 (S approach) |
| C | Nguyễn Trọng Tuyển, I1–I6 | 450 m | 189.14 m | I1 (E approach) |

Pocket capacity = pocket length ÷ 7 m × 2 lanes → A and B hold 31 vehicles,
C holds 54.

The flush does **not** need to empty the pocket — it only needs the queue shorter
than the pocket, so it only has to shift the overflow standing on the tracks.

Worst-case budget, from the warning at T−30 s:

| Window | Duration | Inflow | Outflow | Net queue change |
|---|---|---|---|---|
| Clearance before the flush green (yellow + all-red) | 5 s | 1.2 veh/s | 0 | **+6** |
| Flush green, barrier still travelling | 3 s | 1.2 veh/s | 1.2 veh/s | 0 |
| Flush green, barrier down so inflow stopped | 17 s | 0 | 1.2 veh/s | **−20.4** |

Net reduction **14.4 vehicles**, so the flush rescues any starting queue up to
pocket capacity + 14.4: **45 vehicles at A and B, 68 at C**. This is a
conservative floor: the model actually stops new entries to the link at the down
command (T−30 s) rather than when the barrier proves down, so real inflow during
the flush is lower than the table assumes. Worst observed queue
on a pocket approach is 17 (I5:W at demand ×1.5), and the congestion alarm fires
at 25, so there are two margins before this ever binds.

### Road

| Quantity | Value | Source |
|---|---|---|
| Saturation flow | 0.6 veh/s/lane, 2 lanes | `satFlowPerLane`, `lanes` |
| Vehicle length | 7 m | `vehicleLength` |
| Free-flow speed | 40 km/h | `speedKmh` |
| Peak demand | 0.25 veh/s main, 0.10 side | `demand.PEAK` |
| Off-peak demand | 0.15 / 0.06 veh/s | `demand.OFFPEAK` |
| Night demand | 0.04 / 0.012 veh/s | `demand.NIGHT` |
| Yellow / all-red | 3 s / 2 s | `yellow`, `allRed` |
| Pocket flush | 20 s | `pocketFlush` |

---

## 8. Code changes this implies

1. Gate state machine drops `LOWERING` and `RAISING`; barrier animation moves into
   the renderer.
2. Fault becomes "commanded closed, no proof within `gateProveTimeout`", replacing
   the current jam-forces-barrier-closed behaviour.
3. `BROKEN` holds the rail overlay indefinitely instead of releasing on `GATES_UP`.
4. Trains decelerate from the point the fault is declared rather than halting
   instantly 80 m short.
5. New constants: `gateProveTimeout`, `gateRepairMin`, `gateRepairMax`.
6. Figure 2 in `docs/diagrams.html` redrawn as the three-state machine.
