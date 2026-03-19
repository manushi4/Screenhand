# ScreenHand — Full Tool Reference

ScreenHand exposes 111 MCP tools. This document is the complete reference.

## Desktop Control (19 tools)

See, read, and interact with any native application.

| Tool | What it does | Speed |
|------|-------------|-------|
| `screenshot` | Full screenshot + OCR — returns all visible text | ~600ms |
| `screenshot_file` | Screenshot saved to file (for viewing the image) | ~400ms |
| `ocr` | OCR with element positions and bounding boxes | ~600ms |
| `apps` | List running apps with bundle IDs and PIDs | ~10ms |
| `windows` | List visible windows with positions and sizes | ~10ms |
| `focus` | Bring an app to the front | ~10ms |
| `launch` | Launch an app by bundle ID or name | ~1s |
| `ui_tree` | Full UI element tree — instant, no OCR needed | ~50ms |
| `ui_find` | Find a UI element by text or title | ~50ms |
| `ui_press` | Click a UI element by its title | ~50ms |
| `ui_set_value` | Set value of a text field, slider, etc. | ~50ms |
| `menu_click` | Click a menu bar item by path | ~100ms |
| `click` | Click at screen coordinates | ~50ms |
| `click_text` | Find text via OCR and click it | ~600ms |
| `type_text` | Type text via keyboard (auto-chunks >500 chars) | ~30ms |
| `key` | Key combo (e.g. `cmd+s`, `ctrl+shift+n`) | ~10ms |
| `drag` | Drag from point A to B | ~100ms |
| `scroll` | Scroll at a position | ~50ms |
| `applescript` | Run any AppleScript command (macOS only) | varies |

## Browser Automation (15 tools)

Control Chrome and Electron apps via DevTools Protocol. Works in the background — no focus needed.

| Tool | What it does |
|------|-------------|
| `browser_tabs` | List all open Chrome tabs |
| `browser_open` | Open URL in new tab |
| `browser_navigate` | Navigate active tab to URL |
| `browser_js` | Run JavaScript in a tab |
| `browser_dom` | Query DOM with CSS selectors |
| `browser_click` | Click element by CSS selector |
| `browser_type` | Type into an input field (React-compatible) |
| `browser_wait` | Wait for a page condition |
| `browser_page_info` | Get page title, URL, and content |
| `browser_stealth` | Anti-detection patches (hides webdriver flag) |
| `browser_fill_form` | Human-like typing with random delays |
| `browser_human_click` | Realistic mouse event sequence |

All browser tools accept optional `cdpPort` for Electron apps (e.g. `cdpPort: 9333` for Codex Desktop).

## Smart Fallback Execution (8 tools)

Automatically try AX → CDP → OCR → coordinates to find the best method.

| Tool | What it does |
|------|-------------|
| `execution_plan` | Generate an execution plan for a task |
| `click_with_fallback` | Click using the best available method |
| `type_with_fallback` | Type using the best available method |
| `read_with_fallback` | Read content using the best available method |
| `locate_with_fallback` | Find an element using the best available method |
| `select_with_fallback` | Select an option using the best available method |
| `scroll_with_fallback` | Scroll using the best available method |
| `wait_for_state` | Wait for a UI state using the best available method |

## Memory & Learning (14 tools)

Gets smarter every session — zero config, zero latency overhead.

| Tool | What it does |
|------|-------------|
| `memory_snapshot` | Current memory state snapshot |
| `memory_recall` | Search past strategies by task description |
| `memory_save` | Save the current session as a strategy |
| `memory_record_error` | Record an error pattern with a fix |
| `memory_record_learning` | Record a verified pattern |
| `memory_query_patterns` | Search learnings by scope and method |
| `memory_errors` | View all known error patterns and resolutions |
| `memory_stats` | Action counts, success rates, top tools, disk usage |
| `memory_clear` | Clear actions, strategies, errors, or all data |
| `learning_status` | Learning engine state — policies, confidence scores |
| `learning_reset` | Reset learning data for a scope |
| `recovery_status` | Recovery engine state — active detectors, strategies |
| `recovery_configure` | Configure recovery behavior |
| `coverage_report` | Tool coverage audit |

## Platform Knowledge (6 tools)

