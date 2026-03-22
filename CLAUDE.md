# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ScreenHand is an MCP server that gives AI agents native desktop control on macOS and Windows. TypeScript MCP layer on top of native accessibility bridges (Swift/C#) communicating via JSON-RPC over stdio. 111 MCP tools spanning desktop automation, browser control (Chrome + Electron via CDP), anti-detection, memory, supervisor, jobs, playbooks, planning, perception, learning, recovery, and multi-agent orchestration.

## Commands

```bash
npm run dev          # Run MCP server in dev mode (tsx mcp-desktop.ts)
npm run build        # Compile TypeScript -> dist/
npm run check        # Type-check without emitting (tsc --noEmit, covers src/ + both entry points)
npm test             # Run all tests (vitest, 1331 tests across 54 files, 15s timeout)
npm run test:watch   # Watch mode
npm test -- --grep "pattern"  # Run specific test by name
npm run build:native          # Build Swift accessibility bridge (macOS)
npm run build:native:windows  # Build .NET accessibility bridge (Windows)
npm run agent        # Run the agent CLI (tsx src/agent/cli.ts)
```

## Architecture

```
MCP Client (Claude, Cursor, etc.)
  | stdio (Model Context Protocol)
mcp-desktop.ts — Main MCP server, 111 tools (57 server.tool + 54 originalTool), Zod validation
  |
  +-- Intelligence Wrapper (lines 177-337)
  |     PRE-CALL:  quickErrorCheck → contextTracker.updateContext → getHints
  |     POST-CALL: recordEvent → recordOutcome → captureToolCall → quickStrategyHint
  |     Applied to: all server.tool() tools (52), skipped for originalTool() (36)
  |
  +-- AutomationRuntimeService (src/runtime/service.ts)
  |     +-- SessionManager — session lifecycle + resilient re-attach
  |     +-- Executor — press/typeInto with locate→act→verify pipeline
  |     +-- AppAdapter interface — pluggable backends
  |
  +-- Native Bridge (src/native/bridge-client.ts)
  |     Spawns platform binary, JSON-RPC over stdio
  |     +-- macOS: native/macos-bridge/ (Swift)
  |     +-- Windows: native/windows-bridge/ (C# .NET 8)
  |
  +-- CDP Chrome/Electron (ensureCDP in mcp-desktop.ts)
  |     Auto-probes ports 9222-9224, 9333. All browser_* tools accept cdpPort override.
  |
  +-- Context Tracker (src/context-tracker.ts)
  |     Auto-injects playbook hints on domain change (URL tools) AND bundleId change (native tools).
  |     Matches references/ by domain or bundleId. Learns selectors from successful tool calls.
  |
  +-- Perception Coordinator (src/perception/coordinator.ts)
  |     3-rate multi-source perception loop feeding the world model:
  |     +-- FAST  (100ms): AXSource.drainEvents → WorldModel.ingestUIEvents
  |     |                   CDPSource.drainMutations → WorldModel.ingestCDPMutations
  |     +-- MEDIUM (300ms): AXSource.pollAXTree → FusionPipeline → WorldModel.ingestAXTree
  |     |                   CDPSource.pollSnapshot → FusionPipeline → WorldModel.ingestCDPSnapshot
  |     |                   BrowserEnricher (Safari AppleScript) → WorldModel (best-effort)
  |     +-- SLOW (1000ms):  VisionSource.captureAndDiffOptimized → FrameDiffer
  |                         If changed: OCR → FusionPipeline → WorldModel.ingestOCRRegions
  |                         If unchanged: skip OCR (saves ~250ms)
  |     Config: DEFAULT_PERCEPTION_CONFIG in src/perception/types.ts (lines 107-116)
  |
  +-- FusionPipeline (src/state/fusion.ts)
  |     Deduplicates by source+windowId, flushes in timestamp order.
  |     Learning-adaptive confidence via LearningEngine.
  |
  +-- WorldModel + EntityTracker (src/state/)
  |     Per-session state: app, windows, controls, dialogs, focus, scroll.
  |     EntityTracker provides persistent cross-frame identity (label + window + 50px proximity).
  |
  +-- Session Supervisor (src/supervisor/) — lease management, stall detection, recovery
  +-- Job System (src/jobs/) — persistent multi-step jobs, worker daemon
  +-- Playbook Engine (src/playbook/) — reusable automation sequences
  +-- Memory Service (src/memory/) — JSONL learning, recall, error patterns + playbook seeds
  +-- Logging (src/logging/) — timeline logger, action telemetry
```

## Key Entry Points

