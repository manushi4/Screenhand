<div align="center">

# ScreenHand

**Let AI control your desktop — click buttons, fill forms, automate workflows in ~50ms with zero extra AI calls.**

An open-source [MCP server](https://modelcontextprotocol.io/) for macOS and Windows. Works with Claude, Cursor, Codex CLI, and any MCP-compatible client.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![npm: screenhand](https://img.shields.io/npm/v/screenhand)](https://www.npmjs.com/package/screenhand)
[![CI](https://github.com/manushi4/screenhand/actions/workflows/ci.yml/badge.svg)](https://github.com/manushi4/screenhand/actions/workflows/ci.yml)
[![Platform: macOS & Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-green)]()
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple)]()

[Quick Start](#quick-start) | [What It Does](#what-it-does) | [Example](#example) | [All 111 Tools](docs/tools.md) | [Architecture](docs/architecture.md) | [Website](https://screenhand.com)

</div>

---

<!-- TODO: Add demo GIF here — 15 sec showing Claude controlling a real app -->

## The Problem

AI assistants can write code but can't use your computer. Every click requires a screenshot → LLM interpretation → coordinate guess — **3-5 seconds and an API call per action**.

ScreenHand gives AI direct access to native OS APIs. No screenshots needed for clicks. No AI calls for button presses.

| | Without ScreenHand | With ScreenHand |
|---|---|---|
| Click a button | Screenshot → LLM → coordinate click (~3-5s) | Native Accessibility API (~50ms) |
| Cost per action | 1 LLM API call | 0 LLM calls |
| Accuracy | Coordinate guessing — misses on layout shift | Exact element targeting by role/name |
| Browser control | Needs focus, screenshot per action | CDP in background (~10ms), no focus needed |
| Works across apps | One app at a time | Cross-app workflows, multi-agent coordination |

## Quick Start

### 1. Add to your AI client (one step)

<details open>
<summary><b>Claude Code</b> (recommended)</summary>

```bash
claude mcp add screenhand -- npx -y screenhand
```

Done. That's it.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "screenhand": {
      "command": "npx",
      "args": ["-y", "screenhand"]
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "screenhand": {
      "command": "npx",
      "args": ["-y", "screenhand"]
    }
  }
}
```
</details>

<details>
<summary><b>OpenAI Codex CLI</b></summary>

Add to `~/.codex/config.toml`:
```toml
[mcp.screenhand]
command = "npx"
args = ["-y", "screenhand"]
transport = "stdio"
```
</details>

<details>
<summary><b>Any MCP Client</b></summary>

ScreenHand is a standard MCP server over stdio. Run with `npx -y screenhand`.
</details>

### 2. Grant permissions

**macOS**: System Settings > Privacy & Security > Accessibility > enable your terminal app.

**Windows**: No special permissions needed.

### 3. Browser control (optional)

Launch Chrome with remote debugging to enable browser tools:
```bash
open -a "Google Chrome" --args --remote-debugging-port=9222
```

That's it. Your AI client now has 111 tools for desktop automation — and ships with prebuilt knowledge for 36 apps so you don't start from zero.

<details>
<summary><b>Building from source</b> (contributors only)</summary>

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand && npm install && npm run build:native
```

On Windows, use `npm run build:native:windows` instead.
</details>

---

## Prebuilt Platform Knowledge

Every install ships with battle-tested knowledge so AI starts from EXPERT level on day one — no re-exploration needed:

| | Count | Apps Included |
|---|---|---|
| **References** | 37 | Terminal, Mail, Finder, Calendar, Reminders, Keynote, Pages, Notes, Photos, Apple Music, WhatsApp, Simulator, Figma, Discord, DaVinci Resolve, Canva, Instagram, X/Twitter, LinkedIn, YouTube, Reddit, Notion, n8n, and more |
| **Playbooks** | 49 | Calendar events, Keynote decks, Reminders, Notes workflows, WhatsApp navigation, DaVinci color grading/render, Canva carousel, social posting, Google Flow, competitor research, and more |
| **App Maps** | 15 | Spatial UI blueprints for Finder, Mail, Calendar, Notes, Reminders, Keynote, Pages, Photos, Apple Music, Terminal, WhatsApp, Simulator, Figma, Discord, Notion |

These load automatically when the matching app or website is detected. No setup required.

**Verify after install:**
```bash
npx screenhand --info
```

---

## What It Does

