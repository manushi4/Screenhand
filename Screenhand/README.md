<div align="center">

# ScreenHand

**Give AI eyes and hands on your desktop.**

ScreenHand is an [MCP server](https://modelcontextprotocol.io/) that lets AI agents see your screen, click buttons, type text, and control any app on macOS and Windows.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![npm: screenhand](https://img.shields.io/npm/v/screenhand)](https://www.npmjs.com/package/screenhand)
[![Platform: macOS & Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-green)]()
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple)]()

[Website](https://screenhand.com) | [Quick Start](#quick-start) | [Use Cases](#use-cases) | [FAQ](#faq)

</div>

---

## The Problem

AI assistants are powerful — but they're blind. They can't see what's on your screen, click a button, or type into an app. If you want Claude to help you automate a workflow, debug a UI, or fill out a form, you're stuck copy-pasting screenshots and describing what you see.

**ScreenHand fixes that.** It gives any AI agent direct access to your desktop through native OS APIs — not slow screenshot-and-guess loops.

## How It Works

You connect ScreenHand to your AI client (Claude, Cursor, Codex CLI, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io/). Once connected, your AI can:

- **See** your screen via screenshots and OCR
- **Read** UI elements directly via native Accessibility APIs
- **Click** buttons, menus, and links
- **Type** text into any input field
- **Control** Chrome tabs via DevTools Protocol
- **Automate** cross-app workflows

```
Your AI Client (Claude, Cursor, etc.)
    |  MCP protocol (stdio)
ScreenHand
    |  Native OS APIs
Your Desktop (any app, any browser)
```

## Quick Start

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand
npm install
npm run build:native   # macOS — builds Swift bridge
# npm run build:native:windows   # Windows — builds .NET bridge
```

### Connect to Your AI Client

<details>
<summary><strong>Claude Desktop</strong></summary>

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
</details>

<details>
<summary><strong>Claude Code</strong></summary>

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
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

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
</details>

<details>
<summary><strong>OpenAI Codex CLI</strong></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp.screenhand]
command = "npx"
args = ["tsx", "/path/to/screenhand/mcp-desktop.ts"]
transport = "stdio"
```
</details>

<details>
<summary><strong>Any MCP Client</strong></summary>

ScreenHand is a standard MCP server over stdio. Point any MCP-compatible client at `mcp-desktop.ts`.
</details>

Replace `/path/to/screenhand` with the actual path where you cloned the repo.

## Use Cases

### Automate Repetitive Workflows
Tell your AI "submit this form on 10 websites" or "export all these reports as PDFs" — and it does it. ScreenHand handles the clicking, typing, and navigating across any app.

### Debug UIs Faster
Instead of clicking through your app manually, let Claude inspect the full UI element tree, check states, and walk through flows — all from your terminal.

### Browser Automation Without Selenium
Fill forms, scrape data, run JavaScript, and navigate pages through Chrome DevTools Protocol. Works with sites that block traditional automation.

### Cross-App Workflows
Read data from a spreadsheet, search it in Chrome, paste results into Notes — chain actions across your entire desktop.

### AI-Powered UI Testing
Click buttons, verify text appears, check element states, and catch regressions — all driven by your AI agent.

## What's Included

ScreenHand exposes **70+ tools** organized by what you need to do:

| Category | Examples | What For |
|----------|----------|----------|
| **Screen** | `screenshot`, `ocr` | See what's on screen, read all visible text |
| **App Control** | `ui_tree`, `ui_press`, `menu_click` | Read and interact with any native app |
| **Keyboard & Mouse** | `click`, `type_text`, `key`, `drag` | Direct input control |
| **Chrome Browser** | `browser_navigate`, `browser_js`, `browser_dom` | Full browser automation via CDP |
| **Memory** | `memory_recall`, `memory_save` | ScreenHand learns from past sessions |
| **AppleScript** | `applescript` | Run AppleScript on macOS |

For the full tool reference, see the [tool documentation](DESKTOP_MCP_GUIDE.md).

## Requirements

| | macOS | Windows |
|---|---|---|
| **OS** | macOS 12+ | Windows 10 (1809+) |
| **Runtime** | Node.js 18+ | Node.js 18+ |
| **Permissions** | Accessibility (System Settings) | None (no admin needed) |
| **Browser tools** | Chrome with `--remote-debugging-port=9222` | Same |
| **Build** | `npm run build:native` | `npm run build:native:windows` |

## Development

```bash
npm run check              # type-check
npm test                   # run test suite
npm run build              # compile TypeScript
npm run build:native       # build native bridge
```

## FAQ

<details>
<summary><strong>What is ScreenHand?</strong></summary>

An MCP server that gives AI agents the ability to see and control your desktop. It uses native OS APIs (Accessibility on macOS, UI Automation on Windows) for fast, reliable automation — not slow screenshot-based guessing.
</details>

<details>
<summary><strong>How is this different from Anthropic's Computer Use?</strong></summary>

Computer Use is cloud-based and built into Claude. ScreenHand is open-source, runs locally on your machine, and uses native OS APIs which are faster and more reliable than screenshot-based approaches. It also works with any MCP-compatible client, not just Claude.
</details>

<details>
<summary><strong>Is it safe?</strong></summary>

ScreenHand runs entirely on your machine — no screen data is sent to external servers. All tool calls are audit-logged. See our [Security Policy](SECURITY.md) for details on permissions and boundaries.
</details>

<details>
<summary><strong>What AI clients work with it?</strong></summary>

Any MCP-compatible client: Claude Desktop, Claude Code, Cursor, Windsurf, OpenAI Codex CLI, and more.
</details>

<details>
<summary><strong>Can it control any app?</strong></summary>

On macOS, any app that exposes Accessibility elements (most do). On Windows, any app supporting UI Automation. For apps with custom rendering (games, some Electron apps), OCR is available as a fallback.
</details>

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand
npm install && npm run build:native && npm test
```

## License

[AGPL-3.0](LICENSE) — Copyright (C) 2025 Clazro Technology Private Limited

---

<div align="center">

**[screenhand.com](https://screenhand.com)** | Built by **[Clazro Technology Private Limited](https://github.com/manushi4)**

</div>
