# desktop-automation

Give Claude eyes and hands on your Mac.

An MCP server that lets Claude see your screen, click buttons, type text, control any app via Accessibility, automate Chrome, and run AppleScript — so it can do real work across your entire desktop.

## What can Claude do with this?

- **Debug your app** — Claude reads the UI tree, clicks through flows, checks element states
- **Inspect designs** — screenshots + OCR to read exactly what's on screen, pixel-level
- **Automate Chrome** — fill forms, scrape data, run JS, navigate pages
- **Cross-app workflows** — read from one app, paste into another, chain actions across your whole desktop
- **Test UI flows** — click buttons, verify text appears, catch regressions
- **Control native apps** — Finder, Notes, Mail, Xcode — anything with Accessibility or AppleScript support

## Quick start

```bash
git clone https://github.com/manushi4/desktop-automation.git
cd desktop-automation
npm install
npm run build:native   # builds the native macOS Swift bridge
```

Then add the MCP server to Claude.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "desktop": {
      "command": "npx",
      "args": ["tsx", "/path/to/desktop-automation/mcp-desktop.ts"]
    }
  }
}
```

### Claude Code

Add to your project `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "desktop": {
      "command": "npx",
      "args": ["tsx", "/path/to/desktop-automation/mcp-desktop.ts"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "desktop": {
      "command": "npx",
      "args": ["tsx", "/path/to/desktop-automation/mcp-desktop.ts"]
    }
  }
}
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml` (or `.codex/config.toml` in your project):

```toml
[mcp.desktop]
command = "npx"
args = ["tsx", "/path/to/desktop-automation/mcp-desktop.ts"]
transport = "stdio"
```

### Any MCP client

This is a standard MCP server over stdio. It works with any MCP-compatible client — just point it at `mcp-desktop.ts`.

Replace `/path/to/desktop-automation` with the actual path where you cloned the repo.

## Tools

### See the screen

| Tool | What it does |
|------|-------------|
| `screenshot` | Screenshot + OCR — returns all visible text |
| `screenshot_file` | Screenshot saved to file (for viewing the image) |
| `ocr` | OCR with element positions and bounds |

### Control any app (Accessibility)

| Tool | What it does |
|------|-------------|
| `apps` | List running apps with bundle IDs and PIDs |
| `windows` | List visible windows with positions and sizes |
| `focus` | Bring an app to the front |
| `launch` | Launch an app |
| `ui_tree` | Full UI element tree — instant, no OCR needed |
| `ui_find` | Find a UI element by text or title |
| `ui_press` | Click a UI element by its title |
| `ui_set_value` | Set value of a text field, slider, etc. |
| `menu_click` | Click a menu bar item |

### Keyboard & mouse

| Tool | What it does |
|------|-------------|
| `click` | Click at screen coordinates |
| `click_text` | Find text via OCR and click it |
| `type_text` | Type text |
| `key` | Key combo (e.g. `cmd+s`, `cmd+shift+z`) |
| `drag` | Drag from point A to B |
| `scroll` | Scroll at a position |

### Chrome browser (CDP)

| Tool | What it does |
|------|-------------|
| `browser_tabs` | List open tabs |
| `browser_open` | Open URL in new tab |
| `browser_navigate` | Navigate active tab to URL |
| `browser_js` | Run JavaScript in a tab |
| `browser_dom` | Query DOM with CSS selectors |
| `browser_click` | Click element by selector |
| `browser_type` | Type into an input field |
| `browser_wait` | Wait for a page condition |
| `browser_page_info` | Get page title, URL, and content |

### AppleScript

| Tool | What it does |
|------|-------------|
| `applescript` | Run any AppleScript command |

## Requirements

- **macOS** — uses Accessibility APIs and a native Swift bridge
- **Node.js 18+**
- **Accessibility permissions** — System Settings > Privacy & Security > Accessibility > enable your terminal
- **Chrome with remote debugging** (only for browser tools):
  ```bash
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
  ```

## How it works

Three layers:

1. **Native Swift bridge** — talks to macOS Accessibility APIs, CoreGraphics, and Vision framework (OCR)
2. **TypeScript runtime** — CDP adapter for Chrome, AppleScript executor, coordinate mapping for Retina displays
3. **MCP server** — exposes everything as tool calls that Claude can use directly

## Skills (slash commands)

The repo ships with Claude Code skills — slash commands you can use in any session.

**In this project** they work automatically:
- `/screenshot` — capture your screen and describe what's visible
- `/debug-ui` — inspect the UI tree of any app (e.g. `/debug-ui Xcode`)
- `/automate` — describe a task and Claude does it (e.g. `/automate open Notes and create a new note titled "Hello"`)

**Install globally** so they work in any project:

```bash
./install-skills.sh
```

This copies the skills to `~/.claude/commands/` as `/desktop-screenshot`, `/desktop-debug-ui`, and `/desktop-automate`.

### Remote Control

Pair with [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) to run these from your phone:

```bash
claude remote-control --name "Desktop Automation"
```

Scan the QR code, then from your phone: `/desktop-automate open Chrome and go to github.com`

## Development

```bash
npm run check        # type-check
npm run build        # compile TypeScript
npm run build:native # build Swift bridge
```

## License

MIT
