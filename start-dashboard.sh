#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "⚡ Starting AG Switchboard Dashboard for Antigravity 2.0..."
node dist/dashboard-server.js
