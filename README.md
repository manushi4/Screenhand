<div align="center">

# ScreenHand

**Native desktop control for MCP agents.**

An open-source [MCP server](https://modelcontextprotocol.io/) for macOS and Windows that gives Claude, Cursor, Codex CLI, and OpenClaw fast desktop control via Accessibility/UI Automation, OCR, and Chrome CDP.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm: screenhand](https://img.shields.io/npm/v/screenhand)](https://www.npmjs.com/package/screenhand)
[![CI](https://github.com/manushi4/screenhand/actions/workflows/ci.yml/badge.svg)](https://github.com/manushi4/screenhand/actions/workflows/ci.yml)
[![Platform: macOS & Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-green)]()
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple)]()

[Website](https://screenhand.com) | [Quick Start](#quick-start) | [Why ScreenHand](#why-screenhand) | [Tools](#tools) | [FAQ](#faq)

</div>

---

## Why ScreenHand?

- `~50ms` native UI actions via Accessibility APIs and Windows UI Automation
- `0` extra AI calls for native clicks, typing, and UI element lookup
- `25+` tools across desktop apps, browser automation, OCR, and reusable playbooks
- `macOS + Windows` behind the same MCP interface

## What is ScreenHand?

ScreenHand is a **desktop automation bridge for AI**. It connects AI assistants like Claude to your operating system so they can:

- **See** your screen via screenshots and OCR
- **Read** UI elements via Accessibility APIs (macOS) or UI Automation (Windows)
- **Click** buttons, menus, and links
- **Type** text into any input field
- **Control** Chrome tabs via DevTools Protocol
- **Run** AppleScript commands (macOS)

It works as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server, meaning any MCP-compatible AI client can use it out of the box.

| Problem | ScreenHand Solution |
|---|---|
| AI can't see your screen | Screenshots + OCR return all visible text |
| AI can't click UI elements | Accessibility API finds and clicks elements in ~50ms |
| AI can't control browsers | Chrome DevTools Protocol gives full page control |
| AI can't automate workflows | 25+ tools for cross-app automation |
| Only works on one OS | Native bridges for both macOS and Windows |

## Quick Start

### Source install (recommended today)

ScreenHand currently builds a native bridge locally for Accessibility/UI Automation, so the fastest reliable setup is still from source:

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand
npm install
npm run build:native   # macOS — builds Swift bridge
# npm run build:native:windows   # Windows — builds .NET bridge
```

Then connect ScreenHand to your AI client.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "screenhand": {
      "command": "npx",
      "args": ["tsx", "/path/to/screenhand/src/mcp-entry.ts"]
    }
  }
}
```

### Claude Code

Add to your project `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "screenhand": {
      "command": "npx",
      "args": ["tsx", "/path/to/screenhand/src/mcp-entry.ts"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "screenhand": {
      "command": "npx",
      "args": ["tsx", "/path/to/screenhand/src/mcp-entry.ts"]
    }
  }
}
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp.screenhand]
command = "npx"
args = ["tsx", "/path/to/screenhand/src/mcp-entry.ts"]
transport = "stdio"
```

### OpenClaw

Add to your `openclaw.json`:

```json
{
  "mcpServers": {
    "screenhand": {
      "command": "npx",
      "args": ["tsx", "/path/to/screenhand/src/mcp-entry.ts"]
    }
  }
}
```

> **Why?** OpenClaw's built-in desktop control sends a screenshot to an LLM for every click (~3-5s, costs an API call). ScreenHand uses native Accessibility APIs — `press('Send')` runs in ~50ms with zero AI calls. See the full [integration guide](docs/openclaw-integration.md).

### Any MCP Client

ScreenHand is a standard MCP server over stdio. It works with any MCP-compatible client — just point it at `src/mcp-entry.ts`.

Replace `/path/to/screenhand` with the actual path where you cloned the repo.

## Tools

ScreenHand exposes 25+ tools organized by category.

### See the Screen

| Tool | What it does | Speed |
|------|-------------|-------|
| `screenshot` | Full screenshot + OCR — returns all visible text | ~600ms |
| `screenshot_file` | Screenshot saved to file (for viewing the image) | ~400ms |
| `ocr` | OCR with element positions and bounding boxes | ~600ms |

### Control Any App (Accessibility / UI Automation)

| Tool | What it does | Speed |
|------|-------------|-------|
| `apps` | List running apps with bundle IDs and PIDs | ~10ms |
| `windows` | List visible windows with positions and sizes | ~10ms |
| `focus` | Bring an app to the front | ~10ms |
| `launch` | Launch an app by bundle ID or name | ~1s |
| `ui_tree` | Full UI element tree — instant, no OCR needed | ~50ms |
| `ui_find` | Find a UI element by text or title | ~50ms |
| `ui_press` | Click a UI element by its title | ~50ms |
| `ui_set_value` | Set value of a text field, slider, etc. | ~50ms |
| `menu_click` | Click a menu bar item by path | ~100ms |

### Keyboard and Mouse

| Tool | What it does |
|------|-------------|
| `click` | Click at screen coordinates |
| `click_text` | Find text via OCR and click it (fallback) |
| `type_text` | Type text via keyboard |
| `key` | Key combo (e.g. `cmd+s`, `ctrl+shift+n`) |
| `drag` | Drag from point A to B |
| `scroll` | Scroll at a position |

### Chrome Browser (CDP)

| Tool | What it does |
|------|-------------|
| `browser_tabs` | List all open Chrome tabs |
| `browser_open` | Open URL in new tab |
| `browser_navigate` | Navigate active tab to URL |
| `browser_js` | Run JavaScript in a tab |
| `browser_dom` | Query DOM with CSS selectors |
| `browser_click` | Click element by CSS selector (uses CDP mouse events) |
| `browser_type` | Type into an input field (uses CDP keyboard events, React-compatible) |
| `browser_wait` | Wait for a page condition |
| `browser_page_info` | Get page title, URL, and content |

### Anti-Detection & Stealth (CDP)

Tools for interacting with sites that have bot detection (Instagram, LinkedIn, etc.):

| Tool | What it does |
|------|-------------|
| `browser_stealth` | Inject anti-detection patches (hides webdriver flag, fakes plugins/languages) |
| `browser_fill_form` | Human-like typing with random delays via CDP keyboard events |
| `browser_human_click` | Realistic mouse event sequence (mouseMoved → mousePressed → mouseReleased) |

> **Tip:** Call `browser_stealth` once after navigating to a protected site. Then use `browser_fill_form` and `browser_human_click` for interactions. The regular `browser_type` and `browser_click` also use CDP Input events now.

### Platform Playbooks (lazy-loaded)

Pre-built automation knowledge for specific platforms — selectors, URLs, flows, and **error solutions**.

| Tool | What it does |
|------|-------------|
| `platform_guide` | Get automation guide for a platform (selectors, URLs, flows, errors+solutions) |
| `export_playbook` | Auto-generate a playbook from your session. Share it to help others. |

```
platform_guide({ platform: "devpost", section: "errors" })   # Just errors + solutions
platform_guide({ platform: "devpost", section: "selectors" }) # All CSS selectors
platform_guide({ platform: "devpost", section: "flows" })     # Step-by-step workflows
platform_guide({ platform: "devpost" })                       # Full playbook
```

**Contributing playbooks:** After automating any site, run:
```
export_playbook({ platform: "twitter", domain: "twitter.com" })
```
This auto-extracts URLs, selectors, errors+solutions from your session and saves a ready-to-share `playbooks/twitter.json`.

Available platforms: `devpost`. Add more by running `export_playbook` or creating JSON files in `playbooks/`.

Zero performance cost — files only read when `platform_guide` is called.

### AppleScript (macOS only)

| Tool | What it does |
|------|-------------|
| `applescript` | Run any AppleScript command |

### Memory (Learning) — zero-config, zero-latency

ScreenHand gets smarter every time you use it — **no manual setup needed**.

**What happens automatically:**
- Every tool call is logged (async, non-blocking — adds ~0ms to response time)
- After 3+ consecutive successes, the winning sequence is saved as a reusable strategy
- Known error patterns are tracked with resolutions (e.g. "launch times out → use focus() instead")
- On every tool call, the response includes **auto-recall hints**:
  - Error warnings if the tool has failed before
  - Next-step suggestions if you're mid-way through a known strategy

**Predefined seed strategies:**
- Ships with 12 common macOS workflows (Photo Booth, Chrome navigation, copy/paste, Finder, export PDF, etc.)
- Loaded automatically on first boot — the system has knowledge from day one
- Seeds are searchable via `memory_recall` and provide next-step hints like any learned strategy

**Background web research:**
- When a tool fails and no resolution exists, ScreenHand searches for a fix in the background (non-blocking)
- Uses Claude API (haiku, if `ANTHROPIC_API_KEY` is set) or DuckDuckGo instant answers as fallback
- Resolutions are saved to both error cache and strategy store — zero-latency recall next time
- Completely silent and fire-and-forget — never blocks tool responses or throws errors

**Fingerprint matching & feedback loop:**
- Each strategy is fingerprinted by its tool sequence (e.g. `apps→focus→ui_press`)
- O(1) exact-match lookup when the agent follows a known sequence
- Success/failure outcomes are tracked per strategy — unreliable strategies are auto-penalized and eventually skipped
- Keyword-based fuzzy search with reliability scoring for `memory_recall`

**Production-grade under the hood:**
- All data cached in RAM at startup — lookups are ~0ms, disk is only for persistence
- Disk writes are async and buffered (100ms debounce) — never block tool calls
- Sync flush on process exit (SIGINT/SIGTERM) — no lost writes
- Per-line JSONL parsing — corrupted lines are skipped, not fatal
- LRU eviction: 500 strategies, 200 error patterns max (oldest evicted automatically)
- File locking (`.lock` + PID) prevents corruption from concurrent instances
- Action log auto-rotates at 10 MB
- Data lives in `.screenhand/memory/` as JSONL (grep-friendly, no database)

| Tool | What it does |
|------|-------------|
| `memory_recall` | Explicitly search past strategies by task description |
| `memory_save` | Manually save the current session (auto-save handles most cases) |
| `memory_errors` | View all known error patterns and their resolutions |
| `memory_stats` | Action counts, success rates, top tools, disk usage |
| `memory_clear` | Clear actions, strategies, errors, or all data |

## How It Works

ScreenHand has three layers:

```
AI Client (Claude, Cursor, etc.)
    ↓ MCP protocol (stdio)
ScreenHand MCP Server (TypeScript)
    ↓ JSON-RPC (stdio)
Native Bridge (Swift on macOS / C# on Windows)
    ↓ Platform APIs
Operating System (Accessibility, CoreGraphics, UI Automation, SendInput)
```

1. **Native bridge** — talks directly to OS-level APIs:
   - **macOS**: Swift binary using Accessibility APIs, CoreGraphics, and Vision framework (OCR)
   - **Windows**: C# (.NET 8) binary using UI Automation, SendInput, GDI+, and Windows.Media.Ocr
2. **TypeScript MCP server** — routes tools to the correct bridge, handles Chrome CDP, manages sessions
3. **MCP protocol** — standard Model Context Protocol so any AI client can connect

The native bridge is auto-selected based on your OS. Both bridges speak the same JSON-RPC protocol, so all tools work identically on both platforms.

## Use Cases

### App Debugging
Claude reads UI trees, clicks through flows, and checks element states — faster than clicking around yourself.

### Design Inspection
Screenshots + OCR to read exactly what's on screen. `ui_tree` shows component structure like React DevTools but for any native app.

### Browser Automation
Fill forms, scrape data, run JavaScript, navigate pages — all through Chrome DevTools Protocol.

### Cross-App Workflows
Read from one app, paste into another, chain actions across your whole desktop. Example: extract data from a spreadsheet, search it in Chrome, paste results into Notes.

### UI Testing
Click buttons, verify text appears, catch visual regressions — all driven by AI.

## Requirements

### macOS

- macOS 12+
- Node.js 18+
- Accessibility permissions: System Settings > Privacy & Security > Accessibility > enable your terminal
- Chrome with `--remote-debugging-port=9222` (only for browser tools)

### Windows

- Windows 10 (1809+)
- Node.js 18+
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- No special permissions needed — UI Automation works without admin
- Chrome with `--remote-debugging-port=9222` (only for browser tools)
- Build: `npm run build:native:windows`

## Skills (Slash Commands)

ScreenHand ships with Claude Code slash commands:

- `/screenshot` — capture your screen and describe what's visible
- `/debug-ui` — inspect the UI tree of any app
- `/automate` — describe a task and Claude does it

**Install globally** so they work in any project:

```bash
./install-skills.sh
```

## Development

```bash
npm run check              # type-check (covers all entry files)
npm test                   # run test suite (95 tests)
npm run build              # compile TypeScript
npm run build:native       # build Swift bridge (macOS)
npm run build:native:windows  # build .NET bridge (Windows)
```

## FAQ

### What is ScreenHand?
ScreenHand is an open-source MCP server that gives AI assistants like Claude the ability to see and control your desktop. It provides 25+ tools for screenshots, UI inspection, clicking, typing, and browser automation on both macOS and Windows.

### How does ScreenHand differ from Anthropic's Computer Use?
Anthropic's Computer Use is a cloud-based feature built into Claude. ScreenHand is an open-source, local-first tool that runs entirely on your machine with no cloud dependency. It uses native OS APIs (Accessibility on macOS, UI Automation on Windows) which are faster and more reliable than screenshot-based approaches.

### How does ScreenHand differ from OpenClaw?
OpenClaw is a general-purpose AI agent that controls your computer by looking at the screen — it takes screenshots, interprets them with an LLM, then simulates mouse/keyboard input. ScreenHand takes a fundamentally different approach:

| | ScreenHand | OpenClaw |
|---|---|---|
| **How it sees the UI** | Native Accessibility/UI Automation APIs — reads the actual element tree | Screenshots + LLM vision — interprets pixels |
| **Speed** | ~50ms per UI action | Seconds per action (screenshot → LLM → click) |
| **Accuracy** | Exact element targeting by role/title | Coordinate-based — can misclick if layout shifts |
| **Architecture** | MCP server — works with any MCP client (Claude, Cursor, Codex CLI) | Standalone agent — tied to its own runtime |
| **Model lock-in** | None — any MCP-compatible AI decides what to do | Supports multiple LLMs but runs its own agent loop |
| **Learning memory** | Built-in: auto-learns strategies, tracks errors, O(1) fingerprint recall | Skill-based: 5,000+ community skills, but no automatic learning from usage |
| **Security** | Scoped MCP tools, audit logging, no browser cookie access | Full computer access, uses browser cookies, significant security surface |
| **Setup** | `npm install` + grant accessibility permission | Requires careful sandboxing, not recommended on personal machines |

**TL;DR**: OpenClaw is a powerful autonomous agent for tinkerers who want maximum flexibility. ScreenHand is a focused, fast, secure automation layer designed to be embedded into any AI workflow via MCP — with native API speed instead of screenshot-based guessing.

### Does ScreenHand work on Windows?
Yes. ScreenHand supports both macOS and Windows. On macOS it uses a Swift native bridge with Accessibility APIs. On Windows it uses a C# (.NET 8) bridge with UI Automation and SendInput.

### What AI clients work with ScreenHand?
Any MCP-compatible client: Claude Desktop, Claude Code, Cursor, Windsurf, OpenAI Codex CLI, and any other tool that supports the Model Context Protocol.

### Does ScreenHand need admin/root permissions?
On macOS, you need to grant Accessibility permissions to your terminal app. On Windows, no special permissions are needed — UI Automation works without admin for most applications.

### Is ScreenHand safe to use?
ScreenHand runs locally and never sends screen data to external servers. Dangerous tools (AppleScript, browser JS execution) are audit-logged. You control which AI client connects to it via MCP configuration.

### Can ScreenHand control any application?
On macOS, it can control any app that exposes Accessibility elements (most apps do). On Windows, it works with any app that supports UI Automation. Some apps with custom rendering (games, some Electron apps) may have limited element tree support — use OCR as a fallback.

### How fast is ScreenHand?
Accessibility/UI Automation operations take ~50ms. Chrome CDP operations take ~10ms. Screenshots with OCR take ~600ms. Memory lookups add ~0ms (in-memory cache). ScreenHand is significantly faster than screenshot-only approaches because it reads the UI tree directly.

### Does the learning memory affect performance?
No. All memory data is loaded into RAM at startup. Lookups are O(1) hash map reads. Disk writes are async and buffered — they never block tool responses. The memory system adds effectively zero latency to any tool call.

### Is the memory data safe from corruption?
Yes. JSONL files are parsed line-by-line — a single corrupted line is skipped without affecting other entries. File locking prevents concurrent write corruption. Pending writes are flushed synchronously on exit (SIGINT/SIGTERM). Cache sizes are capped with LRU eviction to prevent unbounded growth.

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand
npm install
npm run build:native
npm test
```

## License

MIT

---

<div align="center">

**[screenhand.com](https://screenhand.com)** | Built by [Khushi Singhal](https://github.com/manushi4) | A product of **Clazro Technology Private Limited**

</div>
