# How to read this simulator for EEET2588

This file answers one question: **the demo looks nice, but what do we actually
analyse?**

The simulator is not the assignment. The assignment is a QNX program built from
processes, message passing and synchronisation primitives. The simulator is the
**evidence generator** for the design that program implements. Everything below
turns "watching dots move" into numbers, tables and arguments you can put in a
report and defend in a demo.

---

## 1. The three artefacts you are mining for

Everything in this tool exists to produce three tables. If your report has these
three tables filled in with derived numbers and the reasoning behind them, the
design section is done.

| Artefact | What it is | Where the sim produces it |
|---|---|---|
| **Message table** | Every inter-process message: name, sender, receiver, payload, trigger, deadline | `src/messages.js` (the 9 types) + the live event log pane + verify scenario 18 |
| **Timing table** | Every constant, with a derivation, not a guess | `TIMINGS.md`, cross-checked by verify scenarios 1, 2, 5, 6, 8 |
| **Failure table** | Each fault, its detection mechanism, its fail-safe response, its recovery | `killCentral` / `jamGate` controls + verify scenarios 14–16, 22, 26, 28–32 |

The QNX code is then a transliteration: each actor becomes a process, each
message becomes a `MsgSend`/`MsgReceive` pair or a pulse, each timing constant
becomes a timer.

---

## 2. The mapping table (put this in your report)

This is the single most valuable thing the simulator gives you, because it is
what makes the QNX design decisions *justified* rather than arbitrary.

| Simulator concept | File | QNX Neutrino construct |
|---|---|---|
| `LocalController` (one per intersection) | `src/actors/local/controller.js` | One process, `ChannelCreate()`, blocking `MsgReceive()` loop |
| `CentralController` | `src/actors/central.js` | One process; locals `ConnectAttach()` to it and to each other |
| `RailwayController` | `src/actors/railway.js` | One process owning the gate hardware |
| Typed message on the bus | `src/messages.js` | `MsgSend()` (sender blocks until reply) for commands that must be acknowledged: `SET_PLAN`, `PREEMPT` |
| Fire-and-forget notification | `STATUS_UPDATE`, `CONGESTION_ALARM` | `MsgSendPulse()` — no reply, sender does not block |
| The 0.1 s physics tick | `src/clock.js` | `timer_create()` with `SIGEV_PULSE`, delivered to the same channel as messages, so one `MsgReceive()` handles both time and messages |
| Per-actor inbox | `MessageBus` queues | The kernel's message queue on a channel; QNX queues senders in priority order |
| "Only one phase may be green" | `conflictViolations` check, `src/main.js:65` | The invariant a `pthread_mutex_t` protects around the phase variable, if the controller is multi-threaded |
| Priority order train > EV > normal | `src/actors/local/preemption.js` | `SCHED_FIFO` thread priorities, or an explicit priority field compared on message arrival |
| Link failure / `killCentral` | `src/main.js:88` | `MsgSend()` returning `-1` with `errno == ENOTCONN`/`ESRCH`; reconnect with `ConnectAttach()` |
| EV watchdog auto-release | `preemption.js`, `t > eta + 90` | `timer_settime()` one-shot; the fail-safe when a `RESUME` never arrives |

**The point to make in the report:** the local controllers do not read each
other's state. They only exchange the nine messages. That is what proves the
design ports to separate address spaces — a process cannot dereference another
process's pointer, so any design that "just reads the neighbour's queue length"
does not port. Verify scenario 18 audits exactly this and is your evidence.

---

## 3. Real-time concepts, and where to see each one happen

This is the section your teammates asked for: *what am I looking at?*

### 3.1 The intersection is a critical section

Only one phase may be green. Conflicting greens are a collision. In RTS terms
the intersection is a **shared resource under mutual exclusion**, and the
signal state machine is the lock.

- **Watch:** any intersection through a phase change.
- **The important detail:** the lock is not released instantly. GREEN → YELLOW
  (3 s) → ALL-RED (2 s) → next GREEN. Those 5 seconds are the time the resource
  is held but doing no useful work.
