#!/bin/bash
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
cd "$(dirname "$0")"
fuser -k 8787/tcp 2>/dev/null || true
sleep 1
exec node admin/server.js
