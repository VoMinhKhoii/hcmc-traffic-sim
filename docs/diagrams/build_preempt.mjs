// 2/3 — The interrupt. A train arrives; normal control is suspended until the crossing is proved safe.
import { writeFileSync } from "node:fs";
import { Diagram } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/builder.mjs";
import { renderTree } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/layout-engine.mjs";
import { pool, start, end, gateway, task, serviceTask } from "/Users/khoivo/.nvm/versions/node/v22.12.0/lib/node_modules/drawio-ai-kit/src/bpmn.mjs";

const d = new Diagram("bpmn");

// Catalog service tasks are just tall enough for their label, which then sits under the
// gear marker. 90 px keeps the centred text clear of it.
const svc = (id, opts) => { const n = serviceTask(id, opts); n.h = 90; return n; };

// Event/gateway labels sit below the shape, where the router also runs horizontal
// segments. Flip the ones that get struck above the shape instead.
const labelAbove = (n) => {
  n.style = n.style.replace("verticalLabelPosition=bottom", "verticalLabelPosition=top")
                   .replace("verticalAlign=top", "verticalAlign=bottom");
  return n;
};

const proc = pool("pre", "Train preemption at crossing C — and what happens when the gate cannot prove itself", {
  lanes: ["Central", "Local controller I1", "Road signal", "Gates C", "Train"],
  gap: 78,
}, [
  start("s1", { lane: 4, col: 0, label: "Train 30 s out", type: "message" }),
  svc("t1", { lane: 1, col: 1, label: "Preempt\nrequest" }),
  task("t2",       { lane: 2, col: 2, label: "Pocket flush GREEN\n20 s" }),
  svc("t3",{ lane: 1, col: 3, label: "Command gates\nDOWN" }),
  svc("t4",{ lane: 3, col: 4, label: "Barriers travel\n8 s" }),
  gateway("g1",    { lane: 3, col: 5, label: "Proved\n≤ 10 s?" }),
  svc("t5",{ lane: 3, col: 6, label: "CLOSED\nproof received" }),
  task("t9",       { lane: 4, col: 6, label: "Held at the\n80 m signal" }),
  task("t6",       { lane: 2, col: 7, label: "Both directions\nRED" }),
  svc("ta",{ lane: 0, col: 7, label: "Raise GATE_FAULT\nalarm" }),
  end("e2",        { lane: 0, col: 8, label: "BROKEN", type: "error" }),
  task("t7",       { lane: 4, col: 8, label: "Train passes" }),
  svc("t8",{ lane: 3, col: 9, label: "Gates UP" }),
  svc("t10",{ lane: 1, col: 10, label: "Resume normal\ncontrol" }),
  end("e1",        { lane: 1, col: 11, label: "Normal service" }),
]);

renderTree(d, proc, [40, 80]);
d.title("2/3 · Train preemption — the interrupt that outranks every mode");

d.link("s1", "t1", "approaching", { flow: true, rounded: true });
d.link("t1", "t2", "preempt", { flow: true, rounded: true });
d.link("t2", "t3", "clear", { flow: true, rounded: true });
d.link("t3", "t4", "close", { flow: true, rounded: true });
d.link("t4", "g1", "", { flow: true, rounded: true });
d.link("g1", "t5", "proved", { flow: true, rounded: true });
d.link("g1", "t9", "timeout", { rounded: true });
d.link("t9", "ta", "GATE_FAULT", { rounded: true });
d.link("ta", "e2", "", { rounded: true });
d.link("t5", "t6", "confirmed", { flow: true, rounded: true });
d.link("t6", "t7", "protected", { flow: true, rounded: true });
d.link("t7", "t8", "clear", { flow: true, rounded: true });
d.link("t8", "t10", "", { flow: true, rounded: true });
d.link("t10", "e1", "", { flow: true, rounded: true });


// Every term and number the figure uses, so it can be read on its own.
const p = d.rect("pre");
const legend = [
  "<b>pocket</b> &#8212; the queue between the stop line and the tracks; it must be <i>empty</i> before the gates drop. That is the whole safety problem.",
  "<b>T&#8722;30 s</b> warning &#183; <b>pocket flush 20 s</b> &#183; <b>barrier travel 8 s</b> &#183; <b>proof timeout 10 s</b> &#8212; the flush and the travel both fit inside the warning",
  "<b>commanded down &#8800; known down.</b> The gate must <i>prove</i> CLOSED. No proof in 10 s and the <b>train</b> is held at the 80 m signal, not the road.",
  "<b>BROKEN</b> is a BPMN error end &#8212; the only coloured element in any of these three figures. Colour carries meaning here, not emphasis.",
  "<b>Priority</b> train &gt; emergency vehicle &gt; normal. Preemption outranks the peak plan, the actuated loop and night flash alike.",
].join("<br>");
d.box("legend", [p.x, p.y + p.h + 26], [p.w, 108], legend,
      { fill: "#F5F8FB", stroke: "#C4CCD7", va: "middle", fs: 11, ob: false });

const xml = d.mxfile("2 · Train preemption").replace(
  /(<mxCell id="legend"[^>]*style=")([^"]*)"/,
  (_, a, st) => a + st.replace("whiteSpace=wrap", "whiteSpace=wrap;align=left;spacingLeft=14") + '"');
writeFileSync(new URL("./2-train-preemption.drawio", import.meta.url), xml);

import { execFileSync as __exec } from "node:child_process";
try {
  const __f = new URL("./2-train-preemption.drawio", import.meta.url).pathname;
  console.log(__exec("drawio-ai", ["render", __f, "--check", "--page", "1", "--scale", "2", "-o", __f.replace(/\.drawio$/, ".png")], { encoding: "utf8" }).trim());
} catch (e) { console.error("RENDER-SKIPPED:", String(e.message).split("\n")[0]); }