Curated automation knowledge per app/website — selectors, flows, error solutions.

| Tool | What it does |
|------|-------------|
| `platform_guide` | Get automation guide for a platform |
| `playbook_preflight` | Pre-flight check for a URL (CAPTCHAs, shadow DOM, SPA) |
| `playbook_record` | Record tool calls into a reusable playbook |
| `export_playbook` | Auto-generate a playbook from your session |
| `platform_explore` | Discover all UI elements in an app or website |
| `platform_learn` | Scrape official docs to build references |

## Ingestion (3 tools)

Import external documentation and tutorials into ScreenHand's knowledge base.

| Tool | What it does |
|------|-------------|
| `scan_menu_bar` | Discover all menu items in an app |
| `ingest_documentation` | Parse docs into reference format |
| `ingest_tutorial` | Extract tutorial steps from web pages |

## Jobs & Worker (15 tools)

Queue multi-step automation and let a background daemon process them.

| Tool | What it does |
|------|-------------|
| `job_create` | Create a job with steps |
| `job_create_chain` | Create a chain of dependent jobs |
| `job_status` | Get job status |
| `job_list` | List jobs by state |
| `job_transition` | Change job state |
| `job_step_done` | Mark a step as done |
| `job_step_fail` | Mark a step as failed |
| `job_resume` | Resume a blocked job |
| `job_dequeue` | Dequeue next queued job |
| `job_remove` | Remove a job |
| `job_run` | Execute a single queued job |
| `job_run_all` | Process all queued jobs |
| `worker_start` | Start background worker daemon |
| `worker_stop` | Stop worker daemon |
| `worker_status` | Worker daemon status |

Job state machine: `queued → running → done | failed | blocked | waiting_human`

## Session Supervisor (12 tools)

Multi-agent coordination with lease-based window locking.

| Tool | What it does |
|------|-------------|
| `session_claim` | Claim exclusive control of an app window |
| `session_heartbeat` | Keep your lease alive |
| `session_release` | Release your session lease |
| `supervisor_status` | Active sessions, health metrics |
| `supervisor_start` | Start supervisor daemon |
| `supervisor_stop` | Stop supervisor daemon |
| `supervisor_pause` | Pause monitoring |
| `supervisor_resume` | Resume monitoring |
| `supervisor_install` | Install as launchd service (macOS) |
| `supervisor_uninstall` | Uninstall launchd service |
| `recovery_queue_add` | Add a recovery action |
| `recovery_queue_list` | List pending recovery actions |

## Perception & World Model (5 tools)

Continuous screen awareness via multi-rate perception loop.

| Tool | What it does |
|------|-------------|
| `perception_start` | Start 3-rate loop (FAST 100ms / MEDIUM 300ms / SLOW 1s) |
| `perception_stop` | Stop perception loop |
| `perception_status` | Cycle counts, source health |
| `world_state` | Current world model — apps, windows, controls, focus |
| `world_state_diff` | Changes since last query |

## Goal Planning (7 tools)

Autonomous goal decomposition and execution.

| Tool | What it does |
|------|-------------|
| `plan_goal` | Set a goal — planner decomposes into steps |
| `plan_execute` | Execute plan with automatic recovery |
| `plan_step` | Execute a single step |
| `plan_step_resolve` | Manually resolve a blocked step |
| `plan_status` | Plan state and progress |
| `plan_list` | List all plans |
| `plan_cancel` | Cancel an active plan |

## Orchestrator & Observer (7 tools)

Parallel task execution and background popup detection.

| Tool | What it does |
|------|-------------|
| `orchestrator_start` | Start parallel orchestrator |
| `orchestrator_submit` | Submit a task to the queue |
| `orchestrator_status` | Active slots, queue depth |
| `orchestrator_stop` | Graceful shutdown |
| `observer_start` | Start popup/dialog detection |
| `observer_status` | Check detected popups |
| `observer_stop` | Stop observer |
| `observer_ocr_roi` | OCR a specific region |

## Community (2 tools)

Share and fetch playbooks from the community.

| Tool | What it does |
|------|-------------|
| `community_publish` | Publish a validated playbook |
| `community_fetch` | Fetch community playbooks for a platform |