- **`mcp-desktop.ts`** — Main MCP server. Production entry point. 111 tools. Hardcodes AccessibilityAdapter.
- **`mcp-bridge.ts`** — Bridge-only MCP server (17 low-level native tools).
- **`src/mcp-entry.ts`** — Modular MCP server, supports adapter selection via env vars. Smaller tool subset.
- **`src/index.ts`** — Library entry point. Exports `createRuntimeApp()` and all adapters.
- **`src/agent/cli.ts`** — Standalone agent CLI with planning loop.

## MCP Tool Groups (mcp-desktop.ts)

Tools use two registration patterns:
- **`server.tool()`** (57 tools) — goes through the intelligence wrapper (memory hints, playbook context, error warnings, strategy suggestions, action logging, playbook recording).
- **`originalTool()`** (54 tools) — bypasses wrapper. Used for memory, supervisor, job, planning, perception, learning, recovery, and daemon lifecycle tools to avoid recursion.

### Tools with intelligence wrapper (server.tool):

- **Desktop** (19): `apps`, `windows`, `focus`, `launch`, `screenshot`, `screenshot_file`, `ocr`, `ui_tree`, `ui_find`, `ui_press`, `ui_set_value`, `menu_click`, `click`, `click_text`, `type_text`, `key`, `drag`, `scroll`, `applescript`
- **Browser** (12): `browser_tabs`, `browser_open`, `browser_navigate`, `browser_js`, `browser_dom`, `browser_click`, `browser_type`, `browser_wait`, `browser_page_info`, `browser_stealth`, `browser_fill_form`, `browser_human_click`
  - All browser tools accept optional `cdpPort` param for Electron apps (e.g. `cdpPort: 9333` for Codex Desktop)
- **Fallback execution** (8): `click_with_fallback`, `type_with_fallback`, `scroll_with_fallback`, `select_with_fallback`, `read_with_fallback`, `locate_with_fallback`, `execution_plan`, `wait_for_state`
- **Platform knowledge** (6): `platform_guide`, `playbook_preflight`, `export_playbook`, `playbook_record`, `platform_learn`, `platform_explore`
- **Observer/Orchestrator** (7): `observer_start`, `observer_stop`, `observer_status`, `orchestrator_start`, `orchestrator_stop`, `orchestrator_submit`, `orchestrator_status`
- **Platform ingestion** (3): `scan_menu_bar`, `ingest_documentation`, `ingest_tutorial`
- **Community** (2): `community_publish`, `community_fetch`

### Tools without wrapper (originalTool):

- **Memory** (9): `memory_save`, `memory_recall`, `memory_snapshot`, `memory_stats`, `memory_clear`, `memory_errors`, `memory_query_patterns`, `memory_record_error`, `memory_record_learning`
- **Supervisor** (12): `session_claim`, `session_heartbeat`, `session_release`, `supervisor_status`, `supervisor_start`, `supervisor_stop`, `supervisor_pause`, `supervisor_resume`, `supervisor_install`, `supervisor_uninstall`, `recovery_queue_add`, `recovery_queue_list`
- **Jobs** (15): `job_create`, `job_create_chain`, `job_list`, `job_status`, `job_run`, `job_run_all`, `job_dequeue`, `job_step_done`, `job_step_fail`, `job_transition`, `job_resume`, `job_remove`, `worker_start`, `worker_status`, `worker_stop`
- **Planning** (7): `plan_goal`, `plan_execute`, `plan_step`, `plan_step_resolve`, `plan_status`, `plan_list`, `plan_cancel`
- **Perception** (5): `perception_status`, `perception_start`, `perception_stop`, `world_state`, `world_state_diff`
- **Learning/Recovery** (4): `learning_status`, `learning_reset`, `recovery_status`, `recovery_configure`
- **Coverage** (1): `coverage_report`

## Intelligence Wrapper Pipeline

Every `server.tool()` call (57 tools) goes through this automatic pipeline:

```
PRE-CALL:
  1. quickErrorCheck(toolName)        → warns if this tool has failed before + shows fix
  2. contextTracker.updateContext()    → loads reference on domain change (URL) or bundleId change (native)
  3. contextTracker.getHints()         → selector suggestions, known errors, executable playbook hints

POST-CALL (success):
  4. memory.recordEvent()             → logs to actions.jsonl
  5. contextTracker.recordOutcome()    → learns which selectors work (promotes after 2+ successes)
  6. mcpRecorder.captureToolCall()     → records into playbook if recording is active
  7. quickStrategyHint()              → suggests next step if current tool sequence matches a saved strategy

POST-CALL (failure):
  8. memory.appendError()             → records error pattern
  9. backgroundResearch()             → auto-searches for fix via Claude/DuckDuckGo (non-blocking)
```

Context tracking triggers on:
- **URL tools** (`browser_open`, `browser_navigate`) — extracts domain, matches `references/{platform}.json` by domain/urlPatterns
- **Native tools** (`focus`, `launch`, `ui_*`, `menu_click`, `*_with_fallback`) — extracts `bundleId`, matches references by `bundleId` field or platform name

