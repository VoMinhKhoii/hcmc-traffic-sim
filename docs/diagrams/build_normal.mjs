// 1/3 — One full 40 s cycle: where the plan comes from, how each green's length is decided,
// where the pedestrian floor applies, and why the cycle closes at 40 s.
import { writeFileSync } from "node:fs";
import { Diagram } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/builder.mjs";
import { renderTree } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/layout-engine.mjs";
import { pool, start, end, gateway, task, serviceTask, subProcess } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/bpmn.mjs";

const d = new Diagram("bpmn");

// Gateway labels render below the diamond by default, where the router also likes to
// run horizontal segments — every long return edge struck one. Flip these three above,
// into lane space that is empty at their column.
const svc = (id, opts) => {
  const n = serviceTask(id, opts);
  n.h = 90;   // taller than the catalog default so the centred label clears the gear marker
  return n;
};

const gatewayTop = (id, opts) => {
  const g = gateway(id, opts);
  g.style = g.style.replace("verticalLabelPosition=bottom", "verticalLabelPosition=top")
                   .replace("verticalAlign=top", "verticalAlign=bottom");
  return g;
};

const proc = pool("cyc", "One cycle — at peak A + B + 10 = 40 s; off-peak has no fixed cycle", {
  lanes: ["Network plan", "Peak — fixed-time", "Off-peak — actuated", "Pedestrian", "Road signal"],
  gap: 96, pad: 56,
}, [
  start("s1",       { lane: 0, col: 0,  label: "Cycle starts" }),
  svc("tp",       { lane: 0, col: 1,  label: "Plan\ncycle 40 s\nA + B = 30 s" }),
  gatewayTop("g1",     { lane: 0, col: 2,  label: "Peak hours?" }),
  svc("t1",       { lane: 1, col: 7,  label: "Take A's split\n18 \u00b7 15 \u00b7 12 s by node" }),
  gateway("g3",     { lane: 3, col: 3,  label: "WALK on\nthis phase?" }),
  task("t4",        { lane: 3, col: 4,  label: "Minimum green\n12 s\n(crossing time)" }),
  svc("t2",       { lane: 2, col: 4,  label: "Minimum green\n7 s" }),
  svc("t3",       { lane: 2, col: 5,  label: "Hold green while\ndetector live" }),
  gatewayTop("g2",     { lane: 2, col: 6,  label: "End this\ngreen?" }),
  task("t8",        { lane: 2, col: 7,  label: "No cross-street vehicle\nor ped: rest on green\n\u2014 no cycle at all" }),
  task("t5",        { lane: 4, col: 8,  label: "GREEN\nphase A" }),
  task("t6",        { lane: 4, col: 9,  label: "YELLOW\n3 s" }),
  task("t7",        { lane: 4, col: 10, label: "ALL-RED\n2 s" }),
  subProcess("pb",  { lane: 4, col: 11, label: "PHASE B\nsame rules,\nother direction" }),
  gatewayTop("g4",     { lane: 4, col: 12, label: "Continue?" }),
  end("e1",         { lane: 4, col: 13, label: "Mode change" }),
]);

renderTree(d, proc, [40, 80]);
d.title("1/3 · One full cycle — how each green's length is decided");

d.link("s1", "tp", "", { flow: true, rounded: true });
d.link("tp", "g1", "", { flow: true, rounded: true });
d.link("g1", "t1", "peak", { flow: true, rounded: true });
d.link("g1", "g3", "off-peak", { flow: true, rounded: true });
d.link("g3", "t4", "yes", { rounded: true });
d.link("g3", "t2", "no", { flow: true, rounded: true });
d.link("t4", "t3", "", { rounded: true });
d.link("t2", "t3", "", { flow: true, rounded: true });
d.link("t3", "g2", "", { flow: true, rounded: true });
d.link("g2", "t3", "not yet \u2014 keep green", { rounded: true });
d.link("g2", "t8", "nobody waiting", { rounded: true });
d.link("t8", "t3", "", { rounded: true });
d.link("g2", "t5", "gapped & min served \u2014 half-cycle 7 + 3 + 2 s", { flow: true, rounded: true });
d.link("t1", "t5", "", { flow: true, rounded: true });
d.link("t5", "t6", "", { flow: true, rounded: true });
d.link("t6", "t7", "", { flow: true, rounded: true });
d.link("t7", "pb", "", { flow: true, rounded: true });
d.link("pb", "g4", "", { flow: true, rounded: true });
d.link("g4", "g1", "next green \u2014 decide again (at peak, every 40 s)", { rounded: true });
d.link("g4", "e1", "mode changed", { rounded: true });

writeFileSync(new URL("./1-normal-cycle.drawio", import.meta.url), d.mxfile("1 · One full cycle"));

import { execFileSync as __exec } from "node:child_process";
try {
  const __f = new URL("./1-normal-cycle.drawio", import.meta.url).pathname;
  console.log(__exec("drawio-ai", ["render", __f, "--check", "--page", "1", "--scale", "2", "-o", __f + ".png"], { encoding: "utf8" }).trim());
} catch (e) { console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]); }
