# ScreenHand Profile: OpenClaw

## Session Start
1. Call `supervisor_status` — if no supervisor running, call `supervisor_start`
2. Call `session_claim` for your target app
3. Call `memory_snapshot` for current state

## Action Loop
1. IMPORTANT: Use `ui_press` / `ui_tree` instead of OpenClaw's built-in Clawd Cursor
   - Clawd Cursor: screenshot → LLM → coordinate click (~3-5s, costs API call)
   - ScreenHand AX: `ui_press("Send")` → native click (~50ms, free)
2. Execute one action, verify with `ui_tree`, then proceed
3. Call `session_heartbeat` every 60 seconds

## On Error
1. Check `memory_query_errors` first
2. If AX fails, fall back to `click_text` (OCR-based) rather than Clawd Cursor
3. Use coordinates only as last resort
4. Record errors with `memory_record_error`

## On Stall
1. Re-read `ui_tree`
2. If stale, try `screenshot` + `ocr`
3. Call `recovery_queue_add` if blocked

## Long Run Rules
- Call `memory_snapshot` every ~30 actions (OpenClaw has variable context retention)
- Keep sessions focused on one app at a time
- Call `session_release` when switching tasks

## OpenClaw-Specific Notes
- OpenClaw already has desktop control (Clawd Cursor) — ScreenHand replaces the execution layer, not the planning
- Disable Clawd Cursor's screenshot-based clicking when ScreenHand is available
- OpenClaw's skill system can be mapped to ScreenHand playbooks via `playbook_run`
- For sites with bot detection, use `browser_stealth` + `browser_human_click` instead of coordinate clicks