- **Report it as:** lost time per phase change. With two phases per cycle,
  L = 2 × 5 = 10 s of every cycle is pure clearance overhead. That is the `L`
  term in Webster's formula, which is why the cycle length comes out where it
  does. Cross-reference `TIMINGS.md`.
- **Evidence:** verify scenario 5 asserts every green→red passes through
  YELLOW(3) then ALLRED(2), on every intersection, in every mode.

### 3.2 Preemption, and the cost of a non-preemptible section

A train approaching is a hard deadline: the crossing must be protected and the
track clear before it arrives. The down command immediately enters the CLOSED
control state and blocks the road; the renderer independently shows 8 s of arm
travel. You cannot cut a green to red instantly, because the clearance interval
is physically mandatory. So the preemption sequence is:

FLUSH (force green toward the track to empty the pocket) → clearance →
HOLD (toward-track approaches red) → train passes → recovery.

- **Watch:** press *Force train*, then watch the crossing's intersection.
- **The important detail:** the warning time must be ≥ flush + yellow + all-red.
  `CONFIG.trainWarning` exists precisely because the response is not
  instantaneous. This is **worst-case response time analysis** in physical form.
- **Report it as:** a timeline diagram from `TRAIN_APPROACHING` at T−30 s to
  gates-down, annotated with each component. Then state the deadline argument:
  the sum of the components must be less than the warning time, with margin.
