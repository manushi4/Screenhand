# ScreenHand Architecture

## Source of Truth

The canonical MCP server is **`mcp-desktop.ts`** (project root, ~1470 lines).
It registers all 40+ tools directly and talks to the native bridge via `BridgeClient`.

A secondary modular entrypoint exists at `src/mcp-entry.ts` with a smaller tool subset
routed through `AutomationRuntimeService`. It's kept for adapter experimentation.

## Layers

```
AI Client (Claude, Cursor, Codex CLI, etc.)
    ↓ MCP protocol (stdio)
mcp-desktop.ts — monolithic MCP server (TypeScript)
    ↓ JSON-RPC (stdio)
Native Bridge (Swift on macOS / C# on Windows)
    ↓ Platform APIs
Operating System (Accessibility, CoreGraphics, UI Automation, SendInput)
```

### 1. MCP Server (`mcp-desktop.ts`)

- Registers tools: desktop control (apps, windows, ui_tree, ui_press, click, type, key, drag, scroll),
  screenshots + OCR, Chrome CDP browser tools, stealth/anti-detection, memory/learning,
  platform playbooks, AppleScript, and Codex Monitor daemon management.
- Lazy-initializes `BridgeClient` on first tool call.
- Manages Chrome CDP connections for browser tools.

### 2. Native Bridge (`native/macos-bridge/`, `native/windows-bridge/`)

- Swift (macOS) or C# (Windows) binary, communicated with via JSON-RPC over stdio.
- Provides: accessibility tree reading, element actions, screenshots, OCR, keyboard/mouse input.
- Auto-detected based on platform.

### 3. Runtime Modules (`src/`)

- `src/native/bridge-client.ts` — BridgeClient: JSON-RPC stdio wrapper for the native binary.
- `src/memory/` — Learning system: action logging, strategy extraction, error tracking, recall.
- `src/playbook/` — Playbook engine, store, runner, recorder for deterministic automation.
- `src/agent/` — Autonomous agent loop (observe→decide→act using Claude API + AX tree).
- `src/monitor/` — Codex Monitor types and in-process monitor class.
- `src/runtime/` — Service abstraction, adapters (accessibility, composite, CDP). Used by modular entrypoint.

### 4. Codex Monitor Daemon (`scripts/codex-monitor-daemon.ts`)

- Standalone background process that monitors VS Code terminals via OCR.
- Detects idle/running/error status, auto-assigns queued tasks.
- Controlled via MCP tools in `mcp-desktop.ts` (start/stop/status/add_task).
- State persisted to `~/.screenhand/monitor/` (JSON files).
- Survives Claude Code restarts.

## Key Design Decisions

- **Monolithic server**: All tools in one file for simplicity and fast startup. No module resolution overhead.
- **Lazy bridge init**: Native bridge only spawned when first desktop tool is called.
- **Filesystem IPC for daemon**: JSON files in `~/.screenhand/monitor/` rather than sockets — simple, debuggable.
- **No API key in daemon**: The daemon is eyes+hands only. An LLM running elsewhere decides tasks via MCP tools.

## File Map

```
mcp-desktop.ts          ← PRIMARY entrypoint (40+ MCP tools)
src/mcp-entry.ts        ← Alternative modular entrypoint (smaller tool set)
src/native/             ← BridgeClient
src/memory/             ← Learning system
src/playbook/           ← Playbook engine + recorder
src/agent/              ← Autonomous agent loop
src/monitor/            ← Codex Monitor types
src/runtime/            ← Service + adapters (used by modular entrypoint)
scripts/                ← Ops scripts (daemon, watchers, tmux helpers)
native/                 ← Swift + C# native bridge source
docs/                   ← Architecture, integration guides
docs/marketing/         ← Marketing content (non-core)
playbooks/              ← Saved platform playbooks (JSON)
```
