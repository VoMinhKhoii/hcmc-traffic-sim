// 3/3 — The failure. Central dies; locals keep running and resync when it returns.
import { writeFileSync } from "node:fs";
import { Diagram } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/builder.mjs";
import { renderTree } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/layout-engine.mjs";
import { pool, start, end, gateway, task, serviceTask } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/bpmn.mjs";

const d = new Diagram("bpmn");

// Catalog service tasks are just tall enough for their label, which then sits under the
// gear marker. 90 px keeps the centred text clear of it.
const svc = (id, opts) => { const n = serviceTask(id, opts); n.h = 90; return n; };

const proc = pool("deg", "Losing central — the corridor degrades, it does not stop", {
  lanes: ["Central", "Local controllers", "Message bus", "Road signal"],
  gap: 78,
}, [
  start("s1", { lane: 0, col: 0, label: "Central running" }),
  svc("t1", { lane: 0, col: 1, label: "Publish plan\nsplits · offsets" }),
  gateway("g1", { lane: 0, col: 2, label: "Reachable?" }),
  svc("t2", { lane: 1, col: 3, label: "Apply plan —\nstay coordinated" }),
  task("tr", { lane: 3, col: 4, label: "Green wave holds\nacross I3 → I5" }),
  end("e2",  { lane: 3, col: 5, label: "Coordinated service" }),
  svc("t4", { lane: 1, col: 4, label: "Autonomous —\nhold last known plan" }),
  svc("t5", { lane: 2, col: 5, label: "Buffer outgoing\nmessages" }),
  task("t6", { lane: 1, col: 6, label: "Signals keep cycling\nno blackout" }),
  gateway("g2", { lane: 2, col: 7, label: "Back up?" }),
  svc("t7", { lane: 2, col: 8, label: "Flush buffer\non reconnect" }),
  svc("t8", { lane: 0, col: 9, label: "Resync state" }),
  end("e1",  { lane: 0, col: 10, label: "Coordination restored" }),
]);

renderTree(d, proc, [40, 80]);
d.title("3/3 · Losing central — autonomous fallback and resync");

d.link("s1", "t1", "", { flow: true, rounded: true });
d.link("t1", "g1", "", { flow: true, rounded: true });
d.link("g1", "t2", "yes", { flow: true, rounded: true });
d.link("g1", "t4", "link lost", { rounded: true });
d.link("t2", "tr", "", { flow: true, rounded: true });
d.link("tr", "e2", "", { flow: true, rounded: true });
d.link("t4", "t5", "", { flow: true, rounded: true });
d.link("t5", "t6", "", { flow: true, rounded: true });
d.link("t6", "g2", "", { flow: true, rounded: true });
d.link("g2", "t6", "still down", { rounded: true });
d.link("g2", "t7", "reconnected", { flow: true, rounded: true });
d.link("t7", "t8", "", { flow: true, rounded: true });
d.link("t8", "e1", "", { flow: true, rounded: true });

writeFileSync(new URL("./3-central-failure.drawio", import.meta.url), d.mxfile("3 · Losing central"));

import { execFileSync as __exec } from "node:child_process";
try {
  const __f = new URL("./3-central-failure.drawio", import.meta.url).pathname;
  console.log(__exec("drawio-ai", ["render", __f, "--check", "--page", "1", "--scale", "2", "-o", __f + ".png"], { encoding: "utf8" }).trim());
} catch (e) { console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]); }
