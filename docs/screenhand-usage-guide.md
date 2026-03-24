# ScreenHand (sh) Usage Guide for Claude Code

**What this is:** A practical guide for using ScreenHand MCP tools inside Claude Code sessions. Read this before automating any desktop app or browser workflow.

---

## What is ScreenHand?

ScreenHand (`sh`) is an MCP server that gives you **eyes and hands on the desktop**. It's already connected to your Claude Code session as the `sh` MCP server. All tools are prefixed with `mcp__sh__`.

You can:
- Control Chrome tabs (navigate, click, type, extract data)
- Control desktop apps (focus, click, type, screenshot, read UI trees)
- Run multi-step automation jobs with playbook-driven execution
- Persist learnings across sessions — tools auto-inject playbook knowledge

---

## The Golden Rule: Assess → Discover → Learn → See → Act → Record

Every automation should follow this flow. **Don't skip the first steps.**

```
Step 0: ASSESS — What does ScreenHand already know?
  → coverage_report(bundleId, appName)
  → Check: selectors, flows, shortcuts, website features, error patterns
  → "0 selectors, 0 flows" → LEARN FIRST (Step 0b)
  → "Has selectors + flows" → GO (skip to Step 1)
  → "Website features: 0" → DISCOVER FIRST (Step 0a)

Step 0a: DISCOVER FEATURES (if website features = 0)
  → discover_features(url, bundleId, appName)
  → Fetches official app/site HTML, extracts real product features
  → Assigns difficulty tiers (beginner/pro/expert/grandmaster)
  → Generates value-add features (bulk ops, cross-app, summarize, organize, monitor)
  → Merges into reference file, enriches feature ladder
  → Do this BEFORE scan_menu_bar — features give meaningful ladder

Step 0b: LEARN STRUCTURE (if selectors/flows are low)
  → scan_menu_bar(pid, bundleId, appName) — discover shortcuts + menu structure
  → platform_explore(bundleId) — map all interactive elements
  → platform_guide(platform) — load curated selectors/flows/errors
  → memory_recall("task description") — reuse past strategies
  → learning_status(bundleId) — check which tools work best:
      AX score > 0.9 → use ui_press/ui_tree (fastest, ~50ms)
      CDP score high → it's a web app → use browser_* tools (~10ms)
      Vision score high → canvas app → use screenshot + ocr (~600ms)
      0 samples → unknown app → always use *_with_fallback

Step 1: SEE — Turn on awareness
  → perception_start() — continuous monitoring (AX 100ms, CDP 300ms, Vision 1s)
  → world_state() — verify windows + controls are tracked
  → If 0 controls → wait 1-2s for perception to populate, retry

Step 2: ACT + VERIFY — Do the work
  → Tool priority:
    1. ui_press / key / type_text — native AX, ~50ms (when AX score high)
    2. browser_* tools — CDP, ~10ms, background (web content)
    3. *_with_fallback — auto-tries AX → CDP → OCR (~100-500ms, when unsure)
    4. screenshot + ocr — visual (~600ms, canvas apps / visual verification)
    5. applescript — macOS scripting (Finder, Mail, bulk ops)
  → Read the Δ line after each action:
    "Δ controls: 690→728" → UI changed, action worked
    "Δ dialogs: 0→1" → dialog appeared, auto-dismiss handles it
    No Δ → nothing changed, action may have failed

Step 3: RECORD (optional — make it repeatable)
  → playbook_record(action="start", platform="notes")
  → ... do the workflow ...
  → playbook_record(action="clean") — auto-remove failed steps + retries
  → playbook_record(action="stop", name="my workflow") — save as reusable playbook

Step 4: STOP
  → perception_stop() — stop monitoring, save resources
  → memory_save("key", "strategy") — save what worked for next time
```

**The system gets smarter every session.** What you discover today helps every future session on that platform.

---

## STOP — Read This First (Common Mistakes)

### Mistake #1: Using session_start + navigate for browser automation

**WRONG:**
```
session_start(profile: "figma") → ax_session_figma_123
navigate(sessionId: "ax_session_figma_123", url: "https://figma.com")
→ ERROR: "Session not found"
```

**RIGHT:**
```
browser_tabs → get tab IDs (no session needed!)
browser_navigate(url: "https://figma.com", tabId: "ABC123")
browser_human_click(selector: "button", tabId: "ABC123")
```

**Why:** `session_start` creates an Accessibility adapter session (`ax_session_*`) for native desktop apps. It is NOT for browsers. Browser tools (`browser_*`) connect to Chrome via CDP directly — they don't need sessions. Sessions also get lost when the MCP server restarts between tool calls, causing "Session not found" errors.

**Rule:** For anything in Chrome (websites, web apps, Figma, etc.) → use `browser_*` tools. For native desktop apps (Finder, Codex, etc.) → use `focus` + `click`/`key`/`type_text`. You almost never need `session_start`.

### Mistake #2: Using native tools (click, key, type_text) for browser pages

These tools send OS-level events to the **frontmost app**. But Claude Code runs in VS Code/Terminal, which steals focus when it outputs text. So by the time `type_text` fires, VS Code is in front — not Chrome.

**Solution:** Use CDP browser tools (`browser_fill_form`, `browser_human_click`, `browser_js`) — they work regardless of which app is in front.

### Mistake #3: Not calling browser_tabs first

Tab IDs change when the MCP server restarts. Always call `browser_tabs` at the start of any browser workflow to get fresh IDs.

### Mistake #4: Ignoring playbook hints in tool responses

After every tool call, check the response for hint lines starting with ⚠, 💡, or 📋. These are **auto-injected from playbook knowledge** — known errors, preferred selectors, and job suggestions. Ignoring them means you'll repeat known failures.

```
⚠ Known issue (devpost): reCAPTCHA cannot be automated → poll manually
💡 Preferred selector (x-twitter): compose.tweet_box: [data-testid="tweetTextarea_0"]
📋 Playbook "twitter" has 12 steps (85% success). Use job_create(playbookId="twitter")
```

