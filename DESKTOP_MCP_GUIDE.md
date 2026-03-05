# Desktop Automation MCP — Usage Guide

You have access to a desktop automation MCP server that can control any macOS application and Chrome browser. Use it for app debugging, design inspection, UI testing, and automation.

## Quick Reference

### How to discover what's on screen
1. `apps` → get running apps with PIDs
2. `windows` → get window IDs and positions
3. `ui_tree(pid, maxDepth)` → get full UI structure instantly (50ms, no OCR)
4. `screenshot(windowId)` → capture + OCR a window (600ms, use when you need visual text)

### How to interact with native macOS apps (Finder, Notes, Xcode, etc.)
- **Read UI structure**: `ui_tree(pid=1234, maxDepth=4)` — returns every button, menu, text field with positions
- **Find element**: `ui_find(pid=1234, title="Save")` — find by text
- **Click element**: `ui_press(pid=1234, title="Save")` — click by accessibility
- **Click menu**: `menu_click(pid=1234, menuPath="File/Save As...")` — click any menu item
- **Set text**: `ui_set_value(pid=1234, title="Search", value="hello")`
- **Key combo**: `key(combo="cmd+s")` or `key(combo="cmd+shift+n")`

### How to interact with Chrome/web pages (FAST — use this, not OCR)
- **List tabs**: `browser_tabs()`
- **Open URL**: `browser_open(url="https://example.com")`
- **Run JS**: `browser_js(code="document.title")` — execute any JavaScript, returns result
- **Query DOM**: `browser_dom(selector="button.primary")` — find elements with text, positions, attributes
- **Click element**: `browser_click(selector="#submit-btn")`
- **Type in input**: `browser_type(selector="input[name=search]", text="hello")`
- **Wait for load**: `browser_wait(condition="document.querySelector('.results')")`
- **Page content**: `browser_page_info()` — title, URL, text content

### How to use AppleScript
- `applescript(script='tell application "Finder" to get name of every file of desktop')`
- `applescript(script='tell application "Safari" to set URL of current tab of front window to "https://google.com"')`

## Rules & Best Practices

### Speed hierarchy — always prefer the fastest method:
1. **Accessibility (ui_tree, ui_press, menu_click)** — 50ms, structured, reliable. Use for ALL native app interactions.
2. **CDP (browser_js, browser_dom, browser_click)** — 10ms, structured. Use for ALL web/browser interactions.
3. **AppleScript** — 50ms, for app-specific scripting (Finder files, Safari URLs, Mail compose).
4. **OCR (screenshot, click_text)** — 600ms, last resort. Only use when AX and CDP aren't available.

### For app debugging:
- Start with `apps` to find the PID
- Use `ui_tree(pid, maxDepth=4)` to see the full UI hierarchy — every button, text field, label, with positions
- Use `ui_tree(pid, maxDepth=6)` for deep inspection of complex views
- Use `screenshot(windowId)` only when you need to see actual rendered text/images

### For design inspection:
- `screenshot_file(windowId)` returns the image path — you can read it to see the actual design
- `ui_tree` shows the component structure (like React DevTools but for any app)
- `browser_dom(selector="*")` with limit shows the DOM tree of any web page
- `browser_js` can extract computed styles: `getComputedStyle(el).color`

### For web app debugging:
- Use `browser_js` to run any debugging code — console.log, inspect state, check network
- Use `browser_dom` to find elements and their properties
- Use `browser_wait` before interacting with dynamic content
- Chain: `browser_navigate` → `browser_wait` → `browser_dom` → `browser_click`

### Common patterns:

**Debug a native app's UI:**
```
apps → find pid
ui_tree(pid, 4) → see structure
ui_find(pid, "button text") → locate element
ui_press(pid, "button text") → interact
```

**Debug a web page:**
```
browser_tabs → find the tab
browser_dom("main", tabId) → see page structure
browser_js("document.querySelector('.error')?.textContent", tabId) → inspect
```

**Automate a flow:**
```
launch(bundleId) → open app
ui_tree(pid, 3) → understand layout
menu_click(pid, "File/New") → trigger action
ui_set_value(pid, "Name", "test") → fill form
ui_press(pid, "Save") → submit
```

### Important notes:
- Chrome must be running with `--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug` for browser_* tools
- PIDs change when apps restart — always call `apps` first to get current PIDs
- Window IDs change when windows are recreated — call `windows` to get current IDs
- `ui_tree` requires Accessibility permissions (System Settings → Privacy → Accessibility)
- For clicking by coordinates, use `click(x, y)` — coordinates are screen-absolute