ScreenHand gives AI agents eight capabilities:

### Desktop Control — 19 tools
Click buttons, type text, read UI trees, navigate menus, drag, scroll — all via native Accessibility APIs in ~50ms. Works with any app: Finder, Notes, VS Code, Xcode, System Settings, etc.

### Browser Automation — 15 tools
Full Chrome control via DevTools Protocol. Navigate, click, type, run JavaScript, fill forms — all in the background at ~10ms. Built-in anti-detection (`browser_stealth`, `browser_human_click`) for sites with bot protection.

### Smart Fallbacks — 8 tools
`click_with_fallback`, `type_with_fallback`, etc. automatically try Accessibility → CDP → OCR → coordinates. You don't have to pick the right method — ScreenHand figures it out.

### Memory & Learning — 14 tools
Gets smarter every session. Logs tool calls, saves winning strategies, tracks error patterns with fixes. Zero config, zero latency overhead (in-memory cache, async disk writes). Ships with 12 seed strategies for common macOS workflows. 6 learning policies: locator stability, sensor effectiveness, recovery ranking, pattern recognition, adaptive timing, and topology (navigation edge reliability).

### App Mastery Map — automatic per-app spatial understanding
Builds a persistent reverse-engineered blueprint of every app from normal tool usage. 8 features record automatically: page zones, navigation graph (BFS pathfinding), hierarchy, I/O contracts, state machine, element visibility, timing profiles, and ready signals. Mastery levels (beginner → pro → expert → grandmaster) honestly reflect how well ScreenHand knows each app. Maps stored at `~/.screenhand/app-maps/`.

### Website Feature Discovery — real features, not generic ladders
`discover_features` fetches an app's official website and extracts real product features (headings, feature cards, definition lists). Assigns difficulty tiers automatically and generates value-add features only ScreenHand can provide: bulk operations, cross-app export, content summarization, auto-organize, and change monitoring. No LLM calls needed — pure rule-based extraction. Features merge into the reference file and enrich the mastery ladder.

### Jobs & Orchestration — 34 tools
Queue multi-step jobs, run them via background worker daemon, coordinate multiple AI agents with session leases, detect stalls, auto-recover. Survives client restarts.

### Perception & Planning — 17 tools
Continuous screen awareness (3-rate perception loop at 100ms/300ms/1000ms), real-time world model with entity tracking, goal-oriented planning with auto-decomposition, recovery engine with self-healing. The system always knows what's on screen and feeds observations into the App Mastery Map.

> **Full reference**: See all [111 tools with descriptions](docs/tools.md).

---

## Example

**Browser** — Claude controls Chrome in the background while you work:

```
You: Search for "screenhand" on Instagram

→ browser_tabs()                                        # ~10ms
  [34DF5DE1] Instagram — https://www.instagram.com/

→ browser_js({ code: "/* click Search icon */" })       # ~10ms
→ browser_fill_form({ selector: "input", text: "screenhand" })  # ~50ms (human-like)
→ browser_js({ code: "/* extract results */" })         # ~10ms

Found @screenhand_ as the top result.
```

**Desktop** — native app control without screenshots:

```
→ apps()                     # List running apps           ~10ms
→ focus("com.apple.Notes")   # Bring Notes to front        ~10ms
→ ui_tree()                  # Read full UI element tree    ~50ms
→ ui_press("New Note")       # Click "New Note" button     ~50ms
→ type_text("Hello world")   # Type text                   ~30ms
```

**Cross-app** — chain actions across your whole desktop:

```
→ browser_js(...)            # Extract data from Chrome
→ focus("com.apple.Notes")   # Switch to Notes
→ type_text(extractedData)   # Paste it in
→ key("cmd+s")               # Save
```

---

## Claude Code Plugin

If you use Claude Code, ScreenHand includes a plugin with **13 skills and 5 agents** that wrap all 111 tools into intent-oriented workflows.

```bash
./install-plugin.sh   # after npm install && npm run build:native
```

| Skill | What it does |
|-------|-------------|
| `/automate` | Control any desktop app |
| `/post-social` | Post to X, LinkedIn, Instagram, Reddit, Threads, Discord |
| `/run-campaign` | Multi-platform marketing campaigns |
| `/edit-video` | DaVinci Resolve automation |
| `/design-figma` | Figma design via Plugin API + browser |
| `/edit-canva` | Canva template editing |
| `/scrape-web` | Data extraction with anti-detection |
| `/fill-form` | Human-like form filling |
| `/qa-smoke-test` | Automated UI testing |
| `/record-workflow` | Record into reusable playbooks |
| `/learn-platform` | Discover how to automate a new app/site |
| `/run-jobs` | Job queues, background workers |
| `/manage-system` | Supervisor, memory, diagnostics |