**Rule:** If you see a 📋 hint suggesting a playbook with executable steps, **use job_create** instead of manually clicking through.

### Mistake #5: Manually repeating what a playbook already knows

Before automating any platform, check if a playbook exists:
```
platform_guide(platform="twitter")  → see errors, selectors, flows
playbook_preflight(url="https://x.com", task="post tweet")  → feasibility check
```

If the playbook has steps → `job_create(task="...", playbookId="twitter")`. Don't re-do it manually.

### Mistake #6: Not calling session_release when done

Always call `session_release` when finished. This flushes learned selectors and error patterns back into the playbook so they're available next time.

---

## Tool Categories (The Ones You'll Actually Use)

### Browser Tools (90% of your work)

These control Chrome via CDP (Chrome DevTools Protocol). They work **in the background** — Chrome doesn't need to be the frontmost app.

| Tool | What it does | When to use |
|------|-------------|-------------|
| `browser_tabs` | List all open Chrome tabs with IDs | **Always call first** to get tab IDs |
| `browser_navigate` | Open a URL in a tab | Navigation to any page |
| `browser_js` | Run JavaScript in a tab | Extract data, check state, manipulate DOM |
| `browser_human_click` | Click an element (realistic mouse events) | Click buttons, links, UI elements |
| `browser_fill_form` | Type text with human-like delays | Fill inputs, search boxes, textareas |
| `browser_dom` | Query DOM elements | Find elements by CSS selector |
| `browser_wait` | Wait for a JS condition to be true | Wait for page load, element to appear |
| `browser_click` | Click by CSS selector (CDP mouse) | Alternative to human_click |
| `browser_stealth` | Apply anti-detection measures | Before automating sites that detect bots |
| `browser_open` | Open a new Chrome tab | When you need a fresh tab |

### Desktop Tools (for native apps)

| Tool | What it does | When to use |
|------|-------------|-------------|
| `focus` | Bring an app to front | Before using keyboard/click tools |
| `screenshot` | Take screenshot + OCR | See what's on screen |
| `click` | Click at screen coordinates (x, y) | Native app buttons |
| `key` | Press keyboard shortcuts | Cmd+C, Enter, Escape, etc. |
| `type_text` | Type text string | Type into focused field |
| `apps` | List running applications | Find app bundle IDs |
| `windows` | List open windows | Find window positions |
| `ui_tree` | Read accessibility tree | Discover UI elements |
| `ocr` | Extract text from screen region | Read text without screenshots |
| `menu_click` | Click app menu items | File > New, Edit > Copy, etc. |
| `launch` | Launch an application | Open apps by name or bundle ID |
| `applescript` | Run AppleScript | macOS-specific automation |

### Assessment & Discovery Tools (use FIRST)

| Tool | What it does | When to use |
|------|-------------|-------------|
| `coverage_report` | Check what ScreenHand knows: shortcuts, selectors, flows, playbooks, website features, error patterns, stability % | **Always call first** — decides your strategy |
| `learning_status` | Check which tools work best for this app: AX/CDP/Vision scores, samples collected | **Before choosing tools** — tells you AX vs CDP vs OCR |
| `discover_features` | Fetch official app website, extract real features, generate value-adds (bulk, cross-app, summarize, organize, monitor) | **When website features = 0** — gives meaningful feature ladder |

### Learning & Knowledge Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `scan_menu_bar` | Discover all menu items and keyboard shortcuts via AX tree scan | **First time** on a native app — maps menu structure |
| `platform_explore` | Autonomously discover and test all interactive UI elements | **First time** — map clickable elements, find working selectors |
| `platform_guide` | Get playbook knowledge — selectors, flows, errors, detection | **Before starting** — check what's already known |
| `platform_learn` | Scrape docs/help/shortcuts for a platform via CDP | **First time** on a web platform — bootstrap reference from docs |
| `playbook_preflight` | Quick feasibility check — scans for captchas, WebGL, shadow DOM, React quirks | **Before starting** any new web platform automation |

### Perception & World State Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `perception_start` | Turn on continuous monitoring (3 rates: AX 100ms, CDP 300ms, Vision 1s) | **Before multi-step workflows** — enables auto world_state_diff |
| `perception_stop` | Stop monitoring, save resources | **When done** with a workflow |
| `world_state` | Get current windows, controls, dialogs, focus state | **Verify** perception is tracking the right app |
| `world_state_diff` | See what changed since last check | **After actions** — auto-injected when perception is running |

### Fallback Tools (smart auto-retry)

| Tool | What it does | When to use |
|------|-------------|-------------|
| `click_with_fallback` | Auto-tries AX → CDP → OCR → window_buffer → coordinates | **When unsure** which method works for this app |
| `type_with_fallback` | Auto-tries AX → CDP → OCR input detection | **When unsure** how to type into a field |
| `scroll_with_fallback` | Auto-tries AX → CDP → native scroll | **When unsure** how to scroll in this app |
| `read_with_fallback` | Auto-tries AX → CDP → OCR to read text | **When unsure** how to extract text |
| `locate_with_fallback` | Find an element using all available methods | **When unsure** where an element is |
| `select_with_fallback` | Select from dropdown/menu using all methods | **When unsure** how to select an option |

### Playbook & Recording Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `playbook_record` | Macro recorder — captures your MCP tool calls as playbook steps | Record a task → instant reusable playbook |
| `export_playbook` | Save session learnings as a reusable playbook | **After finishing** a successful automation |
| `observer_start` | Start background daemon watching an app window (frame diff + OCR) | Apps with poor AX support (DaVinci, Adobe) |
| `observer_stop` | Stop the observer daemon | When done with visual monitoring |
| `observer_status` | Show observer frames, OCR text, popup detection | Check what the observer sees |