## Critical Patterns

- **Session resilience**: MCP servers restart between tool calls, losing in-memory state. `SessionManager.requireSessionResilent()` auto-recreates sessions by re-attaching with the same session ID. All `AutomationRuntimeService` methods use this — never use `requireSession()` directly.
- **reuseSessionId**: All adapters accept `attach(profile, reuseSessionId?)` to restore a session with the same ID after restart. Session ID prefixes: `ax_session_` (accessibility), `cdp_session_` (CDP), `as_session_` (AppleScript), `vision_session_` (vision).
- **CDP port override**: `ensureCDP(overridePort?)` accepts optional port. All browser_* tools expose this as `cdpPort` param. Auto-probes `[9222, 9223, 9224, 9333]` if no override.
- **Fallback chains**: `*_with_fallback` tools try AX → CDP → OCR automatically. Now wrapped with intelligence layer for hints/logging.
- **Budget-aware execution**: Default 800ms locate, 200ms act, 2000ms verify, 1 retry (see `src/config.ts`).
- **Supervisor daemon**: `scripts/supervisor-daemon.ts` runs as detached background process. Supports `--dry-run`, `--poll`, `--stall` flags. Can be installed as launchd service on macOS.
- **Worker daemon**: `scripts/worker-daemon.ts` background job processor. Dequeues and executes jobs independently of MCP client.
- **Atomic writes**: All filesystem state (`writeFileAtomicSync` in `src/util/atomic-write.ts`) uses write-to-tmp + rename pattern to prevent corruption.
- **Perception timer pileup fix**: `setInterval` fires even if the previous async cycle has not completed, which can saturate the native bridge during latency spikes. Fixed in `src/perception/coordinator.ts` with per-loop in-flight boolean guards (`fastInFlight`, `mediumInFlight`, `slowInFlight`) — if a cycle is still running, the next interval tick is a no-op. Additionally, `switchContext()` is debounced by 150ms to coalesce rapid app switches (e.g. cmd-tabbing through multiple apps) into a single stop+start cycle. `cdpConsecutiveFailures` is reset in `start()` so CDP polling resumes after a context switch.

## Reference Files

`references/` directory holds curated platform knowledge (selectors, flows, errors, detection). These are auto-loaded by the context tracker when a matching domain or bundleId is detected.

Key fields in reference JSON:
- `platform` — platform name for matching
- `bundleId` — macOS bundle ID for native app matching (e.g. `"com.blackmagic-design.DaVinciResolveLite"`)
- `cdpPort` — default CDP port for this platform (e.g. `9333` for Codex Desktop)
- `urlPatterns` — URL patterns for web platform matching
- `selectors` — stable CSS/AX selectors grouped by feature area
- `flows` — named automation flows with human-readable steps
- `errors` — known error patterns with solutions

## Adapter System

All adapters implement `AppAdapter` (src/runtime/app-adapter.ts):
- **AccessibilityAdapter** — macOS AX API via native Swift bridge. Default in mcp-desktop.ts.
- **CdpChromeAdapter** — Chrome DevTools Protocol. Launches Chrome, manages profiles.
- **CompositeAdapter** — Routes to AX or CDP per app. Needs `SCREENHAND_ADAPTER=composite`.
- **AppleScriptAdapter** — Scriptable macOS apps (Finder, Safari, Mail, etc.).
- **VisionAdapter** — OCR-based fallback via native bridge.
- **PlaceholderAppAdapter** — Stubs for testing.

## Environment Variables

- `SCREENHAND_ADAPTER` — Used by `mcp-entry.ts` and `agent/cli.ts`: `accessibility` (default), `composite`, `cdp`, `placeholder`
- `SCREENHAND_HEADLESS` — Set `"1"` for headless Chrome (mcp-entry.ts)
- `AUTOMATOR_ADAPTER` / `AUTOMATOR_HEADLESS` — Legacy aliases in `src/index.ts`
- `ANTHROPIC_API_KEY` — Optional, enables Claude-powered background research on errors

## Native Bridge Protocol

Both macOS (Swift) and Windows (C#) bridges use identical JSON-RPC over stdio. BridgeClient handles spawning, request/response mapping, and reconnection. Method timeouts: app.launch=30s, vision.ocr=20s, default=10s.

## TypeScript Config

- Target: ES2022, Module: NodeNext, strict mode
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled
- `tsconfig.json` — build config (emits to dist/), includes scripts/
- `tsconfig.check.json` — check-only config, includes mcp-bridge.ts
- Tests: vitest 3.2.4, config in vitest.config.ts, 38 test files in tests/

## License

AGPL-3.0-only — Copyright (C) 2025 Clazro Technology Private Limited
