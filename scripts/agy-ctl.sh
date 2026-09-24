#!/bin/bash
# Antigravity Remote Control Daemon Controller
# Connected to official systemd user service: antigravity-cli-daemon.service

# Auto-detect service: prefer official antigravity-cli-daemon.service; fallback to legacy
SERVICE="antigravity-cli-daemon.service"
if ! systemctl --user list-unit-files "$SERVICE" &>/dev/null; then
  if systemctl --user list-unit-files "agy-remote-control.service" &>/dev/null; then
    SERVICE="agy-remote-control.service"
  fi
fi

show_help() {
    echo ""
    echo "======================================================"
    echo "  Antigravity Remote Server (Official agy-daemon)"
    echo "======================================================"
    echo ""
    echo "Commands:"
    echo "  agy-on       Start the remote server daemon (goes ONLINE)"
    echo "  agy-off      Stop the remote server daemon  (goes OFFLINE)"
    echo "  agy-restart  Restart the remote server daemon"
    echo "  agy-status   Show daemon service status and recent logs"
    echo "  agy-logs     Stream live daemon logs (Ctrl+C to exit)"
    echo "  agy-help     Show this help screen"
    echo ""
    echo "Also supports: agy-daemon <on|off|restart|status|logs|help>"
    echo "Instance: 'homeserver-mini' | User Service: $SERVICE"
    echo "======================================================"
    echo ""
}

# Detect command from script name or first argument
CMD=$(basename "$0")
case "$CMD" in
  agy-on)      ACTION="on" ;;
  agy-off)     ACTION="off" ;;
  agy-restart) ACTION="restart" ;;
  agy-status)  ACTION="status" ;;
  agy-logs)    ACTION="logs" ;;
  agy-help)    ACTION="help" ;;
  *)           ACTION="${1:-help}" ;;
esac

case "$ACTION" in
  on|start)
    if [[ -x "$HOME/.local/bin/agy-auth" ]]; then
      "$HOME/.local/bin/agy-auth" select-best
      "$HOME/.local/bin/agy-auth" rotate --start
    fi

    if systemctl --user is-active --quiet "$SERVICE"; then
      echo "Antigravity remote server is already running (ONLINE)."
      systemctl --user status "$SERVICE" --no-pager -l | head -n 8
    else
      echo "Starting Antigravity remote server ($SERVICE)..."
      if systemctl --user list-unit-files "$SERVICE" &>/dev/null; then
        systemctl --user start "$SERVICE"
      elif [[ -x "$HOME/.local/bin/agy" ]]; then
        "$HOME/.local/bin/agy" remote-control start --name "homeserver-mini"
      elif command -v agy &>/dev/null; then
        agy remote-control start --name "homeserver-mini"
      fi

      sleep 2.5
      if systemctl --user is-active --quiet "$SERVICE"; then
        echo "✓ Started successfully! Remote server is ONLINE ('homeserver-mini')."
      else
        echo "✗ Failed to start. Check status with 'agy-status' or 'agy-logs'."
        exit 1
      fi
    fi
    ;;

  off|stop)
    if [[ -x "$HOME/.local/bin/agy-auth" ]]; then
      "$HOME/.local/bin/agy-auth" rotate --stop
    fi

    echo "Stopping Antigravity remote server ($SERVICE)..."
    systemctl --user stop "$SERVICE" 2>/dev/null || true

    # Sweep cleanup: guarantee zero orphan/rogue processes linger
    pkill -f "agy remote-control" 2>/dev/null || true
    pkill -f "agy --remote-control" 2>/dev/null || true
    fuser -k 4400/tcp 2>/dev/null || true
    sleep 0.5

    echo "✓ Stopped. Remote server is OFFLINE."
    ;;

  restart)
    if [[ -x "$HOME/.local/bin/agy-auth" ]]; then
      "$HOME/.local/bin/agy-auth" select-best
      "$HOME/.local/bin/agy-auth" rotate --start
    fi

    echo "Restarting Antigravity remote server ($SERVICE)..."
    systemctl --user restart "$SERVICE"
    sleep 2.5
    if systemctl --user is-active --quiet "$SERVICE"; then
      echo "✓ Restarted successfully! Remote server is ONLINE ('homeserver-mini')."
    else
      echo "✗ Failed to restart. Check status with 'agy-status' or 'agy-logs'."
      exit 1
    fi
    ;;

  status)
    if [[ -x "$HOME/.local/bin/agy-auth" ]]; then
      "$HOME/.local/bin/agy-auth" rotate --status
    fi

    echo ""
    echo "--- Official Remote Control Status ---"
    if [[ -x "$HOME/.local/bin/agy" ]]; then
      "$HOME/.local/bin/agy" remote-control status 2>/dev/null || systemctl --user status "$SERVICE" --no-pager -l
    else
      systemctl --user status "$SERVICE" --no-pager -l
    fi

    echo ""
    echo "--- Active Account Check ---"
    if [[ -f "$HOME/.ag-switchboard/active.json" ]]; then
      echo "Active configured: $(cat "$HOME/.ag-switchboard/active.json")"
    fi

    echo ""
    echo "--- Recent Daemon Output (journalctl) ---"
    journalctl --user -u "$SERVICE" -n 15 --no-pager 2>/dev/null || true
    ;;

  logs)
    echo "Streaming logs for $SERVICE (Press Ctrl+C to stop)..."
    journalctl --user -u "$SERVICE" -f
    ;;

  help|--help|-h)
    show_help
    ;;

  *)
    echo "Unknown command: $ACTION"
    show_help
    exit 1
    ;;
esac
