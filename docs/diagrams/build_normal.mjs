// 1/3 — One green: what decides its length, and what ends it.
// Layout follows the team's swimlane structure. Two congestion decision points
// (central re-times the plan; the next green reads that plan at red→green) plus
// the off-peak drop-out, and ONE 12 s floor now that minGreen === walkMin.
import { writeFileSync } from "node:fs";
import { Diagram } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/builder.mjs";
import { renderTree } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/layout-engine.mjs";
import { pool, start, end, gateway, task, serviceTask } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/bpmn.mjs";

const d = new Diagram("bpmn");

// Catalog service tasks are only just tall enough for their label, which then sits
// under the gear marker. 90 px keeps the centred text clear of it.
const svc = (id, opts) => { const n = serviceTask(id, opts); n.h = 90; return n; };

// Gateway labels render below the diamond, which is also where the router lays its
// horizontal return segments. Flip the struck ones above, into empty lane space.
const gatewayTop = (id, opts) => {
  const g = gateway(id, opts);
  g.style = g.style.replace("verticalLabelPosition=bottom", "verticalLabelPosition=top")
                   .replace("verticalAlign=top", "verticalAlign=bottom");
  return g;
};

const proc = pool("cyc", "Peak and off-peak — night flash is described in the notes", {
  lanes: ["Network plan", "Peak — fixed-time", "Off-peak — actuated", "Pedestrian", "Road signal"],
  gap: 100, pad: 56,
}, [
  // ---- central: pick a plan. FIRST place green moves off plan.
  start("s1",       { lane: 0, col: 0,  label: "Cycle starts" }),
  svc("tp",         { lane: 0, col: 1,  label: "Plan cycle 40 s\nA + B = 30 s" }),
  gatewayTop("gc1", { lane: 0, col: 2,  label: "Congestion alarm?" }),
  svc("cr",         { lane: 0, col: 3,  label: "Re-time: move\nmin(8, crossing − 12) s\nto the queued phase" }),
  gatewayTop("g1",  { lane: 0, col: 4,  label: "Peak hours?" }),

  // ---- off-peak: one question, asked over and over. col 8 empty so the fan-out breathes.
  gateway("gp",     { lane: 3, col: 5,  label: "Pedestrian on\ncrossing road?" }),
  gatewayTop("gv",  { lane: 2, col: 6,  label: "Vehicle on crossing road?" }),
  task("t3",        { lane: 2, col: 7,  label: "Hold green on\ncurrent road" }),
  svc("t12",        { lane: 3, col: 7,  label: "Green ≥ 12 s\non crossing road" }),

  // ---- peak: no questions at all
  svc("t1",         { lane: 1, col: 8, label: "Take A's split" }),

  // ---- the signal head. SECOND place green moves off plan.
  task("t6",        { lane: 4, col: 9, label: "YELLOW\n3 s" }),
  task("t7",        { lane: 4, col: 10, label: "ALL-RED\n2 s" }),
  gateway("gc2",    { lane: 4, col: 11, label: "Alarm on this phase?" }),
  task("pb",        { lane: 4, col: 12, label: "Cross road GREEN\nplanned split" }),
  task("pg",        { lane: 1, col: 12, label: "Cross road GREEN\nsplit + min(8, crossing − 12)" }),
  gateway("g4",     { lane: 4, col: 13, label: "Continue?" }),
  end("e1",         { lane: 4, col: 14, label: "Mode change" }),
]);

renderTree(d, proc, [40, 80]);
d.title("1/3 · One green — what decides its length");

d.link("s1", "tp", "", { flow: true, rounded: true });
d.link("tp", "gc1", "", { flow: true, rounded: true });
d.link("gc1", "cr", "yes", { flow: true, rounded: true });
d.link("gc1", "g1", "no", { rounded: true });
d.link("cr", "g1", "", { flow: true, rounded: true });
d.link("g1", "t1", "peak", { flow: true, rounded: true });
d.link("g1", "gp", "off-peak", { flow: true, rounded: true });

