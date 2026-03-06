# ScreenHand Profile: Cursor

## Session Start
1. Call `supervisor_status` — if no supervisor running, call `supervisor_start`
2. Call `session_claim` for your target app
3. Call `memory_snapshot` for current state and patterns

## Action Loop
1. Observe with `ui_tree` before acting
2. Execute one action, verify, then proceed
3. Call `session_heartbeat` every 60 seconds
4. Use `browser_*` tools for web-based workflows (Cursor has good CDP awareness)

## On Error
1. Check `memory_query_errors` for known fixes
2. Let the fallback chain handle method selection
3. After 3 failures, record the error and try a different approach

## On Stall
1. Re-read `ui_tree`
2. Try `screenshot` if AX tree looks stale
3. Call `recovery_queue_add` if truly stuck

## Long Run Rules
- Cursor retains good context — snapshot at session start is usually sufficient
- Call `session_release` when done
- Prefer AX tools for desktop apps, CDP tools for browser tabs

## Cursor-Specific Notes
- Cursor integrates MCP tools inline with code editing — it may interleave ScreenHand calls with file edits
- It has strong awareness of web technologies — leverage `browser_*` tools for React/web app automation
- For Cursor-specific editor automation, use `key` combos (Cmd+Shift+P for command palette)
