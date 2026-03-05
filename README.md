# desktop-automation

Control any macOS application via Accessibility APIs and Chrome via CDP — exposed as an MCP server so Claude can see and interact with your entire desktop.

## What it does

This is an MCP (Model Context Protocol) server that gives Claude the ability to:

- **See your screen** — take screenshots, OCR text, read UI element trees
- **Control any macOS app** — click buttons, type text, navigate menus, read UI state via Accessibility
- **Automate Chrome** — open tabs, click elements, fill forms, run JavaScript, query the DOM
- **Run AppleScript** — control Finder, Safari, Mail, Notes, and other scriptable apps

Claude can chain these tools together to automate complex workflows across multiple apps.

## Installation

```bash
git clone https://github.com/khushi-singhal-06/desktop-automation.git
cd desktop-automation
npm install
```

Build the native macOS bridge (required for Accessibility features):

```bash
npm run build:native
```

## Setup

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

Replace `/path/to/desktop-automation` with the actual path where you cloned the repo.

## Tools

### Screen & Vision

| Tool | Description |
|------|-------------|
| `screenshot` | Take a screenshot and OCR it — returns all visible text |
| `screenshot_file` | Take a screenshot and return the file path |
| `ocr` | OCR a window with element positions (bounds, confidence) |

### App Control (Accessibility)

| Tool | Description |
|------|-------------|
| `apps` | List all running applications with bundle IDs and PIDs |
| `windows` | List all visible windows with IDs, positions, and sizes |
| `focus` | Focus/activate an application |
| `launch` | Launch an application |
| `ui_tree` | Get the full UI element tree of an app (fast, no OCR) |
| `ui_find` | Find a UI element by text/title |
| `ui_press` | Find and press/click a UI element by title |
| `ui_set_value` | Set the value of a UI element (text field, slider, etc.) |
| `menu_click` | Click a menu item in an app's menu bar |

### Input

| Tool | Description |
|------|-------------|
| `click` | Click at screen coordinates |
| `click_text` | Find text on screen via OCR and click it |
| `type_text` | Type text using the keyboard |
| `key` | Press a key combination (e.g. `cmd+s`) |
| `drag` | Drag from one point to another |
| `scroll` | Scroll at a position |

### Chrome (CDP)

| Tool | Description |
|------|-------------|
| `browser_tabs` | List all open Chrome tabs |
| `browser_open` | Open a URL in Chrome (new tab) |
| `browser_navigate` | Navigate the active tab to a URL |
| `browser_js` | Execute JavaScript in a Chrome tab |
| `browser_dom` | Query the DOM with CSS selectors |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type into an input field |
| `browser_wait` | Wait for a condition on a page |
| `browser_page_info` | Get current page title, URL, and content summary |

### AppleScript

| Tool | Description |
|------|-------------|
| `applescript` | Run an AppleScript command |

## Requirements

- **macOS** (uses Accessibility APIs and native Swift bridge)
- **Node.js** 18+
- **Accessibility permissions** — grant access to your terminal in System Settings > Privacy & Security > Accessibility
- **Chrome with remote debugging** (for browser tools):
  ```bash
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
  ```

## Development

```bash
npm run check       # Type-check
npm run build       # Compile TypeScript
npm run build:native # Build Swift bridge
```

## License

MIT
