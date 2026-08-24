// 1/3 — One green, in all three modes. What decides its length, and what ends it.
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

const proc = pool("cyc", "Peak and off-peak — night flash is described in the notes, not drawn here", {
  lanes: ["Central", "Peak — fixed-time", "Off-peak — actuated", "Pedestrian", "Road signal"],
  gap: 96, pad: 56,
}, [
  start("s1",       { lane: 0, col: 0,  label: "Controller starts" }),
  svc("tp",         { lane: 0, col: 1,  label: "Publish this\nmode's plan" }),
  gatewayTop("g1",  { lane: 0, col: 2,  label: "Peak hours?" }),

  // ---- off-peak: one question, asked over and over
  gateway("gp",     { lane: 3, col: 3,  label: "Pedestrian waiting\non cross road?" }),
  task("t3",        { lane: 2, col: 3,  label: "Hold green on\ncurrent road" }),
  gatewayTop("gv",  { lane: 2, col: 4,  label: "Vehicle waiting on cross road?" }),
  svc("t2",         { lane: 2, col: 5,  label: "Next green\n≥ 7 s" }),
  svc("t4",         { lane: 3, col: 5,  label: "Next green ≥ 12 s\n(crossing time)" }),
  gateway("gd",     { lane: 2, col: 6,  label: "Current green done?" }),

  // ---- peak: no questions at all
  svc("t1",         { lane: 1, col: 6,  label: "Take A's split\n18 · 15 · 12 s (≥ 12 s)" }),

  // ---- what the signal head does
  task("t6",        { lane: 4, col: 7,  label: "YELLOW\n3 s" }),
  task("t7",        { lane: 4, col: 8,  label: "ALL-RED\n2 s" }),
  task("pb",        { lane: 4, col: 9,  label: "Cross road GREEN\n(the minimum\njust decided)" }),
  gatewayTop("g4",  { lane: 4, col: 10, label: "Continue?" }),
  end("e1",         { lane: 4, col: 11, label: "Mode change" }),
]);

renderTree(d, proc, [40, 80]);
d.title("1/3 · One green — what decides its length");

d.link("s1", "tp", "", { flow: true, rounded: true });
d.link("tp", "g1", "", { flow: true, rounded: true });
d.link("g1", "t1", "peak", { flow: true, rounded: true });
d.link("g1", "gp", "off-peak", { flow: true, rounded: true });

// off-peak: the loop IS the control law
d.link("gp", "t4", "yes", { rounded: true });
d.link("gp", "gv", "no", { flow: true, rounded: true });
d.link("gv", "t2", "yes", { flow: true, rounded: true });
d.link("gv", "t3", "no", { rounded: true });
d.link("t3", "gp", "keep asking", { rounded: true });
d.link("t2", "gd", "", { flow: true, rounded: true });
d.link("t4", "gd", "", { rounded: true });
d.link("gd", "t3", "not yet — min unserved, or still flowing", { rounded: true });
d.link("gd", "t6", "end green — forced at 40 s if it drags", { flow: true, rounded: true });

// peak: straight through
d.link("t1", "t6", "split already ≥ 12 s — no runtime check", { flow: true, rounded: true });

d.link("t6", "t7", "", { flow: true, rounded: true });
d.link("t7", "pb", "", { flow: true, rounded: true });
d.link("pb", "g4", "", { flow: true, rounded: true });
d.link("g4", "t1", "peak — next cycle, always 40 s", { rounded: true });
d.link("g4", "t3", "off-peak — no fixed period", { rounded: true });
d.link("g4", "e1", "mode changed", { rounded: true });

writeFileSync(new URL("./1-normal-cycle.drawio", import.meta.url), d.mxfile("1 · One green, all three modes"));

import { execFileSync as __exec } from "node:child_process";
try {
  const __f = new URL("./1-normal-cycle.drawio", import.meta.url).pathname;
  console.log(__exec("drawio-ai", ["render", __f, "--check", "--page", "1", "--scale", "2", "-o", __f + ".png"], { encoding: "utf8" }).trim());
} catch (e) { console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]); }
