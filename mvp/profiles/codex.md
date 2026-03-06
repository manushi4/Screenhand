# ScreenHand Profile: Codex (OpenAI Codex CLI)

## Session Start
1. Call `supervisor_status` — if no supervisor running, call `supervisor_start`
2. Call `session_claim` for VS Code or your target app
3. Call `memory_snapshot` to load current state

## Action Loop
1. Always call `ui_tree` first to understand what's on screen
2. Execute one action at a time
3. Verify the result before moving to the next step
4. Call `session_heartbeat` every 60 seconds

## On Error
1. Check `memory_query_errors` for known fixes
2. Codex tends to retry aggressively — limit to 3 retries per action
3. After 3 failures, call `memory_record_error` and try a different approach
4. If stuck, call `recovery_queue_add` with what you're seeing

## On Stall
1. Re-read `ui_tree` to check if anything changed
2. If no change, try `screenshot` + `ocr` as a visual check
3. If still stuck, call `supervisor_pause`

## Long Run Rules
- Codex has shorter context windows — call `memory_snapshot` periodically (every ~50 actions)
- Keep task descriptions short and specific
- Call `session_release` when done
- Never hold multiple leases simultaneously

## Codex-Specific Notes
- Codex works best with explicit, step-by-step instructions
- It may not automatically choose the best tool — guide it with `ui_tree` first, then act
- For terminal-based workflows, prefer `type_text` + `key` over `ui_press`
- Codex may not handle complex multi-window workflows well — keep to one window per session
