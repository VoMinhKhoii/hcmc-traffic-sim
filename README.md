# HCMC Traffic Network Simulator

Design-discovery tool for the EEET2588 traffic-light + railway-crossing
project. **Not** the graded QNX deliverable — this sim exists to (a) discover
the minimal inter-controller message set, (b) derive/tune every timing number
with evidence, and (c) demo scenarios for the design report. Its actor
structure mirrors the QNX architecture 1:1: swap each actor's inbox for
`MsgSend`/`MsgReceive` and the logic ports unchanged.

Live demo: <https://hcmc-traffic-sim.vercel.app>

---

## Start here

Read in this order. Each answers a different question.

| # | Document | Answers |
|---|---|---|
| 1 | `ANALYSIS.md` | **What are we actually analysing?** Maps every part of the sim to a real-time-systems concept and to a QNX construct. Read this before touching anything else. |
| 2 | `docs/diagrams.html` | **How does it work?** Six figures: three state machines, two message-sequence charts, the process topology and the nine-message table. Each opens in plain English before the technical detail. Open it in a browser. |
| 3 | `TIMINGS.md` | **Why is every number what it is?** Every constant in `config.js` traces to a derivation here, several backed by measured sweeps. |
| 4 | `docs/gate-fault-spec.md` | **What do we build in QNX?** The decision record for the boom-gate design, including every metric and the stated simplifications. |
| 5 | `ASSUMPTIONS.md` | **Where is the model wrong?** Every simplification we chose, marked for whether it carries into the QNX port or exists only here. Markers reward a declared simplification and punish an undeclared one. |
| 6 | `src/messages.js` | **The message table.** Nine types. This is the contract the QNX port implements. |

The three tables the report needs — messages, timings, failures — come from
documents 6, 3 and 4 respectively.

---

## Run it

```
./run.command          # macOS: double-click, or run in a terminal
# or: python3 -m http.server 8000   → open http://localhost:8000
```

A plain double-click on `index.html` won't work — browsers block ES modules on
`file://`.

**If your edits don't show up:** `python3 -m http.server` sends no cache
headers, so the browser will happily keep serving old ES modules. Hard-reload,
or serve from a different port.

## Verify it

```
node verify.js         # all 33 scenarios + conservation check
node verify.js 8 11    # just scenarios 8 and 11
```

Every scenario asserts behaviour, not output text. If one fails, it found a real
regression.

## Layout

```
src/config.js      every tunable number (derivations in TIMINGS.md)
src/network.js     map data: intersections, links, crossings, approaches
src/clock.js       sim time, time-of-day → PEAK/OFFPEAK/NIGHT
src/physics/       queues (macroscopic model), trains, incidents (accident/EV)
src/messages.js    THE message table (9 types) + bus with link-failure model
src/actors/local/  controller, phases (signal state machine), plans
                   (fixed/actuated/flash), preemption (rail > EV > plan)
src/actors/        central.js (control room), railway.js (gates/signal)
src/ui/            render (canvas), controls (operator console), eventlog,
                   panel (per-intersection local controller)
src/main.js        wiring + headless-capable Simulation class
verify.js          the verification matrix
docs/              diagrams + the gate-fault decision record
```

## Reading the screen

- **One dot = one vehicle**, both moving and waiting. A queue is drawn as
  individual dots stacked back from the stop line.
- **Message causality pane** (right): every message shows the measurement that
  triggered it and the change it caused, with a correlation tag linking an alarm
  to the plan changes it produced.
- **Click any intersection** to open its local controller: its plan, who
  commanded it, what triggered that command, and any active overlay.

## Demo script (15-minute presentation order)

1. Peak 07:00 at 30×: green waves along Nguyễn Văn Trỗi → Trần Huy Liệu
   (I3→I5→I6→I4), WALK each cycle, trains every 2 min with full preemption
   at I5 (crossing A), I1 (crossing C), and I2 (crossing B).
2. `EV I1→I2→I4`: watch the green wave roll ahead of the ambulance.
3. `Accident I2→I4`: queues build → `CONGESTION_ALARM` → central re-times the
   congested intersection and meters upstream → recovery. Point at the message
   pane while it happens; the green-time delta is on the same line as the alarm.
4. Push **Demand** to ×1.5 at peak and watch a split flex 15 s → 18 s and back.
5. Jump to 11:00: actuated mode (gap-out, skipped phases, button-only WALK).
6. Jump to 23:30: flashing yellow/red; force a train → I5 exits flash into
   preemption and returns.
7. `Kill central`: locals keep running, messages buffer; restore → resync.
8. `Jam gate A/B/C`: injects an ARM FAILED condition. On the next down command,
   ten seconds without proof of closure declares the crossing BROKEN — the road
   closes in both directions until repair, the train signal goes red, and the
   train brakes to a stand at its protecting signal.
