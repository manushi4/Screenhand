#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${1:-codex-night}"
LINES="${LINES:-200}"
WORKDIR="${2:-/Users/khushi/Documents/Automator/mvp}"
LOG_FILE="${CODEX_TMUX_LOG_FILE:-$WORKDIR/.logs/${SESSION_NAME}.log}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux capture-pane -p -t "${SESSION_NAME}:0.0" -S "-${LINES}"
  exit 0
fi

if [[ -f "$LOG_FILE" ]]; then
  tail -n "$LINES" "$LOG_FILE"
  exit 0
fi

echo "No tmux session or log found for ${SESSION_NAME}" >&2
exit 1
