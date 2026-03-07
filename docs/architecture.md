# ScreenHand Architecture

## Source of Truth

The canonical MCP server is **`mcp-desktop.ts`** (project root).
It registers all 50+ tools directly and exposes ScreenHand as a unified runtime.

## Design Principles

1. **ScreenHand = runtime + memory + supervisor** — clients are planners only
2. **One canonical execution contract**: AX/UIA → CDP → OCR → coordinates
3. **Memory exposed through MCP tools** — no raw file access for clients
4. **Lease/lock system** — one client per window, heartbeat-based expiry
5. **Client profiles** — different instruction layers, same runtime

## Layers

```
AI Client (Claude / Codex / Cursor / OpenClaw)
    │  Loaded with client profile (profiles/*.md)
    │
    ▼  MCP protocol (stdio)
mcp-desktop.ts — canonical MCP server
    │
    ├── Memory Service (src/memory/service.ts)
    │     state.json      — current session snapshot
    │     events/actions   — append-only timeline
    │     errors.jsonl     — normalized failures
    │     learnings.jsonl  — verified patterns
    │     strategies.jsonl — successful sequences
    │
    ├── Session Supervisor (src/supervisor/)
    │     locks/           — one file per window lease
    │     state.json       — supervisor health
    │     recoveries.json  — pending recovery actions
    │
    ├── Execution Engine (src/runtime/execution-contract.ts)
    │     AX/UIA (~50ms) → CDP (~10ms) → OCR (~600ms) → Coordinates
    │
    ├── Native Bridge (BridgeClient → JSON-RPC → Swift/C#)
    │     Accessibility, CoreGraphics, Vision, SendInput
    │
    └── Chrome CDP (browser_* tools)
          DevTools Protocol for browser automation
```

## Execution Contract

Every action follows this fallback chain:

| Priority | Method | Speed | Can Click | Can Type | Can Read | Requires |
|----------|--------|-------|-----------|----------|----------|----------|
| 1 | AX/UIA | ~50ms | Yes | Yes | Yes | Native bridge |
| 2 | CDP | ~10ms | Yes | Yes | Yes | Chrome CDP |
| 3 | OCR | ~600ms | No | No | Yes | Native bridge |
| 4 | Coordinates | ~50ms | Yes | No | No | Native bridge |

Retry policy: 2 retries per method, 5 total, escalate to supervisor after 3.

## Memory Service

Multi-file persistence with in-memory caching:

| File | Purpose | Format |
|------|---------|--------|
| `state.json` | Current session snapshot (small, debounced) | JSON |
| `actions.jsonl` | Every action taken | Append JSONL, rotate at 10MB |
| `errors.jsonl` | Failures + resolutions | JSONL, LRU 200 |
| `strategies.jsonl` | Successful sequences | JSONL, LRU 500 |
| `learnings.jsonl` | Verified patterns (scope/method/confidence) | JSONL, LRU 1000 |

MCP tools: `memory_snapshot`, `memory_recall`, `memory_save`, `memory_record_error`,
`memory_record_learning`, `memory_query_patterns`, `memory_errors`, `memory_stats`, `memory_clear`

## Session Supervisor

Client-agnostic session management:

- **Lease system**: `session_claim` → `session_heartbeat` → `session_release`
- **Stall detection**: compares heartbeat timestamps against threshold
- **Auto-recovery**: nudge → restart → escalate based on blocker patterns
- **One client per window**: filesystem locks in `~/.screenhand/locks/`

MCP tools: `session_claim`, `session_heartbeat`, `session_release`,
`supervisor_status`, `supervisor_start`, `supervisor_stop`, `supervisor_pause`, `supervisor_resume`,
`recovery_queue_add`, `recovery_queue_list`

## Client Profiles

Located in `profiles/`. Each profile instructs a specific AI client how to use ScreenHand:
- Session lifecycle (claim → heartbeat → release)
- Action loop (observe → act → verify)
- Error handling and fallback behavior
- Long-run rules (checkpoint frequency, retry limits)

Profiles: `claude.md`, `codex.md`, `cursor.md`, `openclaw.md`

## File Map

```
mcp-desktop.ts              ← Canonical MCP server (50+ tools)
src/memory/service.ts        ← MemoryService (unified facade)
src/memory/store.ts          ← JSONL persistence + caching
src/memory/session.ts        ← Session tracking + auto-save
src/memory/recall.ts         ← Strategy/error recall engine
src/supervisor/supervisor.ts ← SessionSupervisor
src/supervisor/locks.ts      ← LeaseManager (filesystem locks)
src/supervisor/types.ts      ← Supervisor types
src/runtime/execution-contract.ts ← Fallback chain + retry policy
src/runtime/                 ← Service + adapters
src/native/                  ← BridgeClient
src/agent/                   ← Autonomous agent loop
src/playbook/                ← Playbook engine + recorder
scripts/                     ← Daemon, watchers, ops scripts
native/                      ← Swift + C# native bridge source
profiles/                    ← Client instruction profiles
```
