# Process diagrams

Three BPMN swimlane views of the same five actors:

| File | Shows |
| --- | --- |
| `1-normal-cycle` | How a green's length is decided — fixed-time vs actuated |
| `2-train-preemption` | The interrupt, including the gate-fault branch |
| `3-central-failure` | Autonomous fallback and resync when central dies |

`.drawio` files are the source — open them in draw.io to edit. `.png` are renders.

## Regenerating

Requires the drawio-ai-kit CLI:

    npm i -g github:sparklabx/drawio-ai-kit
    node build_normal.mjs      # → 1-normal-cycle.drawio + .png

**The build scripts hardcode an absolute path to the kit**, including the Node
version (`~/.nvm/versions/node/v22.12.0/...`). A Node upgrade or a different
machine breaks the imports. Fix by substituting the current path:

    ROOT="$(drawio-ai root)"
    sed -i '' "s#/Users/[^\"]*/drawio-ai-kit#$ROOT#g" build_*.mjs

Renders need `--page 1`: drawio v27.0.2+ numbers pages from 1, but the kit's
scaffold emits `-p 0`, which fails.

These show sequence, not duration — BPMN has no time axis. Timing derivations
live in `../../TIMINGS.md`.