- **Evidence:** verify scenario 8 (pocket safe, zero vehicles on tracks),
  scenario 21 (gates stay down until the train's rear is fully clear).

### 3.3 Priority inversion — the concept the marker is looking for

Priority order is train > EV > normal. But when an EV preemption is already
running and a train warning arrives, the high-priority train must wait for the
in-progress low-priority sequence to reach a safe point. **That is priority
inversion**, and it is bounded here by the clearance interval.

- **Watch:** dispatch an EV onto a route crossing the railway, then force a
  train.
- **Report it as:** "maximum blocking time = yellow + all-red = 5 s; the 30 s
  warning absorbs it." That sentence, with the number, is a real-time analysis.
  If you want to go further, note that QNX's message-driven **priority
  inheritance** (the server thread runs at the priority of its highest-priority
  blocked client) is the OS-level version of the same mechanism.
- **Evidence:** verify scenario 12.

### 3.4 Autonomy and graceful degradation

- **Watch:** press *Kill central*. Nothing freezes. Every local keeps running
  its last plan, buffers its status messages, and flushes them on reconnect.
- **Report it as:** the argument for **why the locals are separate processes and
  not threads of the central controller**. If central were the only scheduler,
  its failure would stop six intersections. This is the design justification for
  the whole distributed architecture, and it is directly worth marks.
- **Evidence:** verify scenarios 14 and 15.

### 3.5 Fail-safe design

- **Watch:** press *Jam gate* while the crossing is idle. The new **ARM FAILED**
  indication appears, but no alarm or train red is asserted yet. Force a train:
  the down command is issued, proof is absent for 10 s, and only then does the
  crossing enter BROKEN.
- **The important detail:** the failure response makes the system *less*
  useful (traffic is held, the train stops) but *never unsafe*. That is the
  definition of fail-safe, and it is the opposite of "keep running and hope".
- **Report it as:** the only modeled gate fault is **failure to prove closed**.
  Detection is absence of proved-down feedback for `gateProveTimeout = 10 s`;
  response is `GATE_FAULT` + `ALARM`, train signal red, constant-deceleration
  braking to the signal 80 m short, both road-link directions closed, and only
  each endpoint's feeding movement held red. Recovery is automatic after a
  deterministic-seeded 300–900 s human-repair delay, with manual clear as an
  operator override.
- **Evidence:** scenarios 16/22/26 replace the old stuck-down semantics;
  scenarios 28–32 separately prove the timeout boundary, continuous braking,
  two-ended holds, automatic repair, and 220 m queued-train separation.

### 3.6 Feedback control and hysteresis

The congestion alarm does not fire the instant a queue crosses 25 vehicles. It
must stay above 25 for 20 s, and it clears at 15, not 25.

- **Watch:** drop an accident on a link and watch the alarm badge.
- **Report it as:** hysteresis prevents alarm flapping around the threshold —
  the same reasoning as debouncing a sensor input. Without it, central would
  re-time the network several times a second. While active, central moves up
  to 8 s of green from the other phase to the congested phase at the alarmed
  node itself, without changing the shared peak cycle or corridor offset; the
  losing split cannot fall below the 12 s pedestrian/minimum-green floor.
  Internal approaches additionally meter their upstream feeder, while external
  approaches still get the local split response even though no feeder exists.
- **Why fixed cycle:** coordinated adaptive systems preserve the common cycle
  so corridor offsets continue to line up as a green wave; demand changes the
  split within that cycle. Normal Webster splits return after the alarm clears.
- **Evidence:** scenario 13 exercises self-retiming plus upstream metering;
  scenario 27 proves an external I5:E alarm increases I5's own phase-A green,
  preserves its cycle, and restores the baseline split after clearing.

---

## 4. An experiment protocol you can run in one session

Do these in order, record the numbers, and you have the results section.

| # | Do this | Record | Feeds |
|---|---|---|---|
| 1 | Run 07:00 peak, no incidents, 10 sim-minutes | Cycle length per intersection; max queue per approach | Webster validation vs `TIMINGS.md` |
| 2 | Same at 14:00 off-peak | Actual green durations; count of skipped phases | Actuated-control justification |
| 3 | Same at 23:30 night | Confirms flash mode; press a ped button and time the response | Ped deadline (≥ 12 s walk) |
| 4 | Force one train at peak | Timeline: warning → flush start → gates down → clear → recovery complete. Also peak queue on the pocket approach | Preemption timing analysis §3.2 |
| 5 | Force trains back-to-back (2-min headway) | Does recovery complete before the next warning? | Schedulability: is the preemption task feasible at peak train frequency? |
| 6 | Dispatch EV, no train | Green-before-ETA at each corridor intersection; cross-street queue growth | EV corridor justification |
| 7 | Dispatch EV **and** force a train on its route | Blocking time before the train sequence starts | Priority inversion §3.3 |
| 8 | Accident on a main link, response ON, then OFF | Time-to-clear in each case | §3.6, the benefit claim |
| 9 | Kill central mid-peak, restore after 2 min | Message backlog flushed; any signal frozen? | Autonomy §3.4 |
| 10 | Jam each gate in turn, then force a train | ARM FAILED visible before demand? Fault exactly 10 s after down command? Train brakes to the 80 m signal? Both link ends held? Auto/manual repair? | Fail-safe table §3.5 |

Run `node verify.js` to get all of it asserted automatically; the scenario names
map one-to-one onto the rows above.

---

## 5. What this tool deliberately does **not** model

Say this out loud in the report. Naming your simplifications is what separates
an engineering model from a toy, and markers reward it.

**The full list lives in `ASSUMPTIONS.md`** — 42 of them, each marked for whether
it carries into the QNX port or exists only in the simulator. Keep that file as
the single source so the two never drift apart.

If you only cite three, cite these:

- **No spillback.** A link has no storage limit, so a full link never blocks the
  intersection feeding it. This is the model's biggest departure from reality and
  it flatters our results.
- **This simulator proves the message set, not schedulability.** All actors run
  in one process with an in-memory bus. "These nine messages are sufficient"
  transfers to QNX; "the deadline is met under load" does not.
- **Detectors are perfect.** Every adaptive decision rests on a queue reading
  that is never noisy, never stale and never broken.

---

## 6. The one-paragraph answer

You are not looking at a traffic demo. You are looking at a **distributed
real-time system with hard deadlines, shared resources, priority levels and
fault modes**, where the shared resource happens to be an intersection and the
deadline happens to be a train. Every number you extract here — clearance
intervals, warning times, blocking times, alarm thresholds — becomes a
justified constant in the QNX code, and every message you see on the event log
becomes a `MsgSend`. The simulator's job is to make sure that by the time you
write the QNX version, there is nothing left to guess.
