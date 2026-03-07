#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${1:-codex-night}"
exec tmux attach -t "$SESSION_NAME"
