# Figure 1 — One green: what decides its length

## Phases

- **A = East + West**
- **B = North + South**
- Never green together. Whichever is green, the other is *the crossing road*.

Pedestrians walk **parallel to the green movement**, across the road that is stopped.
Nobody ever steps in front of a green.

## Constants

| | | where it comes from |
|---|---|---|
| yellow | 3 s | ITE kinematic stopping formula at 40 km/h |
| all-red | 2 s | intersection width ÷ speed |
| peak cycle (`cycleMin`) | 40 s | = A + B + (3 + 2) × 2 → A + B = 30 s of green to share |
| **min green** | **12 s** | one floor (see below) |
| **walk min** | **12 s** | 14 m crossing ÷ 1.2 m/s walking speed |
| gap-out | 3 s | no arrival for 3 s **and** no queue |
| max green | 40 s | caps how long a *waiting* vehicle is held |

**One floor, not two.** Min green used to be 7 s, with the 12 s walk floor applied only to
greens carrying a WALK. Both are now 12 s, so the minimum no longer depends on whether a
pedestrian is present — one constant, and one less branch to carry into the QNX port. It is
free at peak: the split calculation already floors every phase at 12 s, and nothing in the
cycle, the splits, the offsets, or the congestion arithmetic moves. The only observable
change is off-peak greens rising from ~7–10 s to ~12–14 s.

## Rates

- Arrival **λ** = 0.25 veh/s main, 0.10 side (approach waiting on RED)
- Discharge **s** = 1.2 veh/s (approach on GREEN)

## Flow ratio

**y = λ / s** — the fraction of the cycle that approach needs green.
At I3 main: 0.25 / 1.2 = 0.208, roughly 21% of the time.
A phase takes the **max** of its two directions, never the sum.

## 1. Derivation

```
yA = 0.25 / 1.2 = 0.208        (E, W — main)
yB = 0.10 / 1.2 = 0.083        (N, S — side)

L  = lost time = 10 s          3 s yellow + 2 s all-red, twice: once ending A, once ending B
C  = (1.5L + 5) / (1 − Σy) = 20 / (1 − 0.291) = 28.2 s
                               → clamped up to cycleMin 40 s
effective green = C − L = 40 − 10 = 30 s

greenA = 30 × yA/Σy = 21.4 s
greenB = 30 − 21.4  =  8.6 s
8.6 < walkMin 12    → clamp greenB to 12, greenA = 30 − 12 = 18

check: 18 + 3 + 2 + 12 + 3 + 2 = 40 ✓
```

**Design rule — `C − L ≥ 2 × walkMin`.** The split calculation floors each phase at `walkMin`
and then rebalances the pair to fill the cycle, so a green can be pulled back *under* the
floor unless both phases fit at the shortest cycle published. 30 ≥ 24, so it holds. The
config refuses to start if it ever stops holding.

## 2. Congestion

An alarm fires when a queue exceeds **25 veh** (≈ 87 m, about a third of the shortest link)
and **stays there for 20 s** — half a cycle, so ordinary cyclic build-up doesn't trip it. It
clears at **15**, not 25; that hysteresis is the debounce, without which central would
re-time the network several times a second as the queue oscillated.

The response moves **`min(8, crossing green − 12)` seconds** of green from the crossing phase
to the queued one. 8 s ≈ 9.6 vehicles of discharge at the 1.2 veh/s saturation rate — enough
to drain a detected queue, small enough not to break coordination. The donor can never fall
below the 12 s floor, so **a crossing phase already at 12 s donates nothing** and the alarm
produces no split change at all.

**The cycle and the corridor offset never change.** Only splits flex. Changing one
intersection's cycle would drift its offset against the shared green wave and break the
corridor — this is the coordinated-adaptive pattern SCATS/SCOOT-style systems use.

Two further behaviours the figure does not draw:

- **Internal approaches also meter upstream.** The feeder intersection's feeding phase is
  pinned to the same 12 s floor, throttling inflow as well as draining the queue. External
  approaches have no upstream node and get the local split shift only.
- **Off-peak, an alarm ends actuation.** The re-timed plan is sent as a fixed plan built from
  a fresh Webster off-peak base, so gap-out, hold-while-detected and skip-empty stop applying
  until the alarm clears. At peak an alarm moves a split; off-peak it replaces the control
  law. Same alarm, two different consequences.

**Green moves off plan in exactly two places**, which is why the alarm appears twice in the
figure: when central re-times the plan, and when the next green reads that plan at the
red→green boundary.

## 3. The flow (left to right)

- **Cycle starts** → the alarm is checked first, because the answer changes which plan is
  published, not just how long a green runs.
- **Congestion alarm?** — *yes* re-times the split before anything else is decided; *no*
  passes straight through.
- **Peak hours?** — split by clock: peak 06:30–09:30 and 16:00–19:00, off-peak the rest.
  Night is not drawn; see the note below.
- **Peak** reads its split off the plan and hands it straight to the signal. No detector, no
  button, no loop. WALK shows every cycle without anyone asking, which is why the split must
  already be ≥ 12 s. The 40 s cycle and the 30 s of shareable green exist **only here** —
  off-peak has no cycle at all.
- **Off-peak is a loop, not a line:**
  - pedestrian waiting to cross the current road → next green ≥ 12 s
  - vehicle waiting on the crossing road → next green ≥ 12 s
  - neither → **hold green on the current road**, and ask again
- The hold returns to the congestion check, so an alarm arriving mid-hold is picked up
  without waiting for the phase to end.
- **Road signal:** GREEN → **YELLOW 3 s** → **ALL-RED 2 s** → the crossing road's green,
  carrying the congestion shift if an alarm is active on that phase.
- **Continue?** loops back to the congestion check, so both the alarm and the mode are
  re-evaluated every cycle. Only a mode change leaves the loop.

Off-peak green is **not a countdown**. Nothing decides its length in advance: it ends the
first moment the minimum has elapsed *and* its own road has gone quiet, or at the 40 s cap.
That is why no countdown display is modelled — a countdown needs the end of the green fixed
at the moment it starts, which only a fixed plan gives you.

## 4. Night flash — deliberately out of the figure

A sixth lane made the diagram too wide to read, and flash shares almost nothing with the two
cycling modes: no phases, no splits, no cycle. Full behaviour, traced from the running sim:

- Flashes indefinitely — main road YELLOW, side road RED — until 04:00.
- Pedestrian on the side road: ALL-RED 2 s → green 14 s (WALK shown for 12) → YELLOW 3 s →
  ALL-RED 2 s → other phase 12 s → back to FLASH.
- It leaves flash **via ALL-RED, never straight to green**: under flashing yellow traffic is
  still moving, so a conflicting green would be a collision.

## 5. What the model does not do

- **No turning movements.** Every vehicle goes straight through to the opposite approach.
  Right-on-red isn't disallowed; it isn't modelled. This is also what makes the concurrent
  WALK conflict-free — in a real intersection a turning vehicle drives through that
  crosswalk, which is why real designs need a leading pedestrian interval or protected turns.
- **No spillback.** A link has unlimited storage, so real oversaturation would be worse than
  shown. This is the single most significant simplification in the model.
- **Detectors are perfect.** Every adaptive decision rests on a sensor reading never allowed
  to be wrong.
