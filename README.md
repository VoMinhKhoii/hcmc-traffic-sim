# HCMC Traffic Network Simulator

Design-discovery tool for the EEET2588 traffic-light + railway-crossing
project. **Not** the graded QNX deliverable — this sim exists to (a) discover
the minimal inter-controller message set, (b) derive/tune every timing number
with evidence (see `TIMINGS.md`), and (c) demo scenarios for the design
report. Its actor structure mirrors the QNX architecture 1:1: swap each
actor's inbox for MsgSend/MsgReceive and the logic ports unchanged.

## Run it

```
./run.command          # macOS: double-click, or run in a terminal
# or: python3 -m http.server 8000   → open http://localhost:8000
```

(A plain double-click on `index.html` won't work — browsers block ES modules
on `file://`.)

## Verify it

```
node verify.js         # all 18 scenarios + conservation check
node verify.js 8 11    # just scenarios 8 and 11
```

## Layout

```
src/config.js      every tunable number (derivations in TIMINGS.md)
src/network.js     map data: intersections, links, crossings, approaches
src/clock.js       sim time, time-of-day → PEAK/OFFPEAK/NIGHT
src/physics/       queues (macroscopic model), trains, incidents (accident/EV)
src/messages.js    THE message table (9 types) + bus with link-failure model
src/actors/local/  controller, phases (signal state machine), plans
                   (fixed/actuated/flash), preemption (rail > EV > plan)
src/actors/        central.js (control room), railway.js (gates/flashers/signal)
src/ui/            render (canvas), controls (operator console), eventlog
src/main.js        wiring + headless-capable Simulation class
verify.js          the 18-scenario verification matrix
```

## Demo script (15-minute presentation order)

1. Peak 07:00 at 30×: green waves along Nguyễn Văn Trỗi → Trần Huy Liệu
   (I3→I5→I6→I4), WALK each cycle, trains every 2 min with full preemption
   at I5 (crossing A) and I2 (crossing B).
2. `EV I1→I2→I4`: watch the green wave roll ahead of the ambulance.
3. `Accident I2→I4`: queues build → CONGESTION_ALARM → central meters I1 →
   recovery. Point at the message log while it happens.
4. Jump to 11:00: actuated mode (gap-out, skipped phases, button-only WALK).
5. Jump to 23:30: flashing yellow/red; force a train → I5 exits flash into
   preemption and returns.
6. `Kill central`: locals keep running, messages buffer; restore → resync.
7. `Jam gate A`: train signal RED, alarm in control room, train held.