// off-peak: the loop IS the control law. One floor now — both branches set 12 s.
d.link("gp", "t12", "yes", { rounded: true });
d.link("gp", "gv", "no", { flow: true, rounded: true });
d.link("gv", "t12", "yes", { flow: true, rounded: true });
d.link("gv", "t3", "no", { rounded: true });
d.link("t3", "gp", "keep asking", { rounded: true });
d.link("t12", "t6", "", { flow: true, rounded: true });

// the drop-out: an alarm off-peak does not lengthen a green, it ends actuation
d.link("t3", "t1", "alarm → fixed-time", { rounded: true });

// peak: straight through
d.link("t1", "t6", "no runtime check", { flow: true, rounded: true });

d.link("t6", "t7", "", { flow: true, rounded: true });
d.link("t7", "gc2", "", { flow: true, rounded: true });
d.link("gc2", "pb", "no", { flow: true, rounded: true });
d.link("gc2", "pg", "yes", { rounded: true });
d.link("pb", "g4", "", { flow: true, rounded: true });
d.link("pg", "g4", "", { rounded: true });
d.link("g4", "t1", "peak — next cycle", { rounded: true });
d.link("g4", "t3", "off-peak", { rounded: true });
d.link("g4", "e1", "mode changed", { rounded: true });

// Every number in the flow, and where it comes from. Sits under the pool so the
// figure can be read without the write-up next to it.
const p = d.rect("cyc");
const legend = [
  "<b>A = E + W</b> &#183; <b>B = N + S</b> &#8212; never green together; whichever is green, the other is <i>the crossing road</i>",
  "<b>peak cycle 40 s = A + B + 10</b> &#183; A + B = 30 s of green to share, split by demand",
  "<b>yellow 3 s</b> stopping distance at 40 km/h &#183; <b>all-red 2 s</b> intersection width &#247; speed &#183; two of each per cycle = the <b>10</b>",
  "<b>min green 12 s = walk min 12 s</b> = 14 m crossing &#247; 1.2 m/s &#8212; ONE floor, so green length no longer depends on whether a pedestrian is present",
  "<b>peak needs no runtime check</b> &#8212; the split calculation floors every phase at 12 s (30 s of green &#8805; 2 &#215; 12 s)",
  "<b>congestion</b> alarm at <b>25 veh</b> held <b>20 s</b> &#183; clears at <b>15</b> (hysteresis) &#183; the shift is <b>min(8, crossing green &#8722; 12)</b>, so a phase already at the 12 s floor donates <b>nothing</b>",
  "<b>green moves off plan in exactly two places</b> &#8212; when central re-times the plan, and when the next green reads that plan at the red&#8594;green boundary &#183; the cycle and the offset never change",
  "<b>off-peak alarm</b> replaces the actuated law with a Webster fixed plan &#8212; gap-out and hold-while-detected stop applying until it clears",
  "<b>gap-out</b> no arrival for 3 s and no queue &#183; <b>max green 40 s</b> caps how long a <i>waiting</i> vehicle is held, not the green itself",
].join("<br>");
d.box("legend", [p.x, p.y + p.h + 26], [p.w, 186], legend,
      { fill: "#F5F8FB", stroke: "#C4CCD7", va: "middle", fs: 11, ob: false });

const xml = d.mxfile("1 · One green")
  .replace(/(<mxCell id="legend"[^>]*style=")([^"]*)"/,
    (_, a, st) => a + st.replace("whiteSpace=wrap", "whiteSpace=wrap;align=left;spacingLeft=14") + '"');
writeFileSync(new URL("./1-normal-cycle.drawio", import.meta.url), xml);

import { execFileSync as __exec } from "node:child_process";
try {
  const __f = new URL("./1-normal-cycle.drawio", import.meta.url).pathname;
  console.log(__exec("drawio-ai", ["render", __f, "--check", "--page", "1", "--scale", "2", "-o", __f.replace(/\.drawio$/, ".png")], { encoding: "utf8" }).trim());
} catch (e) { console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]); }
