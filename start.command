#!/bin/sh
cd "$(dirname "$0")"
open http://localhost:8787 2>/dev/null || xdg-open http://localhost:8787 2>/dev/null
node server.js
