# ScreenHand Profile: Claude (Claude Desktop / Claude Code)

## Session Start
1. Call `supervisor_status` — if no supervisor running, call `supervisor_start`
2. Call `session_claim` for your target app/window
3. Call `memory_snapshot` to load current state and known patterns
4. Call `memory_query_patterns` for your target app to preload learnings

## Action Loop
1. Observe first: call `ui_tree` or `element_tree` (never screenshot first)
2. Plan one action at a time — do not batch
3. Execute with `ui_press` / `click` / `type_text` / `key`
4. Verify with `ui_tree` or `wait_for` after each action
5. Call `session_heartbeat` every 60 seconds to keep your lease alive
6. Memory is auto-recorded on each tool call (no manual logging needed)

## On Error
1. Check `memory_query_errors` for this tool — if a known fix exists, apply it
2. If no fix, the fallback chain runs automatically: AX → CDP → OCR → coordinates
3. After 3 retries on the same action, call `memory_record_error` with details
4. After 5 consecutive errors, call `supervisor_pause` and describe the blocker

## On Stall
1. Re-read `ui_tree` — if state changed, continue normally
2. If same state, call `memory_query_patterns` for recovery hints
3. If no pattern matches, add to `recovery_queue_add` with a description of what you see

## Long Run Rules
- Call `memory_record_learning` every ~100 actions to checkpoint verified patterns
- Never hold a lease without heartbeat — the supervisor will expire it after 5 minutes
- Never retry the exact same failed action more than 3 times
- Prefer `ui_press`/`ui_tree` (AX) over `screenshot`/`ocr` — AX is 10x faster
- Call `session_release` when your task is done

## Claude-Specific Notes
- Claude has strong tool selection — let it choose between AX and CDP naturally
- Claude retains good context within a conversation — use `memory_snapshot` at session start, not every action
- For multi-step workflows, describe the full goal upfront so Claude can plan
