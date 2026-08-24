// 1/3 — One green, decided: who is waiting on the cross road, whether this green may
// end yet, and how the two modes differ in what happens after.
import { writeFileSync } from "node:fs";
import { Diagram } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/builder.mjs";
import { renderTree } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/layout-engine.mjs";
import { pool, start, end, gateway, task, serviceTask, subProcess } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/bpmn.mjs";

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

const proc = pool("cyc", "One green — at peak the cycle is always 40 s; off-peak there is no fixed cycle", {
  lanes: ["Network plan", "Peak — fixed-time", "Off-peak — actuated", "Pedestrian", "Road signal"],
  gap: 96, pad: 56,
}, [
  start("s1",       { lane: 0, col: 0,  label: "Cycle starts" }),
  svc("tp",         { lane: 0, col: 1,  label: "Plan\ncycle 40 s\nA + B = 30 s" }),
  gatewayTop("g1",  { lane: 0, col: 2,  label: "Peak hours?" }),

  gateway("gp",     { lane: 3, col: 3,  label: "Pedestrian waiting\non cross road?" }),
  task("t3",        { lane: 2, col: 3,  label: "Hold green on\ncurrent road" }),
  gatewayTop("gv",  { lane: 2, col: 4,  label: "Vehicle waiting on cross road?" }),
  svc("t2",         { lane: 2, col: 5,  label: "Next green\n\u2265 7 s" }),
  svc("t4",         { lane: 3, col: 6,  label: "Next green \u2265 12 s\n(crossing time)" }),
  gatewayTop("gd",  { lane: 2, col: 6,  label: "Current green done?\n(min served, gapped)" }),

  svc("t1",         { lane: 1, col: 7,  label: "Take A's split\n18 · 15 · 12 s (≥ 12 s)" }),

  task("t5",        { lane: 4, col: 8,  label: "GREEN\nphase A" }),
  task("t6",        { lane: 4, col: 9,  label: "YELLOW\n3 s" }),
  task("t7",        { lane: 4, col: 10, label: "ALL-RED\n2 s" }),
  subProcess("pb",  { lane: 4, col: 11, label: "PHASE B\nsame rules,\nother direction" }),
  gatewayTop("g4",  { lane: 4, col: 12, label: "Continue?" }),
  end("e1",         { lane: 4, col: 13, label: "Mode change" }),
]);

renderTree(d, proc, [40, 80]);
d.title("1/3 · One green — what decides its length, and what happens after");

d.link("s1", "tp", "", { flow: true, rounded: true });
d.link("tp", "g1", "", { flow: true, rounded: true });
d.link("g1", "t1", "peak", { flow: true, rounded: true });
d.link("g1", "gp", "off-peak", { flow: true, rounded: true });

// the continuous cross-road check
d.link("gp", "t4", "yes", { rounded: true });
d.link("gp", "gv", "no", { flow: true, rounded: true });
d.link("gv", "t2", "yes", { flow: true, rounded: true });
d.link("gv", "t3", "no", { rounded: true });
d.link("t3", "gp", "keep asking", { rounded: true });

d.link("t2", "gd", "", { flow: true, rounded: true });
d.link("t4", "gd", "", { rounded: true });
d.link("gd", "gp", "not yet", { rounded: true });
d.link("gd", "t5", "end green", { flow: true, rounded: true });

d.link("t1", "t5", "split already ≥ 12 s — no runtime ped check", { flow: true, rounded: true });

d.link("t5", "t6", "", { flow: true, rounded: true });
d.link("t6", "t7", "", { flow: true, rounded: true });
d.link("t7", "pb", "", { flow: true, rounded: true });
d.link("pb", "g4", "", { flow: true, rounded: true });

// the two modes rejoin at different places — that IS the difference between them
d.link("g4", "t1", "peak — next cycle, always 40 s", { rounded: true });
d.link("g4", "t3", "off-peak — next green, no fixed period", { rounded: true });
d.link("g4", "e1", "mode changed", { rounded: true });

writeFileSync(new URL("./1-normal-cycle.drawio", import.meta.url), d.mxfile("1 · One full cycle"));

import { execFileSync as __exec } from "node:child_process";
try {
  const __f = new URL("./1-normal-cycle.drawio", import.meta.url).pathname;
  console.log(__exec("drawio-ai", ["render", __f, "--check", "--page", "1", "--scale", "2", "-o", __f + ".png"], { encoding: "utf8" }).trim());
} catch (e) { console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]); }
