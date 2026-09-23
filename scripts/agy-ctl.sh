#!/bin/bash
# Antigravity Remote Control Daemon Controller
# Connected to official systemd user service: agy-remote-control.service

SERVICE="agy-remote-control.service"
LOG_FILE="$HOME/.antigravity/agy_daemon.log"

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

    # Clean any stale orphan processes holding port 4400 before start
    fuser -k 4400/tcp 2>/dev/null || true

    if systemctl --user is-active --quiet "$SERVICE"; then
      echo "Antigravity remote server is already running (ONLINE)."
      systemctl --user status "$SERVICE" --no-pager -l | head -n 8
    else
      echo "Starting Antigravity remote server..."
      systemctl --user start "$SERVICE"
      sleep 2
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

    echo "Stopping Antigravity remote server..."
    systemctl --user stop "$SERVICE" 2>/dev/null || true

    # Sweep cleanup: guarantee zero orphan/rogue processes linger
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

    echo "Restarting Antigravity remote server..."
    systemctl --user stop "$SERVICE" 2>/dev/null || true
    pkill -f "agy --remote-control" 2>/dev/null || true
    fuser -k 4400/tcp 2>/dev/null || true
    sleep 1

    systemctl --user start "$SERVICE"
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
    systemctl --user status "$SERVICE" --no-pager -l

    echo ""
    echo "--- Port 4400 & Active Process Check ---"
    PORT_PID=$(lsof -t -i:4400 2>/dev/null || ss -tulpn 2>/dev/null | grep ':4400 ' | awk -F'pid=' '{print $2}' | awk -F',' '{print $1}')
    if [[ -n "$PORT_PID" ]]; then
      echo "Port 4400 is held by PID: $PORT_PID"
      ps -fp "$PORT_PID" 2>/dev/null || true
    else
      echo "Port 4400 is FREE (no process listening)."
    fi

    echo ""
    echo "--- Active Account Check ---"
    if [[ -f "$HOME/.ag-switchboard/active.json" ]]; then
      echo "Active configured: $(cat "$HOME/.ag-switchboard/active.json")"
    fi

    echo ""
    echo "--- Recent Daemon Output ($LOG_FILE) ---"
    if [[ -f "$LOG_FILE" ]]; then
      tail -n 15 "$LOG_FILE"
    else
      echo "Log file not found."
    fi
    ;;

  logs)
    if [[ -f "$LOG_FILE" ]]; then
      echo "Streaming logs from $LOG_FILE (Press Ctrl+C to stop)..."
      tail -f -n 30 "$LOG_FILE"
    else
      journalctl --user -u "$SERVICE" -f
    fi
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