### Job Tools (auto-execute playbooks)

| Tool | What it does | When to use |
|------|-------------|-------------|
| `job_create` | Create a job, optionally with a playbookId for auto-execution. Supports `vars`, `dependsOn`, `chainId`. | When a playbook with steps exists — **preferred over manual execution** |
| `job_create_chain` | Create multiple linked jobs that run sequentially, with automatic dependency wiring | When you need a multi-job pipeline (e.g. submit prompt, wait, read response) |
| `job_run` | Execute a pending job | After job_create |
| `job_run_all` | Execute all queued jobs (respects chain dependencies) | After job_create_chain |
| `job_status` | Check job progress, step outputs, and chain/dependency info | Monitor running jobs |
| `job_list` | List all jobs | See what's queued |

### Memory Tools (persist learnings)

| Tool | What it does |
|------|-------------|
| `memory_save` | Save a learning for future sessions |
| `memory_recall` | Retrieve past learnings by topic |
| `memory_record_error` | Record an error pattern + fix |
| `memory_record_learning` | Record a discovery |

---

## Core Workflow Pattern

### Starting a New App/Platform (first time)

```
1. coverage_report(bundleId, appName)            → What do we know? (likely: nothing)
2. discover_features(url, bundleId, appName)     → Extract real features from official website
3. scan_menu_bar(pid, bundleId, appName)         → Map menu structure + shortcuts (native apps)
   OR platform_learn(url)                        → Scrape docs for web platforms
4. learning_status(bundleId)                     → Which tools work? AX vs CDP vs OCR
5. perception_start()                            → Turn on continuous monitoring
6. ... do the work using *_with_fallback tools ...
7. playbook_record(action="stop", name="...")    → Save as reusable playbook
8. perception_stop()                             → Stop monitoring
```

### Returning to a Known App (has coverage)

```
1. coverage_report(bundleId, appName)            → Verify knowledge is current
2. learning_status(bundleId)                     → Check best tools (AX/CDP/OCR scores)
3. perception_start()                            → Turn on awareness
4. ... execute using learned tool preferences ...
5. perception_stop()
```

### Using Playbooks (executable automation)

```
1. job_create(task="...", playbookId="twitter")  → Auto-execute via playbook
2. job_run(jobId)                                → Run it
3. job_status(jobId)                             → Check result
```

If the playbook doesn't have executable steps (only flows/selectors), fall back to manual with playbook guidance.

### Every Browser Automation (manual path)

Every browser automation follows this pattern:

```
1. coverage_report       → Check what's known (skip if quick action)
2. browser_tabs          → Get tab IDs
3. browser_navigate      → Go to the right page
4. browser_wait          → Wait for page to load
5. browser_js            → Extract data / check state
6. browser_human_click   → Interact with elements
7. browser_fill_form     → Type into inputs
8. browser_js            → Verify result
```

### Example: Like a post on Instagram

```
1. browser_tabs → find Instagram tab ID
2. browser_navigate → https://www.instagram.com/someuser/
3. browser_wait → "document.querySelector('article')" (wait for post to load)
4. browser_human_click → "svg[aria-label='Like']" (click Like button)
5. browser_js → verify "svg[aria-label='Unlike']" exists (confirmed liked)
```

### Example: Post a tweet on X

```
1. browser_tabs → find X tab ID
2. browser_human_click → "[data-testid='SideNav_NewTweet_Button']" (compose)
3. browser_wait → "[data-testid='tweetTextarea_0']" visible
4. browser_fill_form → type tweet text into the textbox
5. browser_human_click → "[data-testid='tweetButton']" (post)
```

---

## Critical Rules

### 1. Always get tab IDs first

```
browser_tabs → returns list of tabs with IDs
```
Pass the `tabId` parameter to all browser tools. Tab IDs change when the MCP server restarts, so **always call browser_tabs at the start** of any browser workflow.

### 2. Use the right click tool for the right situation

| Situation | Tool | Why |
|-----------|------|-----|
| Standard buttons, links | `browser_human_click` | Realistic mouse events, works on most elements |
| Dropdowns, menus that don't respond | JS dispatch | Some React apps need `mousedown+mouseup+click` sequence |
| Desktop app buttons | `click` (x, y coordinates) | Native OS-level click |
| WebGL canvas (Figma, etc.) | `browser_human_click` | CDP Input events work, DOM events don't |

**JS dispatch pattern** (for stubborn React elements like X/Twitter retweet button):
```javascript
const el = document.querySelector('[data-testid="retweet"]');
el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
el.dispatchEvent(new MouseEvent('click', {bubbles:true}));
```

### 3. Use the right typing tool for the right input

| Input type | Tool | Why |
|-----------|------|-----|
| Standard `<input>` | `browser_fill_form` | CDP key events, human-like delays |
| React controlled textarea (X DMs) | Native value setter via `browser_js` | React ignores CDP key events |
| ProseMirror/contenteditable (Codex) | `execCommand('insertText')` via `browser_js` | Only method ProseMirror accepts |
| Desktop app text fields | `type_text` | OS-level typing |

**Native value setter pattern** (for React textareas):
```javascript
const textarea = document.querySelector('textarea');
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
setter.call(textarea, 'your text here');
textarea.dispatchEvent(new Event('input', { bubbles: true }));
```

**execCommand pattern** (for contenteditable/ProseMirror):
```javascript
document.querySelector('.ProseMirror').focus();
document.execCommand('insertText', false, 'your text here');
```

### 4. Respect rate limits

Every platform has rate limits. Going too fast = account suspension.

| Platform | Guideline |
|----------|-----------|
| Instagram | 20-30 actions/hour, 3-5s between actions |
| X/Twitter | ~8 actions/hour, stricter on follows |
| LinkedIn | ~6 actions/hour |
| Reddit | ~4 actions/hour |

Add random delays (3-10s) between actions. Use `browser_stealth` before interacting with sites that detect automation.

