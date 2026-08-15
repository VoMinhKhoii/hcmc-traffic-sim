#!/bin/bash
# Double-click me (macOS) — serves the sim and opens the browser.
cd "$(dirname "$0")"
( sleep 1; open "http://localhost:8000" ) &
python3 -m http.server 8000
