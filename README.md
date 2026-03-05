<div align="center">

# ScreenHand

**Give AI eyes and hands on your desktop.**

An open-source [MCP server](https://modelcontextprotocol.io/) that lets Claude (and any AI agent) see your screen, click buttons, type text, and control any app — on both macOS and Windows.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm: screenhand](https://img.shields.io/npm/v/screenhand)](https://www.npmjs.com/package/screenhand)
[![Platform: macOS & Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-green)]()
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple)]()

[Website](https://screenhand.com) | [Quick Start](#quick-start) | [Tools](#tools) | [FAQ](#faq)

</div>

---

## What is ScreenHand?

ScreenHand is a **desktop automation bridge for AI**. It connects AI assistants like Claude to your operating system so they can:

- **See** your screen via screenshots and OCR
- **Read** UI elements via Accessibility APIs (macOS) or UI Automation (Windows)
- **Click** buttons, menus, and links
- **Type** text into any input field
- **Control** Chrome tabs via DevTools Protocol
- **Run** AppleScript commands (macOS)

It works as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server, meaning any MCP-compatible AI client can use it out of the box.

## Why ScreenHand?

| Problem | ScreenHand Solution |
|---|---|
| AI can't see your screen | Screenshots + OCR return all visible text |
| AI can't click UI elements | Accessibility API finds and clicks elements in ~50ms |
| AI can't control browsers | Chrome DevTools Protocol gives full page control |
| AI can't automate workflows | 25+ tools for cross-app automation |
| Only works on one OS | Native bridges for both macOS and Windows |

## Quick Start

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
      "args": ["tsx", "/path/to/screenhand/mcp-desktop.ts"]
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
      "args": ["tsx", "/path/to/screenhand/mcp-desktop.ts"]
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
      "args": ["tsx", "/path/to/screenhand/mcp-desktop.ts"]
    }
  }
}
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp.screenhand]
command = "npx"
args = ["tsx", "/path/to/screenhand/mcp-desktop.ts"]
transport = "stdio"
```

### Any MCP Client

ScreenHand is a standard MCP server over stdio. It works with any MCP-compatible client — just point it at `mcp-desktop.ts`.

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
| `browser_click` | Click element by CSS selector |
| `browser_type` | Type into an input field |
| `browser_wait` | Wait for a page condition |
| `browser_page_info` | Get page title, URL, and content |

### AppleScript (macOS only)

| Tool | What it does |
|------|-------------|
| `applescript` | Run any AppleScript command |

### Memory (Learning)

| Tool | What it does |
|------|-------------|
| `memory_recall` | Search past successful strategies by task description |
| `memory_save` | Save the current session's actions as a reusable strategy |
| `memory_errors` | View known error patterns and resolutions |
| `memory_stats` | Show action counts, success rates, and disk usage |
| `memory_clear` | Clear stored actions, strategies, or errors |

ScreenHand automatically logs every tool call and remembers what worked. Over time it builds a library of strategies (successful action sequences) and error patterns (what goes wrong and how to fix it). Data is stored in `.screenhand/memory/` as JSONL files.

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
npm test                   # run test suite (24 tests)
npm run build              # compile TypeScript
npm run build:native       # build Swift bridge (macOS)
npm run build:native:windows  # build .NET bridge (Windows)
```

## FAQ

### What is ScreenHand?
ScreenHand is an open-source MCP server that gives AI assistants like Claude the ability to see and control your desktop. It provides 25+ tools for screenshots, UI inspection, clicking, typing, and browser automation on both macOS and Windows.

### How does ScreenHand differ from Anthropic's Computer Use?
Anthropic's Computer Use is a cloud-based feature built into Claude. ScreenHand is an open-source, local-first tool that runs entirely on your machine with no cloud dependency. It uses native OS APIs (Accessibility on macOS, UI Automation on Windows) which are faster and more reliable than screenshot-based approaches.

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
Accessibility/UI Automation operations take ~50ms. Chrome CDP operations take ~10ms. Screenshots with OCR take ~600ms. ScreenHand is significantly faster than screenshot-only approaches because it reads the UI tree directly.

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

**[screenhand.com](https://screenhand.com)** | Built by [Khushi Singhal](https://github.com/manushi4)

</div>
