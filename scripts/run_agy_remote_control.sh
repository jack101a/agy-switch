#!/bin/bash
# Backward-compatibility wrapper: delegates to official AGY remote-control serve
AGY_BIN="${HOME}/.local/bin/agy"
[[ -x "$AGY_BIN" ]] || AGY_BIN=$(command -v agy)

exec "$AGY_BIN" remote-control serve "$@"
