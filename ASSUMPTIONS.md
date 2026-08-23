# Assumptions and simplifications

Every model is wrong in specific, chosen ways. This is the complete list of ours.

Naming them is what separates an engineering model from a toy, and it is worth
marks: a simplification you declared is a decision, the same simplification left
unmentioned is a hole. Where an assumption is safe to keep in the QNX port it is
marked **[port]**; where it exists only because this is a simulator it is marked
**[sim only]**.

---

## 1. Traffic model

1. **Queues are numbers, not vehicles.** A queue is a real value that grows by
   λ·dt and drains at saturation flow. There is no car-following, no lane
   changing, no individual driver. Good enough to design signal timing; useless
   for anything about driver behaviour. **[sim only]**
2. **No spillback.** A link has unlimited storage. A full link never blocks the
   intersection feeding it, so real oversaturation would be worse than shown.
   This is the single most significant simplification in the model. **[sim only]**
3. **Deterministic arrivals.** Traffic arrives at exactly λ·dt, not as a Poisson
   process. There is no arrival variance, so no delay statistics can be drawn
   from the output. **[sim only]**
4. **No turning movements.** Every vehicle goes straight through: traffic from an
   approach exits via the opposite side. No left/right turns, so no protected
   turn phases and no turning conflicts. **[port]** — the phase design depends on it.
5. **Saturation flow 0.6 veh/s/lane is a calibration, not a measurement.** It is
   raised from the car-only ≈0.5 to account for HCMC's motorbike-dominated mix.
   No field survey backs this number. **[port]**
6. **One free-flow speed, 40 km/h, on every link** regardless of road class.
7. **7 m of road per queued vehicle**, including the gap to the car in front.
8. **Two lanes per direction on every road**, main and side alike.
9. **Vehicles travel as platoons**, coalesced into ~2 s buckets that arrive when
   their last vehicle would. Never early. **[sim only]**

## 2. Demand

10. **Demand depends only on road class and time of day.** There is no
    directional imbalance — no tidal flow toward the centre in the morning and
    out in the evening, which is the dominant real pattern.
11. **Peak is 06:30–09:30 and 16:00–19:00; night is 23:00–04:00.** Assumed from
    local knowledge, not from counts.
12. **The λ values are design figures**, chosen so the network is busy but stable
    at peak while rail preemption steals green every two minutes. They are not
    survey data.

## 3. Signals

13. **Two phases only** — A serves east/west, B serves north/south. No protected
    turns, no lagging phases, no split phasing. **[port]**
14. **Yellow 3 s and all-red 2 s are computed, not observed** — yellow from the
    ITE kinematic formula at 40 km/h, all-red from intersection width ÷ speed.
    **[port]**
15. **Pedestrian minimum 12 s** from a 2×2-lane crossing at 1.2 m/s walking
    speed. One walking speed for everyone. **[port]**
16. **Yellow means stop.** No discharge during yellow, per Vietnamese practice.
    **[port]**
17. **Night flashing flow is a modelled fraction of saturation** — 70% on the
    flashing-amber main road, 30% on the flashing-red side road. These express
    "proceed with caution" and "stop then go"; neither is measured. **[port]**
18. **All six intersections share one cycle at peak** (the longest Webster
    cycle), so that offsets produce real green waves. **[port]**

## 4. Railway

19. **The rail line is straight.** It is defined as the line through crossings A
    and B; crossing C is derived analytically as where that line meets link
    I1–I6. The real Lê Văn Sỹ alignment is not traced. **[sim only]**
20. **Trains run at a constant 60 km/h and are 120 m long.**
21. **Detection is 30 s / 500 m before the crossing.** Assumed detector placement.
    **[port]**
22. **Braking is constant deceleration**, ignoring brake build-up time and
    driver or ATP reaction time. **[port]**
23. **Night trains run every night** at 20-minute headway. The brief's
    "Friday/Saturday only" detail is treated as a report note, not control logic.
24. **Only one gate fault is modelled: failure to prove closed.** A barrier stuck
    *down* is the safe failure — road blocked, crossing protected, trains
    unaffected — and is deliberately excluded. **[port]**
25. **Vehicles already inside a link when it is closed are assumed to clear
    themselves.** **[sim only]**
26. **Repair is a random human action**, 300–900 s in the demo default. There is
    no repair-crew model, no travel time, no partial repair.
27. **Trains hold 220 m front-to-front separation** (120 m length + 100 m gap).
    This is a simple following rule, not a signalling block model. **[port]**

## 5. Control room

28. **Central never sets a light.** It selects plans and issues overrides; locals
    always own their own signals. **[port]** — this is the architecture, not a
    simplification, and it is what makes the locals independently deployable.
29. **Congestion thresholds are chosen, not derived** — 25 vehicles, held for
    20 s, clearing at 15. They are not tied to a service-level target such as a
    maximum acceptable delay. **[port]**
30. **Split adjustment shifts at most 8 s and never changes the cycle**, so
    corridor offsets survive. **[port]**
31. **Metering never cascades.** A node that is already re-timed is not metered
    again, which prevents the whole network freezing itself. **[port]**
32. **Recovery boost applies only in actuated mode.** Under a fixed plan it is
    ignored. Known limitation, not intentional.

## 6. Failures

33. **Two failure classes are in scope: central link loss and gate fault.** The
    brief's "railway track broken" is out of scope. **[port]**
34. **Link failure is all or nothing.** The link is up or down — no partial loss,
    no corruption, no reordering, no duplication. **[sim only]** — a real QNX
    port must decide what `MsgSend` returning an error actually means.
35. **While the link is up, no message is ever lost**, and buffered messages
    flush in order on reconnect. **[sim only]**

## 7. Priority vehicle

36. **One EV at a time**, travelling at 50 km/h on the traffic side.
37. **EV arrival times are computed from distances and assumed accurate.** The
    corridor is preset, not routed dynamically, and the ETA does not adapt to
    the congestion the EV actually meets. **[port]**
38. **A lost `RESUME` is caught by a watchdog** that releases the preemption at
    ETA + 90 s. A local controller must never stay preempted forever. **[port]**

## 8. Architecture and the simulator itself

39. **This simulator proves the message set, not the timing.** All actors run in
    one process with cooperative ticking and an in-memory bus. Real QNX
    scheduling, thread priorities, blocking behaviour and context-switch cost
    are **not** modelled. Conclusions of the form "these nine messages are
    sufficient" transfer; conclusions of the form "the deadline is met under
    load" do not. **[sim only — read this one twice]**
40. **Time is quantised to a 0.1 s tick.** Every duration is a multiple of it.
41. **Detectors are perfect.** Queue length and gap-out detection are read
    exactly, with no noise, no dropout and no detector failure mode. Real
    inductive loops fail, and a real design should say what happens when one does.
    **[sim only]**

---

## The three that matter most

If you only mention three in the report, mention these:

- **No spillback (#2)** — it is the model's biggest departure from reality and it
  flatters our results.
- **The simulator proves sufficiency, not schedulability (#39)** — it is the
  boundary of what this evidence can support, and claiming more would be wrong.
- **Perfect detectors (#41)** — every adaptive decision in the system rests on a
  sensor reading we never allow to be wrong.
