#!/bin/bash
AGY_BIN="${HOME}/.local/bin/agy"
[[ -x "$AGY_BIN" ]] || AGY_BIN=$(command -v agy)

PORT=4400

# Guarantee port 4400 is exclusively used for homeserver-mini.
# If an old or stale process is still listening on 4400, cleanly terminate it first.
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
    exec 3<&-
    exec 3>&-
    fuser -k "${PORT}/tcp" 2>/dev/null || true
    sleep 1
fi

exec "$AGY_BIN" --remote-control --hub-port "$PORT" --remote-control-name "homeserver-mini" "$@"