5 specialized agents: **marketing**, **design**, **QA**, **scraper**, **orchestrator**.

---

## How It Works

```
AI Client (Claude, Cursor, Codex CLI)
    ↓ MCP protocol (stdio)
ScreenHand MCP Server (TypeScript)
    ↓ JSON-RPC (stdio)
Native Bridge (Swift on macOS / C# on Windows)
    ↓ OS APIs
Accessibility, CoreGraphics, Vision, UI Automation, SendInput
```

ScreenHand reads the UI tree and DOM directly — no screenshots needed for most operations. When screenshots are needed (canvas apps, visual verification), OCR runs in ~600ms via the native Vision framework.

---

## Requirements

| | macOS | Windows |
|---|---|---|
| OS | macOS 12+ | Windows 10 (1809+) |
| Runtime | Node.js 18+ | Node.js 18+ |
| Native | Swift (included) | [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) |
| Permissions | Accessibility access for terminal | None (UI Automation works without admin) |
| Browser | Chrome with `--remote-debugging-port=9222` | Same |

## Docs

| Document | What's in it |
|----------|-------------|
| [All 111 Tools](docs/tools.md) | Complete tool reference with descriptions and speeds |
| [Architecture](docs/architecture.md) | 7-layer design, app tiers, performance targets |
| [App Mastery Map](docs/app-mastery-map.md) | Layer 7: persistent spatial understanding, 8 auto-recording features |
| [Bug Tracker](docs/l2-bug-tracker.md) | 132 bugs tracked (119 fixed), 80-scenario validation results |
| [Testing Plan](docs/testing-plan.md) | L1/L2 test methodology and gate criteria |

## FAQ

<details>
<summary><b>How is this different from Anthropic's Computer Use?</b></summary>

Computer Use is cloud-based and screenshot-driven. ScreenHand is local-first, uses native OS APIs (50ms vs 3-5s per action), costs zero API calls for clicks/typing, and runs entirely on your machine.
</details>

<details>
<summary><b>What apps can it control?</b></summary>

Any app with Accessibility support (most macOS/Windows apps). Chrome and Electron apps get full DOM access via CDP. Canvas-heavy apps (games, Photoshop viewport) use OCR as fallback.

Ships with EXPERT-level prebuilt knowledge for: Terminal, Mail, Finder, Calendar, Reminders, Keynote, Pages, Notes, Photos, Apple Music, WhatsApp, Figma, Discord, DaVinci Resolve, Canva, Instagram, X/Twitter, LinkedIn, YouTube, Reddit, Notion, n8n, and more. Any other app gets explored and learned automatically on first use.
</details>

<details>
<summary><b>Is it safe?</b></summary>

Runs locally, never sends screen data externally. PII is redacted from all persisted data (memory, playbooks, strategies). Dangerous protocols (`javascript:`, `data:`) are blocked. AppleScript and browser JS execution are audit-logged.
</details>

<details>
<summary><b>Does it work with multiple AI agents at once?</b></summary>

Yes. Session leases with heartbeat prevent conflicts. The supervisor daemon detects stalls and recovers. Each agent claims its own app window.
</details>

<details>
<summary><b>How fast is it?</b></summary>

Accessibility: ~50ms. Chrome CDP: ~10ms (background, no focus needed). OCR: ~600ms. Memory lookups: ~0ms (in-memory cache). All disk writes are async and non-blocking.
</details>

## Contributing

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand && npm install && npm run build:native
npm test   # 1331 tests, 54 files
```

## Contact

- **Email**: [khushi@clazro.com](mailto:khushi@clazro.com)
- **Issues**: [github.com/manushi4/screenhand/issues](https://github.com/manushi4/screenhand/issues)
- **Website**: [screenhand.com](https://screenhand.com)

## License

AGPL-3.0-only — Copyright (C) 2025-2026 Clazro Technology Private Limited

---

<div align="center">

**[screenhand.com](https://screenhand.com)** | [khushi@clazro.com](mailto:khushi@clazro.com) | A product of **Clazro Technology Private Limited**

</div>
