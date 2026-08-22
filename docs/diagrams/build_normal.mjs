// 1/3 — How a green ends. The two schemes that decide green length, and the clearance both share.
import { writeFileSync } from "node:fs";
import { Diagram } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/builder.mjs";
import { renderTree } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/layout-engine.mjs";
import { pool, start, end, gateway, task, serviceTask } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/bpmn.mjs";

const d = new Diagram("bpmn");

const proc = pool("sig", "Deciding how long a green lasts", {
  lanes: ["Peak — fixed-time", "Off-peak — actuated", "Road signal"],
  gap: 78,
}, [
  start("s1",  { lane: 0, col: 0, label: "Phase due" }),
  gateway("g1",{ lane: 0, col: 1, label: "Which mode?" }),
  serviceTask("t1", { lane: 0, col: 2, label: "Split from plan\n15 s" }),
  serviceTask("t2", { lane: 1, col: 2, label: "Minimum green\n7 s" }),
  serviceTask("t3", { lane: 1, col: 3, label: "Extend +2 s\nper detection" }),
  gateway("g2", { lane: 1, col: 4, label: "Gap-out?" }),
  task("t4", { lane: 2, col: 5, label: "GREEN\n≥ 12 s if WALK" }),
  task("t5", { lane: 2, col: 6, label: "YELLOW · 3 s" }),
  task("t6", { lane: 2, col: 7, label: "ALL-RED · 2 s" }),
  end("e1",  { lane: 2, col: 8, label: "Next phase" }),
]);

renderTree(d, proc, [40, 80]);
d.title("1/3 · Deciding how long a green lasts");

d.link("s1", "g1", "", { flow: true, rounded: true });
d.link("g1", "t1", "peak", { flow: true, rounded: true });
d.link("g1", "t2", "off-peak", { flow: true, rounded: true });
d.link("t1", "t4", "", { flow: true, rounded: true });
d.link("t2", "t3", "", { flow: true, rounded: true });
d.link("t3", "g2", "", { flow: true, rounded: true });
d.link("g2", "t3", "extend", { rounded: true });
d.link("g2", "t4", "end green", { flow: true, rounded: true });
d.link("t4", "t5", "", { flow: true, rounded: true });
d.link("t5", "t6", "", { flow: true, rounded: true });
d.link("t6", "e1", "", { flow: true, rounded: true });

writeFileSync(new URL("./1-normal-cycle.drawio", import.meta.url), d.mxfile("1 · Deciding how long a green lasts"));

import { execFileSync as __exec } from "node:child_process";
try {
  const __f = new URL("./1-normal-cycle.drawio", import.meta.url).pathname;
  console.log(__exec("drawio-ai", ["render", __f, "--check", "--page", "1", "-o", __f + ".png"], { encoding: "utf8" }).trim());
} catch (e) { console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]); }
