#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${1:-codex-night}"
WORKDIR="${2:-/Users/khushi/Documents/Automator/mvp}"
SESSION_ID="${3:-${CODEX_SESSION_ID:-}}"
LOG_DIR="${CODEX_TMUX_LOG_DIR:-$WORKDIR/.logs}"
LOG_FILE="${CODEX_TMUX_LOG_FILE:-$LOG_DIR/${SESSION_NAME}.log}"
ALLOW_DUPLICATE="${CODEX_TMUX_ALLOW_DUPLICATE:-0}"

if [[ -n "${CODEX_TMUX_CMD:-}" ]]; then
  CODEX_CMD="$CODEX_TMUX_CMD"
elif [[ -n "$SESSION_ID" ]]; then
  CODEX_CMD="codex resume --dangerously-bypass-approvals-and-sandbox --no-alt-screen -C $WORKDIR $SESSION_ID"
else
  CODEX_CMD="codex -C $WORKDIR --dangerously-bypass-approvals-and-sandbox --no-alt-screen"
fi

mkdir -p "$LOG_DIR"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session already exists: $SESSION_NAME"
  echo "attach: bash scripts/attach-codex-tmux.sh $SESSION_NAME"
  exit 0
fi

if [[ "$ALLOW_DUPLICATE" != "1" ]]; then
  existing="$(pgrep -af "codex .*${WORKDIR}" || true)"
  if [[ -n "$existing" ]]; then
    echo "Refusing to launch a second Codex in $WORKDIR while another Codex is already running:" >&2
    echo "$existing" >&2
    echo "If you really want a second one, rerun with CODEX_TMUX_ALLOW_DUPLICATE=1" >&2
    exit 2
  fi
fi

tmux new-session -d -s "$SESSION_NAME" -c "$WORKDIR"
tmux set-option -t "$SESSION_NAME" remain-on-exit on
tmux pipe-pane -o -t "${SESSION_NAME}:0.0" "cat >> '$LOG_FILE'"
tmux send-keys -t "${SESSION_NAME}:0.0" "clear" C-m
tmux send-keys -t "${SESSION_NAME}:0.0" "$CODEX_CMD" C-m

echo "Started Codex tmux session: $SESSION_NAME"
echo "Log file: $LOG_FILE"
if [[ -n "$SESSION_ID" ]]; then
  echo "Resumed session: $SESSION_ID"
fi
echo "Peek: bash scripts/peek-codex-tmux.sh $SESSION_NAME"
echo "Attach: bash scripts/attach-codex-tmux.sh $SESSION_NAME"