### 5. VS Code steals focus

When Claude Code outputs text in VS Code terminal, VS Code becomes the frontmost app. This breaks `type_text`, `key`, `click` (native tools) because they target the frontmost app.

**Solution:** Use CDP browser tools (`browser_js`, `browser_human_click`, `browser_fill_form`) for browser automation — they work regardless of which app is in front. Only use native tools (`click`, `key`, `type_text`) when you specifically need desktop app control, and call `focus` immediately before.

---

## Two Knowledge Systems: Memory vs Playbooks

ScreenHand has **two separate knowledge systems** that serve different purposes. Understanding when to use each is critical.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  MEMORY (reference knowledge)          PLAYBOOK (automation recipe) │
│  ─────────────────────────             ───────────────────────────  │
│  "What happened & what I learned"      "How to do this task"        │
│                                                                     │
│  Stores:                               Stores:                      │
│  • Past action logs                    • Executable steps[]         │
│  • Error patterns + fixes              • CSS selectors by area      │
│  • Successful strategies               • Named flows with guards    │
│  • Session-specific learnings          • Known errors + solutions   │
│                                        • Detection expressions      │
│  Lives in: ~/.screenhand/memory/       • Platform URLs              │
│  Accessed via: memory_* tools                                       │
│  Auto-injected: YES (error hints)      Lives in: playbooks/*.json   │
│                                        Accessed via: platform_guide │
│  Best for:                                       + auto-injection   │
│  • "Has this tool failed before?"                                   │
│  • "What strategy worked last time?"   Best for:                    │
│  • Recording new discoveries           • "Run this task hands-free" │
│  • Guiding manual execution            • "What selectors work here?"│
│                                        • "What errors will I hit?"  │
│                                        • Repeatable automation      │
└─────────────────────────────────────────────────────────────────────┘
```

### Memory = Reference (guides you while you work manually)

Memory is the **diary**. It records what happened, what worked, what failed. Use it when:
- You're doing something **new** and want to check past experience
- You want to **save a discovery** for future sessions
- You hit an error and want to check if there's a **known fix**

Memory tools:
```
memory_recall(query="figma canvas click")     → "CDP Input.dispatchMouseEvent works, DOM clicks don't"
memory_record_error(tool, error, resolution)  → saves for future auto-warning
memory_record_learning(scope, pattern, fix)   → saves a verified pattern
memory_save(task, steps)                      → saves a successful strategy
```

Memory is **auto-injected** into tool responses via the wrapper — you'll see `⚡ Memory:` hints when a tool has failed before or matches a known strategy. You don't need to call `memory_recall` every time.

### Playbook = Executable (runs the task for you)

A playbook is the **recipe**. It contains everything needed to automate a platform. A playbook can be:

**1. Reference-only** (most current playbooks) — has `selectors{}`, `flows{}`, `errors[]` but NO `steps[]`:
```json
{
  "id": "figma",
  "selectors": { "toolbar": { "rectangle": "[data-testid='Rectangle-tool']" } },
  "flows": { "create_file": { "steps": ["Click new file button", "Wait for canvas"] } },
  "errors": [{ "error": "DOM clicks don't work on canvas", "solution": "Use CDP Input.dispatchMouseEvent" }]
}
```
→ You still do the work manually, but the playbook **tells you which selectors to use, what errors to expect, and how to fix them**. The ContextTracker auto-injects this as ⚠ and 💡 hints.

**2. Executable** — has a top-level `steps[]` array with machine-runnable actions:
```json
{
  "id": "canva-smoke-test",
  "steps": [
    { "action": "navigate", "url": "https://canva.com", "description": "Open Canva" },
    { "action": "press", "target": "[data-testid='create-button']", "description": "Click Create" },
    { "action": "wait", "ms": 2000, "description": "Wait for editor" }
  ]
}
```
→ This can run **hands-free** via `job_create(task="...", playbookId="canva-smoke-test")` + `job_run`. No manual work needed.

**3. Both** — has reference metadata AND executable steps. Best of both worlds: auto-runs the steps, and if a step fails, the AI recovery system uses the selectors/errors/flows to figure out what went wrong.

### The lifecycle: Discovery → Reference → Executable

Knowledge builds up across sessions:

```
Session 1: New app — nothing known
  → coverage_report() shows 0 selectors, 0 features
  → discover_features(url) → extracts real features from official website
  → scan_menu_bar() → maps menu structure + shortcuts
  → You automate manually using *_with_fallback tools
  → export_playbook() saves URLs, selectors, errors as REFERENCE playbook
  → Learning engine records which tools/selectors worked

Session 2: Reference exists
  → coverage_report() shows selectors, flows, website features
  → learning_status() shows AX/CDP/OCR scores → you pick the right tools
  → ContextTracker auto-injects hints (⚠ errors, 💡 selectors)
  → You work faster because you know what works

Session 3+: After enough successful runs
  → PlaybookRunner auto-saves successful step sequences as executable steps[]
  → Playbook becomes EXECUTABLE
  → job_create(playbookId=...) runs it fully automated
```

### Directory Structure

```
references/          ← Curated knowledge (selectors, flows, errors, detection)
  figma.json           Team-built, auto-injected by ContextTracker + memory seeds
  x-twitter.json       Read via platform_guide() or auto-hints
  instagram.json       ...
  ...

playbooks/           ← Executable only (steps[] with action objects)
  x-twitter.json       Runnable via job_create(playbookId="x-twitter")
  instagram.json       Stripped to just: id, steps, metadata
  ...
```

### Available References (curated knowledge)

| Platform | File | Contents |
|----------|------|----------|
| Figma | `references/figma.json` | Selectors, flows, detection, errors (131 successes) |
| X/Twitter | `references/x-twitter.json` | Selectors, flows, errors, policy notes |
| Instagram | `references/instagram.json` | Selectors, flows, errors, policy notes |
| LinkedIn | `references/linkedin.json` | Selectors, flows, errors |
| Threads | `references/threads.json` | Selectors, flows, errors |
| Reddit | `references/reddit.json` | Selectors, flows, errors |
| Discord | `references/discord.json` | Selectors, flows, errors |
| Devpost | `references/devpost.json` | Flows, detection, errors (captcha notes) |
| Dev.to | `references/devto.json` | Selectors, flows, errors |
| YouTube | `references/youtube.json` | Selectors, flows, errors |
| n8n | `references/n8n.json` | Selectors, flows, errors |
| Codex Desktop | `references/codex-desktop.json` | Architecture, CDP, selectors |
| DaVinci Resolve | `references/davinci-resolve-*.json` | Menu maps, shortcuts |
| Canva | `references/canva-smoke-test.json` | Selectors with test results |
| X (legacy) | `references/x_v1.json`, `references/twitter.json` | Older X reference data |

### Available Executable Playbooks

| Platform | File | Steps |
|----------|------|-------|
| X/Twitter | `playbooks/x-twitter.json` | 7 steps (navigate, extract, scroll) |
| Instagram | `playbooks/instagram.json` | 7 steps |
| LinkedIn | `playbooks/linkedin.json` | 6 steps |
| Threads | `playbooks/threads.json` | 7 steps |
| Reddit | `playbooks/reddit.json` | 6 steps |
| Discord | `playbooks/discord.json` | 4 steps |
| Dev.to | `playbooks/devto.json` | 6 steps |
| YouTube | `playbooks/youtube.json` | 7 steps |
| n8n | `playbooks/n8n.json` | 4 steps |
| X change avatar | `playbooks/x_change_avatar.json` | Custom steps |
| Codex Desktop | `playbooks/codex-desktop.json` | 10 steps (CDP: browser_js, cdp_key_event, variable substitution) |

### How to use each type

**Reference playbook (no steps[]):**
```
1. platform_guide(platform="figma")           → Read selectors, flows, errors
2. Use the selectors from flows in your browser_* calls
3. Follow the flow steps as your manual guide
4. Check errors[] before trying something the playbook warns about
   (or just read the ⚠ hints auto-injected into tool responses)
```

**Executable playbook (has steps[]):**
```
1. job_create(task="Smoke test Canva", playbookId="canva-smoke-test")
2. job_run(jobId)                             → Runs all steps automatically
3. job_status(jobId)                          → Check if it succeeded
   If a step fails → AI recovery kicks in → patches playbook for next time
```

### When to use platform_guide vs rely on auto-injection

| Situation | What to do |
|-----------|-----------|
| Starting automation on a platform | Call `platform_guide(platform)` once to see the full picture |
| Mid-execution | Just read the ⚠/💡/📋 hints in tool responses — they're auto-injected |
| Hit an error | Check `platform_guide(platform, section="errors")` for known solutions |
| Want to see all selectors | `platform_guide(platform, section="selectors")` |
| Want to see step-by-step flows | `platform_guide(platform, section="flows")` |

### Playbook JSON structure

```json
{
  "id": "platform-name",
  "name": "Human readable name",
  "platform": "platform",
  "version": "1.0.0",
  "successCount": 0,
  "failCount": 0,

  "steps": [ ... ],          // EXECUTABLE: machine-runnable PlaybookStep objects
                              // Actions: navigate, press, type_into, extract, key_combo, scroll, wait, screenshot, browser_js, cdp_key_event

  "selectors": {             // REFERENCE: CSS selectors grouped by UI area
    "toolbar": { "search": "[data-testid='search']", "menu": "[aria-label='Menu']" },
    "editor": { "canvas": "canvas.main", "save": "[data-testid='save']" }
  },

  "flows": {                 // REFERENCE: human-readable step sequences with guards
    "login": {
      "steps": ["Navigate to /login", "Fill email field", "Fill password", "Click submit"],
      "guards": ["Must not be already logged in"],
      "why": "Why this flow works this way"
    }
  },

  "errors": [                // REFERENCE: known pitfalls (auto-injected as ⚠ hints!)
    {
      "error": "el.click() doesn't work on canvas",
      "context": "Figma editor WebGL canvas",
      "solution": "Use CDP Input.dispatchMouseEvent via browser_human_click",
      "severity": "high"
    }
  ],

  "detection": {             // REFERENCE: JS expressions to check page state
    "is_logged_in": "!!document.querySelector('[data-testid=\"home\"]')",
    "is_editor": "!!document.querySelector('canvas')"
  },

  "urls": {                  // REFERENCE: named URLs for the platform
    "home": "https://platform.com",
    "editor": "https://platform.com/editor/{id}"
  },

  "policyNotes": {           // REFERENCE: rate limits, safety rules
    "rate_limits": ["Max 8 posts/hour", "3-5s delay between actions"]
  }
}
```

### Creating & Improving Playbooks

**Automatic improvement (every session, zero effort):**
- ContextTracker collects tool outcomes in-memory during execution
- On `session_release` (or every 50 tool calls), it flushes:
  - Selectors that worked 2+ times → added to `selectors.auto_discovered`
  - Error patterns seen 2+ times → added to `errors[]`
- PlaybookRunner (via jobs) saves successful AI step sequences as `steps[]`
- One atomic disk write — no performance cost during execution

**Manual export (when you want to save a full playbook):**
```
export_playbook(platform="twitter", domain="x.com", description="Twitter automation")
```
Pulls URLs, selectors, errors, and strategies from memory → saves to `references/twitter.json`.

**Converting reference → executable:**
To add executable steps to a reference playbook, either:
1. Use `job_create` without a playbookId — PlaybookRunner uses AI mode, and on success auto-saves the step sequence as a new playbook
2. Manually add a `steps[]` array to the playbook JSON following the PlaybookStep format

---

## Common Patterns

### Extract data from a page

```javascript
// browser_js — extract all post texts
(() => {
  const posts = document.querySelectorAll('article');
  return Array.from(posts).map(p => ({
    user: p.querySelector('header a')?.textContent,
    text: p.querySelector('[data-testid="tweetText"]')?.textContent
  }));
})()
```

### Wait for navigation

```javascript
// browser_wait — wait for URL change
window.location.href.includes('/design/')
```

### Check if logged in

```javascript
// browser_js — platform-specific checks
!!document.querySelector('[data-testid="AppTabBar_Home_Link"]')  // X/Twitter
!!document.querySelector('svg[aria-label="Home"]')                // Instagram
```

### Handle dialogs/modals

```javascript
// browser_js — find and click confirmation buttons
const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
if (confirm) confirm.click();
```

### Search on a platform

For most platforms, **direct URL navigation** is more reliable than typing in search boxes:
```
browser_navigate → https://x.com/search?q=your+query&src=typed_query
browser_navigate → https://www.instagram.com/explore/search/keyword/
```

---

## Job Chaining & Variable Substitution

Jobs can be linked into sequential chains where each job waits for the previous one to finish. Combined with variable substitution and step output capture, this enables multi-stage automation pipelines.

### Job Chaining

Use `dependsOn` to make a job wait for another, and `chainId` to group related jobs:

```
job_create(task="Submit prompt", playbookId="codex-desktop", chainId="codex-flow-1",
           vars={"PROMPT_TEXT": "Refactor the auth module"})
  → returns job ID: j_abc

job_create(task="Read response", playbookId="codex-reader", chainId="codex-flow-1",
           dependsOn="j_abc",
           vars={"RESPONSE_KEY": "{prev.Read_Codex_response}"})
  → returns job ID: j_def (won't dequeue until j_abc is done)
```

Or use `job_create_chain` to wire everything in one call:

```
job_create_chain(jobs=[
  { task: "Submit prompt to Codex", playbookId: "codex-desktop",
    vars: { "PROMPT_TEXT": "Fix the login bug" } },
  { task: "Read Codex response", playbookId: "codex-reader",
    vars: { "RESPONSE_KEY": "{prev.Read_Codex_response}" } }
])
```

This creates both jobs with a shared `chainId` and automatic `dependsOn` wiring. Run the chain with `job_run_all`.

### Variable Substitution

The `vars` field on `job_create` passes key-value pairs into playbook steps. Any `{KEY_NAME}` placeholder in step fields (`text`, `code`, `url`, `description`, `verify`) gets replaced at runtime:

```json
// Playbook step:
{ "action": "browser_js", "code": "document.execCommand('insertText', false, '{PROMPT_TEXT}')" }

// job_create call:
job_create(playbookId="codex-desktop", vars={"PROMPT_TEXT": "Build a REST API"})

// At runtime, step becomes:
{ "action": "browser_js", "code": "document.execCommand('insertText', false, 'Build a REST API')" }
```

**Cross-job data passing** with `{prev.outputKey}`: when a job depends on another via `dependsOn`, its vars can reference the dependency's captured outputs. At dequeue time, `{prev.Read_Codex_response}` resolves to the matching output from the completed dependency.

### Step Output Capture

Every completed step saves its return value to `step.output`. These are also aggregated into `job.outputs` (keyed by step index and by a sanitized version of `step.description`). View them via `job_status`:

```
job_status(jobId="j_abc")
→ Steps:
  ✓ [0] Wait for Codex UI to settle
  ✓ [1] Focus the ProseMirror editor
      → browser_js: focused
  ...
  ✓ [8] Read Codex response from the thread
      → browser_js: The auth module has been refactored...
```

The `job.outputs` map makes these values available for downstream jobs in a chain via `{prev.outputKey}`.

---

## New PlaybookStep Actions

Two actions execute directly via Chrome DevTools Protocol (CDP), bypassing the native accessibility bridge entirely. They require the playbook engine to have a CDP connection (via `setCDPConnect`).

### `browser_js` — Evaluate JavaScript in the browser

Runs arbitrary JavaScript in the active browser tab via `Runtime.evaluate`. Supports async code (`awaitPromise: true`). The return value becomes the step's captured output.

```json
{
  "action": "browser_js",
  "code": "document.querySelector('.result').textContent",
  "description": "Read the result element"
}
```

### `cdp_key_event` — Dispatch key events via CDP

Sends `Input.dispatchKeyEvent` (keyDown + keyUp) directly to the browser. Useful for keyboard shortcuts that don't work through OS-level key simulation (e.g. Cmd+Enter in Electron apps).

```json
{
  "action": "cdp_key_event",
  "keyEvent": { "key": "Enter", "code": "Enter", "modifiers": 4, "windowsVirtualKeyCode": 13 },
  "description": "Submit with Cmd+Enter"
}
```

Modifier values: `1` = Alt, `2` = Ctrl, `4` = Meta/Cmd, `8` = Shift. Combine with bitwise OR (e.g. `12` = Cmd+Shift).

### `cdpPort` field on playbooks

Playbooks targeting Electron apps (like Codex Desktop) can set `"cdpPort": 9333` at the top level. The engine passes this port to the CDP connection factory so it connects to the right debugging port instead of the default.

---

## Codex Desktop Playbook Example

The `codex-desktop` playbook (`playbooks/codex-desktop.json`) demonstrates chaining, variable substitution, and CDP actions together. It automates a full Codex prompt cycle: focus editor, type prompt, submit, wait for completion, read response.

### Key techniques used

1. **`cdpPort: 9333`** — connects to Codex's Electron debugging port
2. **`browser_js` steps** — interact with ProseMirror contenteditable (regular DOM clicks/types don't work)
3. **`{PROMPT_TEXT}` variable** — injected via `vars` at job creation time
4. **`cdp_key_event` with modifiers:4** — sends Cmd+Enter to submit the prompt
5. **Polling wait** — a `browser_js` step with a Promise that polls every 2s for completion signals (max 120s)
6. **Output capture** — the "Read Codex response" step returns thread text, saved to `job.outputs` for downstream jobs

### Running a Codex chain

```
job_create_chain(jobs=[
  { task: "Submit: Refactor auth module",
    playbookId: "codex-desktop",
    vars: { "PROMPT_TEXT": "Refactor the auth module to use JWT tokens" } },
  { task: "Submit follow-up: Add tests",
    playbookId: "codex-desktop",
    vars: { "PROMPT_TEXT": "Now add unit tests for the refactored auth module" } }
])
→ Chain created: chain_xyz (2 jobs)
  j_001: Submit: Refactor auth module (first)
  j_002: Submit follow-up: Add tests (after j_001)

job_run_all()
→ Executes j_001 fully, then j_002
```

Each job in the chain runs the full playbook (clear editor, type prompt, submit, wait, read response) with its own `PROMPT_TEXT`.

---

## Platform Discovery Tools

Three tools for rapidly learning about new platforms and building automation without manual exploration.

### `platform_learn` — Scrape docs, shortcuts, and features

Crawls a platform's official documentation, help center, and changelog pages via CDP. Extracts keyboard shortcuts, interactive element selectors, features, API endpoints, and known limitations. Saves as a reference JSON.

```
platform_learn(platform="canva", rootUrl="https://canva.com", maxPages=5)
→ Crawled 4 docs pages. Found 12 shortcuts, 28 features.
→ Saved to references/canva-learned.json
```

Use this when you're automating a platform for the first time and want to bootstrap a reference file with shortcuts, selectors, and features — instead of discovering them one-by-one during execution.

### `platform_explore` — Autonomously map an app's UI

Discovers all interactive elements on a web page (via CDP) or native app (via AX bridge), then tests each one by clicking and recording the result. Produces a reference JSON with working selectors, navigation links, and broken elements.

```
# Web app (via CDP)
platform_explore(platform="canva", source="web", url="https://canva.com/design/editor")
→ Found 47 interactive elements, 31 clickable, 8 broken, 3 skipped (dangerous)
→ Saved to references/canva-explore.json

# Native app (via AX bridge)
platform_explore(platform="figma", source="native", bundleId="com.figma.Desktop")
→ Found 23 AX elements, 18 clickable
→ Saved to references/figma-explore.json
```

Dangerous buttons (delete, logout, sign out, etc.) are automatically skipped. Use this to rapidly map an unfamiliar app's UI before writing playbook steps.

### `playbook_record` — Macro recorder for MCP tool calls

Records your MCP tool calls as you work and saves them as an executable playbook. Like a macro recorder, but for AI tool calls.

```
# Start recording
playbook_record(action="start", platform="canva", cdpPort=9222)
→ Recording started for canva

# ... do your work using browser_*, click, type_text, etc. ...
# Every action tool call is captured as a PlaybookStep

# Check progress
playbook_record(action="status")
→ Recording: canva, 7 steps captured

# Stop and save
playbook_record(action="stop", name="Canva Create Design", description="Creates a new design from template")
→ Saved playbook: canva-m1abc.json (7 steps)

# Or cancel without saving
playbook_record(action="cancel")
```

The recorder automatically:
- Skips observation-only tools (ui_tree, browser_dom, memory_*, etc.)
- Maps MCP tool names to PlaybookStep actions (browser_navigate→navigate, click→press, etc.)
- Deduplicates consecutive identical steps
- Marks failed steps as `optional: true`

**Best workflow:** Have an expert do the task once while recording → instant executable playbook.

### Discovery → Playbook Pipeline

Combine all three for fastest ramp-up on a new platform:

```
1. platform_learn(platform="canva")           → Bootstrap reference from docs
2. platform_explore(platform="canva", ...)    → Map actual UI elements
3. playbook_record(action="start", ...)       → Start recording
4. ... do the task manually once ...          → Expert walkthrough
5. playbook_record(action="stop", ...)        → Save as executable playbook
6. job_create(playbookId="canva-m1abc")       → Now it runs hands-free
```

---

## Observer Daemon — Continuous App Monitoring

For apps with poor accessibility support (DaVinci Resolve, Adobe, Blender), the observer daemon provides continuous visual awareness without slowing down the engine.

### Architecture

```
Observer Daemon (background process)        Engine (fast path)
─────────────────────────────────          ─────────────────
  cg.captureWindow (app-level)              Reads state.json
  → MD5 frame diff (skip if same)           → Pre-step popup check
  → OCR only when pixels change             → locateByOcr resolve
  → Popup pattern matching                  → Zero overhead if no popup
  → Write state.json (atomic)
```

The daemon runs independently. The engine's hot path just reads a JSON file — no screenshots, no OCR, no CPU cost.

### Usage

```
# 1. Get the window ID
windows → find your app's window ID

# 2. Start observing
observer_start(bundleId="com.blackmagic-design.DaVinciResolve", windowId=1234, intervalMs=2000)

# 3. Check what the observer sees
observer_status → shows OCR text, popup detection, frame stats

# 4. Run your playbook — popups auto-dismissed, OCR locate available
job_create(playbookId="davinci-color-grade")
job_run(jobId)

# 5. Stop when done
observer_stop
```

### Popup Auto-Dismiss

The observer matches OCR text against known popup patterns:
- Save dialogs → clicks "Don't Save"
- Permission prompts → clicks "Allow"
- Cookie banners → clicks "Accept"
- Update nags → clicks "Later"
- Chrome control banner → presses Escape

If the playbook engine has `popupCheck` enabled (automatic when observer starts), it reads the observer state before each step and dismisses any detected popup.

### Visual Locate (locateByOcr)

Playbook steps can find targets by OCR text instead of CSS selectors:

```json
{
  "action": "press",
  "locateByOcr": "Color Wheels",
  "offsetX": 400, "offsetY": 300,
  "description": "Click below Color Wheels label"
}
```

The engine checks observer OCR for the text, then clicks at the offset coordinates. Works on any app regardless of accessibility support.

### Frame Diff Efficiency

The daemon hashes each captured frame (MD5). If the hash matches the previous frame, OCR is skipped entirely. This means:
- Static screens (waiting for render) → near-zero CPU
- Active screens (user interacting) → OCR only on actual changes
- Typical ratio: 80-90% of frames are skipped

---

## Desktop App Automation

For native macOS/Windows apps (not browser):

```
1. apps            → list running apps, find bundle ID
2. focus           → bring the app to front (REQUIRED before native interactions)
3. ui_tree         → discover all UI elements and their roles
4. screenshot/ocr  → see what's on screen
5. click/key       → interact via coordinates or keyboard
6. menu_click      → use app menus (e.g., "File/New Thread")
```

### Electron Apps (Codex, VS Code, Slack, etc.)

Electron apps are special — they're web apps in a Chromium shell. You can use **both** native tools AND CDP:

1. Launch with `--remote-debugging-port=XXXX` to enable CDP
2. Use `browser_tabs` / `browser_js` / `browser_human_click` for web content
3. Use `menu_click` for native menus
4. See `playbooks/codex-desktop.json` for the proven Codex approach

---

## Debugging Tips

| Problem | Solution |
|---------|----------|
| Element not found | Use `browser_dom` to check if selector exists. Try `browser_js` with `document.querySelector()` |
| Click doesn't work | Try `browser_human_click` first. If that fails, try JS dispatch (mousedown+mouseup+click). Check if element is inside an iframe. |
| Typed text disappears | The input might be React-controlled. Use native value setter pattern (see above). |
| Page looks different than expected | Take a `screenshot` or use `browser_js` to read `document.title` and `window.location.href` |
| Tab ID invalid | Call `browser_tabs` again — IDs change on MCP server restart |
| Native click hits wrong spot | Use `screenshot` to verify coordinates. Screen coordinates differ from browser viewport coordinates. |
| Timeout errors | The native bridge can timeout under heavy load. Use browser tools (CDP) as fallback — they're faster and more reliable. |

---

## Quick Reference: Tool Selection

```
Need to...                          → Use this tool
─────────────────────────────────────────────────────
BEFORE STARTING (do these first!)
  Check if a site is automatable    → playbook_preflight(url, task)
  See what's known about a platform → platform_guide(platform)
  Auto-run a known playbook         → job_create(task, playbookId) + job_run
  Learn a platform from its docs    → platform_learn(platform, rootUrl)
  Map all UI elements automatically → platform_explore(platform, source, url)
  Record actions as a playbook      → playbook_record(action="start/stop")
  Watch an app window continuously  → observer_start(bundleId, windowId)

BROWSER AUTOMATION
  See what tabs are open            → browser_tabs
  Go to a URL                       → browser_navigate
  Click a button in Chrome          → browser_human_click
  Type in a form field              → browser_fill_form
  Run JS / extract data             → browser_js
  Wait for something to load        → browser_wait

DESKTOP AUTOMATION
  Click in a desktop app            → focus + click
  Type in a desktop app             → focus + type_text
  Press keyboard shortcut           → focus + key
  Take a screenshot                 → screenshot
  Read all text on screen           → ocr
  Find UI elements in native app    → ui_tree
  Open an app                       → launch
  Use app menu (File, Edit, etc.)   → menu_click

AFTER FINISHING (do these last!)
  Save session as playbook          → export_playbook(platform, domain)
  Release session + flush learnings → session_release(sessionId)
  Remember something specific       → memory_save / memory_record_learning
  Recall past learnings             → memory_recall
```

---

## How the Auto-Learning Loop Works

```
┌──────────────────────────────────────────────────────────────┐
│  You call browser_navigate("https://x.com")                 │
│    → ContextTracker detects domain: "x.com"                  │
│    → Matches playbook: "x-twitter"                           │
│    → Caches errors, selectors, flows (one-time, ~0ms)        │
│                                                              │
│  You call browser_human_click(selector: "button.tweet")      │
│    → ContextTracker checks: any known errors for click + x.com? │
│    → Injects: "⚠ el.click() fails on React — use human_click" │
│    → Tool executes normally                                   │
│    → Records outcome: {tool, selector, success, domain}       │
│                                                              │
│  ... 48 more tool calls, all collecting outcomes ...          │
│                                                              │
│  You call session_release(sessionId)                         │
│    → Flush: selectors that worked 2+ times → playbook        │
│    → Flush: errors seen 2+ times → playbook                  │
│    → One atomic disk write to playbooks/x-twitter.json        │
│                                                              │
│  NEXT SESSION on x.com:                                      │
│    → Playbook is richer — more selectors, more known errors   │
│    → Hints are more accurate                                  │
│    → If steps[] exist → job_create auto-executes it           │
└──────────────────────────────────────────────────────────────┘
```

**Cost of auto-learning:** Zero extra latency, zero LLM calls, zero disk I/O during execution. All in-memory map lookups and array pushes. Only one disk write on session end.

---

## File Locations

| What | Where |
|------|-------|
| Reference knowledge | `references/*.json` — selectors, flows, errors, detection |
| Executable playbooks | `playbooks/*.json` — steps[] only, runnable via job_create |
| Context tracker | `src/context-tracker.ts` |
| Playbook seeds | `src/memory/playbook-seeds.ts` — loads references into memory |
| MCP server code | `mcp-desktop.ts` |
| Native bridge (macOS) | `native/macos-bridge/` |
| Memory storage | `~/.screenhand/memory/` |
| Job queue | `~/.screenhand/jobs/` |
| Session locks | `~/.screenhand/locks/` |
| This guide | `docs/screenhand-usage-guide.md` |
