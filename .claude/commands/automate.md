Automate a desktop workflow described by the user.

The user will describe what they want done: $ARGUMENTS

Plan and execute the workflow step by step using the desktop automation MCP tools:

## Planning
1. Break the task into discrete steps
2. Identify which apps are involved (`apps`, `windows`)
3. For each step, pick the FASTEST approach — try them in this order:
   - **Accessibility (FASTEST — always try first)**: `ui_tree` → `ui_find` → `ui_press` / `ui_set_value`. ~50ms per action, no screenshots.
   - **Keyboard shortcuts**: `key` for known shortcuts (cmd+s, cmd+c, etc.) — instant
   - **AppleScript**: `applescript` for scriptable apps (Finder, Mail, Notes) — fast
   - **Chrome CDP**: `browser_dom` → `browser_click` / `browser_type` — direct DOM, no vision
   - **Visual (LAST RESORT only)**: `screenshot` → `click_text` — slow, only when Accessibility can't see the element (canvas, games, images)

IMPORTANT: Do NOT use screenshot/OCR/click_text to interact with standard UI elements. Use ui_tree + ui_press instead — it's 10x faster and more reliable.

## Execution
- Execute each step, verifying success before moving to the next
- After key actions, use `screenshot` or `ui_tree` to confirm the expected state
- If a step fails, try an alternative approach before giving up
- Report progress as you go

## Completion
- Summarize what was done
- Note any steps that required fallbacks
- Flag anything that didn't work as expected
