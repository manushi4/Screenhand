# How to Give Your OpenClaw Agent Native Desktop Speed

**TL;DR:** Add ScreenHand as an MCP server to your OpenClaw config and your Claw gets 30+ desktop tools that run at ~50ms per action — no screenshot interpretation needed.

## The Problem

OpenClaw's built-in desktop control (Clawd Cursor) works by:
1. Taking a screenshot
2. Sending it to an LLM to interpret
3. Clicking at the coordinates the LLM suggests

This works, but it's **slow** (seconds per action) and **expensive** (every click costs an API call). If the layout shifts slightly, coordinate-based clicks can miss.

## The Fix: ScreenHand

ScreenHand uses your OS's native Accessibility APIs to read the actual UI element tree. Instead of "look at this screenshot and guess where the Send button is," it's just `ui_press('Send')` — instant, exact, no AI call needed.

| | Clawd Cursor | With ScreenHand |
|---|---|---|
| **Speed** | ~3-5s per action | ~50ms per action |
| **Cost** | 1 LLM call per click | 0 LLM calls per click |
| **Accuracy** | Coordinate guessing | Exact element targeting |
| **Works when UI shifts** | Can misclick | Always finds the right element |

## Setup (3 minutes)

### 1. Clone and build ScreenHand

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand
npm install
npm run build:native   # macOS — builds the Swift accessibility bridge
```

### 2. Grant accessibility permissions

macOS: System Settings > Privacy & Security > Accessibility > enable your terminal app.

### 3. Add to your OpenClaw config

Add this to your `openclaw.json`:

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

Replace `/path/to/screenhand` with where you cloned the repo.

That's it. Your Claw now has 16 native desktop tools.

## What Your Claw Can Now Do

### Control any app — instantly

```
session_start → get a sessionId
app_list → see all running apps
app_launch → open any app by bundle ID
app_focus → bring an app to the front
```

### Click anything — by name, not coordinates

```
press("Send")                    → clicks the Send button
press({role: "button", name: "Submit"})  → finds by ARIA role
press("css=.btn-primary")        → CSS selector (in browsers)
press({x: 500, y: 300})          → coordinates (fallback)
```

### Type into any field

```
type_into("Search", "hello world")    → finds the Search field, types into it
type_into("Email", "me@example.com")  → works with any text field
```

### Read the UI tree (like React DevTools for any app)

```
element_tree → returns the full accessibility tree
               roles, names, values, positions — everything
```

### Navigate browsers

```
navigate("https://example.com")  → opens URL in browser
navigate("app://com.apple.Safari") → launches Safari
```

### Keyboard shortcuts, menus, drag & drop

```
key_combo(["cmd", "c"])           → copy
menu_click(["File", "Save As..."]) → click menu items
drag(from: "Item 1", to: "Folder") → drag and drop
scroll("down", amount: 5)         → scroll
```

## Full Tool List

| Tool | What it does |
|------|-------------|
| `session_start` | Start automation session |
| `press` | Click a UI element |
| `type_into` | Type text into a field |
| `navigate` | Go to URL or launch app |
| `wait_for` | Wait for a condition |
| `extract` | Extract text/data from elements |
| `screenshot` | Capture the screen |
| `app_launch` | Launch an app |
| `app_focus` | Focus an app |
| `app_list` | List running apps |
| `window_list` | List open windows |
| `menu_click` | Click menu items |
| `key_combo` | Keyboard shortcuts |
| `element_tree` | Get UI element tree |
| `drag` | Drag and drop |
| `scroll` | Scroll in any direction |

## Adapter Options

ScreenHand supports multiple adapters via the `SCREENHAND_ADAPTER` env var:

| Adapter | Best for |
|---------|----------|
| `accessibility` (default) | Native macOS/Windows apps — fastest, most reliable |
| `cdp` | Chrome/browser-only automation via DevTools Protocol |
| `composite` | Auto-routes between accessibility + CDP per app |
| `placeholder` | Testing/development without a real OS connection |

## FAQ

**Q: Does this replace Clawd Cursor?**
No — it complements it. Use ScreenHand for fast, precise desktop actions. Keep Clawd Cursor for visual tasks where you need the AI to interpret what's on screen.

**Q: Does this work on Windows?**
Yes. Use `npm run build:native:windows` to build the C# bridge instead.

**Q: Does this require extra AI API calls?**
No. ScreenHand tools execute directly via OS APIs. The AI decides *what* to do, but the actions themselves are free and instant.

**Q: What if an app doesn't expose accessibility elements?**
Fall back to `screenshot` + OCR, or use the `cdp` adapter for browser apps. Most macOS and Windows apps expose accessibility elements.

---

**ScreenHand** — [github.com/manushi4/screenhand](https://github.com/manushi4/screenhand) | [screenhand.com](https://screenhand.com)
