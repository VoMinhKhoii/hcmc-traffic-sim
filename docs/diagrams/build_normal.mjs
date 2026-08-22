// 1/3 — One full 40 s cycle: where the plan comes from, how each green's length is decided,
// where the pedestrian floor applies, and why the cycle closes at 40 s.
import { writeFileSync } from "node:fs";
import { Diagram } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/builder.mjs";
import { renderTree } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/layout-engine.mjs";
import { pool, start, end, gateway, task, serviceTask, subProcess } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/bpmn.mjs";

const d = new Diagram("bpmn");

const proc = pool("cyc", "One cycle — at peak A + B + 10 = 40 s; off-peak has no fixed cycle", {
  lanes: ["Network plan", "Peak — fixed-time", "Off-peak — actuated", "Pedestrian", "Road signal"],
  gap: 78, pad: 46,
}, [
  start("s1",       { lane: 0, col: 0,  label: "Cycle starts" }),
  serviceTask("tp", { lane: 0, col: 1,  label: "Plan\ncycle 40 s\nA + B = 30 s" }),
  gateway("g1",     { lane: 0, col: 2,  label: "Peak hours?" }),
  serviceTask("t1", { lane: 1, col: 3,  label: "Take A's split\n18 · 15 · 12 by node" }),
  serviceTask("t2", { lane: 2, col: 3,  label: "Minimum green\n7 s" }),
  serviceTask("t3", { lane: 2, col: 4,  label: "Extend +2 s\nper detection" }),
  gateway("g2",     { lane: 2, col: 5,  label: "Gap-out?" }),
  gateway("g3",     { lane: 3, col: 6,  label: "WALK\nrequested?" }),
  task("t4",        { lane: 3, col: 7,  label: "Green must be\n≥ 12 s" }),
  task("t5",        { lane: 4, col: 8,  label: "GREEN\nphase A" }),
  task("t6",        { lane: 4, col: 9,  label: "YELLOW\n3 s" }),
  task("t7",        { lane: 4, col: 10, label: "ALL-RED\n2 s" }),
  subProcess("pb",  { lane: 4, col: 11, label: "PHASE B\n15 + 3 + 2 s" }),
  gateway("g4",     { lane: 4, col: 12, label: "Continue?" }),
  end("e1",         { lane: 4, col: 13, label: "Mode change" }),
]);

renderTree(d, proc, [40, 80]);
d.title("1/3 · One full cycle — where 40 s comes from");

d.link("s1", "tp", "", { flow: true, rounded: true });
d.link("tp", "g1", "", { flow: true, rounded: true });
d.link("g1", "t1", "peak", { flow: true, rounded: true });
d.link("g1", "t2", "off-peak", { flow: true, rounded: true });
d.link("t1", "g3", "", { flow: true, rounded: true });
d.link("t2", "t3", "", { flow: true, rounded: true });
d.link("t3", "g2", "", { flow: true, rounded: true });
d.link("g2", "t3", "extend", { rounded: true });
d.link("g2", "g3", "end green — cycle varies 20–50 s", { flow: true, rounded: true });
d.link("g3", "t4", "yes", { rounded: true });
d.link("g3", "t5", "no", { flow: true, rounded: true });
d.link("t4", "t5", "", { flow: true, rounded: true });
d.link("t5", "t6", "", { flow: true, rounded: true });
d.link("t6", "t7", "", { flow: true, rounded: true });
d.link("t7", "pb", "", { flow: true, rounded: true });
d.link("pb", "g4", "", { flow: true, rounded: true });
d.link("g4", "t5", "peak: repeat every 40 s", { rounded: true });
d.link("g4", "e1", "mode changed", { rounded: true });

writeFileSync(new URL("./1-normal-cycle.drawio", import.meta.url), d.mxfile("1 · One full cycle"));

import { execFileSync as __exec } from "node:child_process";
try {
  const __f = new URL("./1-normal-cycle.drawio", import.meta.url).pathname;
  console.log(__exec("drawio-ai", ["render", __f, "--check", "--page", "1", "-o", __f + ".png"], { encoding: "utf8" }).trim());
} catch (e) { console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]); }
