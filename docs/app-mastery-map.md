# Layer 7: App Mastery Map

> **Status**: Phase 1 + Phase 2 BUILT — all 8 reverse-engineering features live and recording data from real app interactions.

> **The problem**: ScreenHand's learning layer (Layer 5) learns *which method works* but not *what the app looks like*. Every session, it fumbles like it's seeing the app for the first time — because spatially, it is. It has flashcards but no picture.

> **The solution**: Build a persistent **App Architecture Map** — a complete reverse-engineered model of each application's UI, stored as JSON, validated against the live screen, and continuously updated. Like a human: slow the first time, then "abhi krke deta hu" at expert speed.

> **The vision**: Not just a random road map — a complete HD blueprint with every possible option. Full reverse engineering: we take a running app and understand its UI, UX, flows, states, and behavior — the way a design team created it, but discovered in reverse from pure observation.

---

## Current State (Phase 1 + Phase 2 — Built)

### What exists today

| Component | Status | Location |
|-----------|--------|----------|
| `AppMapData` types + interfaces | DONE | `src/state/app-map-types.ts` |
| `AppMap` class (load/save/CRUD/BFS/mastery) | DONE | `src/state/app-map.ts` (~2200 lines, 18+ methods) |
| `TopologyPolicy` (6th learning policy) | DONE | `src/learning/topology-policy.ts` |
| LearningEngine integration | DONE | `src/learning/engine.ts` |
| Context tracker + page context | DONE | `src/context-tracker.ts` |
| mcp-desktop intelligence wrapper (all 8 features) | DONE | `mcp-desktop.ts` (POST-CALL pipeline) |
| Perception coordinator validation | DONE | `src/perception/coordinator.ts` |
| Tests (201 tests: 160 base + 41 security) | DONE | `tests/app-map.test.ts`, `tests/topology-policy.test.ts` |
| App maps auto-generated | DONE | `~/.screenhand/app-maps/` |
| 103 bugs tracked, 96+ fixed | DONE | `docs/l2-bug-tracker.md` |

### Phase 2 — All 8 Features Live

Every feature records data automatically from normal tool usage. No special commands needed.

| Feature | What It Does | Trigger Tools | Data Generated |
|---------|-------------|---------------|----------------|
| **2a Page Zones** | Routes elements to `page::` zones by window title | All tools with locator targets | Per-page element maps, `global::sidebar` for cross-page elements |
| **2b Navigation Graph** | Records page transitions, builds BFS-navigable graph | Any tool that changes window title | Nodes (pages), edges (transitions), verified flag after 2+ uses |
| **2c Hierarchy** | Extracts parent/child containment from UI structure | `ui_tree`, `ui_find`, `screenshot`, `ocr` | Parent-children groups from AX tree indentation or OCR spatial grouping |
| **2d I/O Contracts** | Records what elements DO when interacted with | `click`, `click_text`, `type_text`, `key`, `menu_click` | Element→action→outcomes with reliability scoring |
| **2e State Machine** | Tracks UI state dimensions (modal open/closed, sidebar state) | `key` (Cmd+K, Escape, Cmd+\\), keyword detection in results | State dimensions, transitions, triggers, auto-reversibility |
| **2f Visibility** | Tracks which elements appear on which pages | `screenshot`, `ocr`, `ui_tree`, `click_text` (every 3rd call) | Per-element visibility rate, page-specific vs global classification |
| **2g Timing** | Records per-element response times | `click`, `click_text`, `type_text`, `key`, `browser_click` | Running averages with sample counts |
| **2g Ready Signals** | Detects when app is "ready" after an action | `browser_wait`, `wait_for_state`, slow interactions (>1.5s), screenshot after click | After-action ready signals with typical/max durations |

### Real maps — live Notion data

| Metric | Phase 1 (old) | Phase 2 (current) |
|--------|--------------|-------------------|
| Zones | 1 (flat `auto_discovered`) | **6** (4 page + 1 global + 1 auto) |
| Elements | 66 in 1 zone | **77** across 6 zones, page-routed |
| Nav graph | 2 nodes, 1 edge | **6 nodes, 11 edges** (2 verified) |
| Hierarchy | 0 | **5 entries** (Recents→pages, Private→pages, etc.) |
| Contracts | 0 | **7** (click_text outcomes tracked) |
| State machine | 0 | **1 dim** (modal_state: open/closed via Cmd+K/Escape) |
| Visibility | 0 | **71 conditions** (per-page element tracking) |
| Timing profiles | 0 | **7** (click_text: 520-864ms, key: 156ms) |
| Ready signals | 0 | **1** (click_text→page_ready: 484ms) |

### How It Works — Automatic Recording Pipeline

Every `server.tool()` call (57 tools) goes through the intelligence wrapper in `mcp-desktop.ts`. Phase 2 data is recorded automatically in the POST-CALL pipeline:

```
POST-CALL (on success, bundleId known):
  1. recordElementOutcome()       → routes to page-specific zone
  2. recordContract()             → what this action did (I/O contract)
  3. recordStateChange()          → structural (Cmd+K=modal) + keyword detection
  4. recordHierarchy()            → AX tree or OCR spatial grouping
  5. recordElementVisibility()    → every 3rd inspection tool call
  6. recordTiming()               → per-element response time
  7. recordReadySignal()          → wait tools + slow responses + post-nav screenshots
  8. recordPageTransition()       → nav graph edge from page context change
```

**Key fix**: `lastKnownBundleId` survives transient `focusedApp` loss from `app_deactivated` events, ensuring all tools (including `click_text`, `key`, `click`) record to the correct app map.

---

## How a Human Learns an App

```
Stage 1 — BEGINNER: "Where is everything?"
  Open every menu, click around, get lost, read docs.
  Slow. Lots of mistakes. But building the mental map.

Stage 2 — PRO: "I know where things are"
  Navigate without searching. Know which panel does what.
  Faster. Fewer mistakes. Map is mostly complete.

Stage 3 — EXPERT: "I know the shortcuts"
  Muscle memory. Skip menus, use keyboard. Know every dialog.
  Fast. Rare mistakes. Map is complete + optimized.

Stage 4 — GRANDMASTER: "I can teach others"
  Knows edge cases, hidden features, fastest paths.
  Maximum speed. Near-zero mistakes. Map is battle-tested.
```

ScreenHand follows the same progression — and honestly reports where it is.

---

## The Full Reverse-Engineering Stack (Phase 2)

A real app map requires 7 layers of understanding. This is like reverse-engineering an application — the design team created the UI, UX, and all flows forward. We need to discover all of that in reverse, from pure observation.

### Layer 1: UI Inventory (what exists)

Every button, input, dropdown, toggle, label — **per page, not flat.**

```json
{
  "page": "notion.id::Settings::General",
  "elements": [
    { "label": "Theme", "type": "dropdown", "state": "enabled", "value": "Dark",
      "relativeX": 0.45, "relativeY": 0.25, "ocrBackup": "Theme" },
    { "label": "Language", "type": "dropdown", "state": "enabled", "value": "English",
      "relativeX": 0.45, "relativeY": 0.35, "ocrBackup": "Language" }
  ]
}
```

**Status**: BUILT (Phase 2a) — elements auto-routed to `page::` zones by window title. 77 elements across 6 zones in live Notion map.

### Layer 2: Information Architecture (how it's organized)

Page hierarchy — what contains what, parent/child relationships.

```
Notion Workspace
├── Sidebar
│   ├── Search
│   ├── Favorites (collapsible)
│   │   ├── My Engineering Tasks
│   │   └── ScreenHand Automation Notes
│   ├── Private (collapsible)
│   │   ├── Rating System Test Page
│   │   └── ScreenHand Test Page
│   └── Settings (gear icon → opens overlay)
├── Top Bar
│   ├── Breadcrumb (Page > Sub-page)
│   ├── Share button
│   └── More (...)
└── Content Area
    ├── Page Title (editable)
    ├── Page Body (blocks)
    └── Database Views (table/board/calendar)
```

**Status**: BUILT (Phase 2c) — parent/child extracted from AX tree indentation and OCR spatial grouping (short section names followed by content). 5 entries in live Notion map.

### Layer 3: Navigation Model (how you move between screens)

Every click that causes a page/view transition — the wireframe/UX flow.

```
                    ┌─────────────┐
                    │  Workspace  │
                    └──────┬──────┘
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │ Tasks Board │ │ Notes Page  │ │  Settings   │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │ Task Detail │ │  New Block  │ │  General    │
    └─────────────┘ └─────────────┘ │  Account    │
                                    │  Notifs     │
                                    └─────────────┘
```

Each edge records: action (click/shortcut), success count, average transition time, back-path.

**Status**: BUILT (Phase 2b) — nav graph auto-built from page transitions. 6 nodes, 11 edges (2 verified) in live Notion map. BFS pathfinding working.

### Layer 4: State Machine (what changes what)

App UI isn't static — actions change what's visible.

```
States:
  sidebar_expanded ←→ sidebar_collapsed     (toggle via hamburger icon)
  light_mode ←→ dark_mode                   (toggle via Settings > Theme)
  database_table ←→ database_board          (toggle via view selector)
  modal_open ←→ modal_closed               (open via button, close via Escape)
  page_loading → page_ready                 (wait for spinner to disappear)

Transitions:
  click("☰") → sidebar_collapsed → layout shifts, content area expands
  click("Board") → database_board → columns appear, rows disappear
  press("Escape") → modal_closed → overlay disappears, focus returns to content
```

**Status**: BUILT (Phase 2e) — structural detection (Cmd+K=modal open, Escape=close, Cmd+\=sidebar toggle) + keyword-based state detection from result text. 1 dimension (modal_state) in live Notion map.

### Layer 5: Input/Output Contracts (what each element does)

Not just "I clicked it and it worked" but "what happened after I clicked it."

```json
{
  "element": "New page",
  "action": "click",
  "precondition": "sidebar visible",
  "outcome": {
    "pageCreated": true,
    "cursorPosition": "page title",
    "sidebarUpdated": true,
    "newEntry": "Untitled (at bottom of sidebar)"
  },
  "undoPath": "Ctrl+Z or delete page"
}
```

```json
{
  "element": "Search",
  "action": "click + type",
  "precondition": "any page",
  "outcome": {
    "overlayAppears": true,
    "resultsAfterMs": 300,
    "showsRecentFirst": true,
    "enterOpensTopResult": true
  },
  "undoPath": "Escape closes search"
}
```

**Status**: BUILT (Phase 2d) — records outcomes for every interaction (element→action→result). Uses `"auto"` zone search to find elements regardless of page context. 7 contracts in live Notion map.

### Layer 6: Conditional UI (what appears when)

UI changes based on context, permissions, and state.

```
Conditions:
  admin_user → sees "Settings", "Members", "Billing"
  member_user → sees "Settings" only
  empty_database → shows "New database" creation prompt
  locked_page → hides "Edit" button, shows "Locked" badge
  has_comments → shows comment count badge
  first_visit → shows onboarding tooltip
```

**Status**: BUILT (Phase 2f) — tracks element visibility across 7 inspection tools (ui_tree, ocr, ui_find, screenshot, click_text, windows, browser_dom), throttled to every 3rd call. 71 visibility conditions in live Notion map.

### Layer 7: Timing & Animation (how fast things respond)

When is the UI "ready" vs still loading?

```
Timings:
  page_load: 800ms average (spinner visible → content rendered)
  search_results: 300ms after keystroke
  sidebar_toggle: 150ms animation
  modal_open: 200ms fade-in
  database_view_switch: 500ms (data refetch)

Ready signals:
  spinner_gone + content_visible = page_ready
  cursor_blinking = input_focused
  no_skeleton_loaders = data_loaded
```

**Status**: BUILT (Phase 2g) — per-element response timing (running averages with sample counts) + ready signal detection from slow responses (>1.5s), wait tools, and post-navigation screenshots. 7 timing profiles + 1 ready signal in live Notion map.

---

## Phase 2 Implementation Status

All 7 phases are BUILT and recording data from live app interactions.

| Phase | Layer | What | Status |
|-------|-------|------|--------|
| 2a | L1 — Multi-zone UI Inventory | Per-page zones, element routing by window title | BUILT |
| 2b | L3 — Navigation Model | Page transitions, nav graph, BFS pathfinding | BUILT |
| 2c | L2 — Information Architecture | Parent/child hierarchy from AX tree + OCR | BUILT |
| 2d | L5 — Input/Output Contracts | Outcomes, reliability scoring, zone-auto search | BUILT |
| 2e | L4 — State Machine | Structural detection (Cmd+K, Escape) + keyword states | BUILT |
| 2f | L6 — Conditional UI | Visibility tracking across 7 inspection tools | BUILT |
| 2g | L7 — Timing/Animation | Per-element timing + ready signal detection | BUILT |

All features record passively from normal tool usage — no special commands needed.

### Automated Exploration Mode

Instead of building maps only from organic tool calls, add a dedicated exploration mode:

```
"Explore Notion" command:
  1. Click every sidebar item → record each page's elements via OCR + AX tree
  2. For each page: identify zones (toolbar, content, panels)
  3. Record page transitions (sidebar click → page change)
  4. Test back/forward navigation
  5. Open settings, scan all tabs
  6. Try keyboard shortcuts from menu bar

  20 pages × 30 seconds each = ~10 minutes to map the entire app
  Run once, map persists forever, validates on next visit
```

### Multi-Page Zone Architecture

Current (broken):
```
notion.id
└── auto_discovered (1 zone, 66 elements from ALL pages mixed together)
```

Target:
```
notion.id
├── global::sidebar (persistent across pages)
│   ├── Search, Favorites, Private, Settings gear
│   └── Appears on: ALL pages
├── global::topbar (persistent across pages)
│   ├── Breadcrumb, Share, More
│   └── Appears on: ALL pages
├── page::My Engineering Tasks
│   ├── Database view selector, filters, sort
│   ├── Task rows, status columns
│   └── "New task" button
├── page::ScreenHand Automation Notes
│   ├── Page title, page body
│   └── Block toolbar, comment section
├── page::Settings
│   ├── Tab list: General, Notifications, Connections, Security
│   └── Per-tab content elements
└── modal::Search Overlay
    ├── Search input, results list, recent items
    └── Trigger: Ctrl+P or click Search
```

Each zone knows:
- Which page/context it belongs to
- Which elements are in it (with per-page positions)
- How to get there (navigation edge from parent)
- Whether it's global (sidebar/topbar) or page-specific

---

## Impact Analysis

### Storage

| Apps mapped | Map size (Phase 1) | Map size (Phase 2 full) | RAM |
|-------------|--------------------|-----------------------|-----|
| 1 app | 30-50 KB | 100-200 KB | ~1 MB |
| 20 apps | 600 KB - 1 MB | 2-5 MB | ~10 MB |
| 100 apps | 3-5 MB | 10-30 MB | ~50 MB |

### Speed

| Operation | Phase 1 (current) | Phase 2 (full) |
|-----------|-------------------|----------------|
| Tool call overhead (map lookup) | ~1ms | ~3-5ms |
| Map load on app switch | ~2ms | ~10-20ms |
| BFS pathfinding (50 nodes) | <1ms | ~2-5ms |
| State machine check | N/A | ~5-10ms per action |
| Exploration scan (one-time) | N/A | ~10-30 min per app |

### Accuracy Risks

| Layer | Risk | Mitigation |
|-------|------|------------|
| Relative positions | Break on resize, sidebar collapse, zoom | OCR backup self-healing |
| Navigation edges | Break on app updates that move buttons | Version-change detection, confidence decay |
| State machine | False transitions from timing issues | Before/after diffing with settling delay |
| Input contracts | Outcomes vary by app state | Track preconditions, multiple observation averaging |

### Cost

| Item | Cost |
|------|------|
| Compute | Zero — all on-device, JSON files, in-memory lookups |
| Cloud / API | None |
| Exploration time | 10-30 min per app (one-time) |
| Re-validation | ~2 min per app on version change |
| Disk | <30 MB for 100 apps |

---

## Mastery Levels

| Level | Confidence | What ScreenHand Knows | Speed | Precision |
|---|---|---|---|---|
| **Beginner** | 0.0 – 0.39 | Basic zones identified, few elements mapped, navigation graph sparse | Slow — screenshots + OCR every action | Low — ~40-50% first-try success |
| **Pro** | 0.40 – 0.69 | All major zones mapped, key elements located, common navigation paths verified | Moderate — uses map for known areas, OCR for unknown | Medium — ~65-75% first-try success |
| **Expert** | 0.70 – 0.89 | Complete zone map, most elements mapped with relative positions, shortcuts known, recovery paths learned | Fast — goes directly to targets, minimal verification | High — ~80-90% first-try success |
| **Grandmaster** | 0.90 – 1.0 | Full map, all paths verified 5+ times, edge cases documented, app version tracked, window-size independent | Maximum — acts without looking, verifies only on failure | Very high — ~90-95% first-try success |

### Confidence Computation

Confidence is computed from:
- `zonesDiscovered / totalExpectedZones` (from reference or exploration)
- `verifiedEdges / totalEdges` in navigation graph
- `elementsWithRelativePosition / totalElements`
- `averageSuccessRate` of recent interactions
- Decays if app version changes or stale > 7 days

### Level Transitions

```
BEGINNER → PRO:
  All major zones identified + 50% navigation edges verified + 3+ successful task completions

PRO → EXPERT:
  All zones mapped with elements + 80% edges verified + shortcuts known + 10+ successful tasks

EXPERT → GRANDMASTER:
  All edges verified 5+ times + edge cases documented + window-resize tested + 50+ successful tasks

GRANDMASTER → EXPERT (demotion):
  App version changed OR 3+ consecutive failures OR stale > 14 days

EXPERT → PRO (demotion):
  App major UI redesign detected (zone positions shifted >30%) OR stale > 30 days
```

---

## Two Modes

| Mode | When | Behavior |
|---|---|---|
| **Learn-First** | New app + complex task, or user requests `"learn this app first"` | Systematically explore: scan menus, click every toolbar, open every panel, build complete map. Slow upfront, but starts executing at Pro+ level |
| **Explore-Fast** | Known app + simple task, or user requests `"just do it"` | Only map what's needed for current task. Fast start, map grows organically per task |

### Auto-Selection Logic

```
No map exists + multi-step task           → Learn-First
No map exists + single action             → Explore-Fast
Map exists at Pro+                        → Explore-Fast
Map exists but stale (version mismatch)   → Explore-Fast with background re-validation
User override                             → Always wins
```

### Learn-First Pipeline

```
1. INGEST existing knowledge (if available)
   └── Load reference file (references/{app}.json) → bootstrap zones + selectors
   └── ingest_documentation → pull shortcuts, features from official docs
   └── scan_menu_bar → extract complete menu hierarchy

2. EXPLORE systematically
   └── Screenshot → OCR → identify major zones (toolbar, sidebar, canvas, status bar)
   └── Store zones as relative positions (% based)
   └── Click each interactive element → record what changed (page transition? modal? state change?)
   └── Build navigation graph: node(page) → edge(click sidebar item) → node(new page)
   └── Record undo path: how to get back from each state
   └── Classify elements: button, input, dropdown, toggle, link (from AX role or YOLO)

3. VALIDATE against live screen
   └── Re-screenshot → confirm zones match
   └── Click known elements → confirm navigation edges
   └── Mark verified elements, flag mismatches

4. REPORT mastery level
   └── Compute confidence from zones + edges + elements
   └── Assign level: beginner / pro / expert / grandmaster
   └── Store in app map JSON
```

---

## Relative Positioning (Window-Size Independent)

All element positions stored as percentages, not pixels:

```
relativeX: 0.35  = 35% from left edge
relativeY: 0.04  = 4% from top edge
```

Resolution on any window size:
```
pixelX = windowBounds.x + (relativeX × windowBounds.width)
pixelY = windowBounds.y + (relativeY × windowBounds.height)
```

Each element also has `ocrBackup` — the text label to find via OCR if relative position fails (e.g., after app UI redesign). This is the self-healing fallback:

```
1. Try relative position → click
2. If failed → OCR for ocrBackup text → click at OCR position
3. If OCR found it → update relative position in map (self-healed)
4. If OCR also failed → flag element as stale, demote confidence
```

---

## How It Connects to Existing Layers

```
Layer 7 (App Mastery Map) PROVIDES:
  ├── Zone map         → Layer 3 (Awareness): know where to look before scanning
  ├── Navigation graph → Layer 4 (Planner): plan paths through app, not just actions
  ├── Relative positions → Layer 1 (Control): click targets without OCR on every action
  ├── UI architecture  → Layer 5 (Learning): cold-start "this is custom-rendered, skip AX"
  ├── State machine    → Layer 6 (Recovery): know which state we're in, what to undo
  └── Mastery level    → All layers: honest confidence reporting

Layer 7 CONSUMES:
  ├── Layer 3 perception data → validate/update zones and elements
  ├── Layer 5 learning data   → which methods work feeds into map confidence
  ├── Layer 6 ingestion data  → docs/menus bootstrap the map before first interaction
  └── Layer 1 tool results    → every successful action strengthens the map
```

---

## What a Full Map Looks Like (Target)

```
App: Notion (notion.id)
Mastery: EXPERT (confidence: 0.82)

Pages discovered: 20
├── My Engineering Tasks (database board)
├── ScreenHand Automation Notes (document)
├── Rating System Test Page (document)
├── Settings > General (settings panel)
├── Settings > Notifications (settings panel)
├── Settings > Connections (settings panel)
├── ... 14 more pages

Global zones: 2 (sidebar, topbar)
Page-specific zones: 45
Total elements: 400+
Element types: button(120), link(85), input(45), dropdown(30), toggle(20), label(100+)

Navigation graph: 50+ edges
  sidebar::My Engineering Tasks → page::Tasks Board (click, 9 successes, avg 800ms)
  sidebar::Settings → modal::Settings Overlay (click, 3 successes, avg 400ms)
  modal::Settings > General tab → modal::Settings::General (click, 2 successes)
  page::Tasks Board > task row → page::Task Detail (click, 5 successes)

State machine: 8 states
  sidebar: expanded ←→ collapsed
  theme: light ←→ dark
  database_view: table ←→ board ←→ calendar ←→ timeline
  modal: open ←→ closed

Input contracts: 25 recorded
  "New page" → creates page, cursor in title, sidebar updates
  "Search" → overlay appears, 300ms result delay, Escape closes
  "New task" → row added to database, cursor in Name field
```

That's the difference between a random road and a complete HD map.

---

## Existing Files (Phase 1)

```
src/state/app-map-types.ts         — TypeScript interfaces for map JSON structure
src/state/app-map.ts               — AppMap class: load, save, update, query, prune, mastery computation
src/learning/topology-policy.ts    — 6th policy: navigation edge reliability tracking
tests/app-map.test.ts              — 18 tests: persistence, zones, elements, edges, mastery, decay, pruning
tests/topology-policy.test.ts      — 10 tests: policy isolation + LearningEngine integration
~/.screenhand/app-maps/            — Persistent map storage (one JSON per bundleId)
```

---

## Performance Targets

| Metric | Without Map | Phase 1 (Current) | Phase 2 (Full) |
|---|---|---|---|
| First action on known element | ~600ms (OCR scan) | ~200ms (position + verify) | ~50ms (direct position, no OCR) |
| 10-step workflow | ~15s + OCR every step | ~10s + OCR on unknowns | ~3s + zero OCR |
| "How to navigate to Settings?" | No idea | 1 edge maybe | BFS: sidebar → Settings gear → General tab |
| "What type is this element?" | Unknown | Unknown | dropdown / button / input / toggle |
| "What happens if I click this?" | Try and see | success/fail count | Full outcome contract |
| Recovery from moved element | Fail → full rescan | Fail → OCR fallback → self-heal | Rarely fails, self-heals in background |
| New app cold start | Fully blind | Bootstrapped from references | 10-min exploration → Pro level |
| Confidence reporting | "I don't know" | Inflated mastery level | Honest, multi-factor assessment |

---

---

## Phase 3: Visual App Mapping (Planned)

> **Status**: PLANNED — Agent team (Chief, Builder, Breaker, Ghost, Outsider) completed full review 2026-04-02.

> **The problem**: Phase 1+2 builds maps incrementally from tool usage. Elements have `relativeX: -1, relativeY: -1` until someone interacts with them. The map grows organically but is always incomplete — like a human who never looks at the app, just blindly pokes at it. A human glances at an app for 2 seconds and knows the layout. ScreenHand can't do that.

> **The solution**: Take 5-10 screenshots of each app's key screens, use LLM vision to label all regions, populate the existing AppMap with real coordinates BEFORE the first interaction. Like a human's first glance.

### Agent Team Assessment

| Agent | Verdict | Key Insight |
|-------|---------|-------------|
| **Chief** | Build it, 3 days | Store in AppMap, pipeline is capture->analyze->store->lookup->validate |
| **Builder** | ~830 lines total | Rich schema with screens + navigation edges, include AX tree in LLM prompt |
| **Breaker** | 22 failure modes | LLM labels are HYPOTHESES not ground truth. State explosion is real. Don't build a parallel system. |
| **Ghost** | 12 vulnerabilities | PII risks in screenshots sent to LLM. Map poisoning possible via community. |
| **Outsider** | Auto-map, never block | Two-phase: quick OCR scan (500ms, no API key) + background LLM enrichment. Name it `map_app`. |

### Key Design Decisions

1. **NOT a separate system** — enhance existing AppMap. Fill the `-1,-1` coordinates, don't create parallel files.
2. **LLM labels are hypotheses** — stored with `confidence: 0.5, source: "llm"`. Only promoted to 0.9 after 3 AX confirmations. AX always wins over LLM.
3. **Two-phase approach**:
   - **Phase A (500ms, inline, no API key):** Screenshot -> fast OCR -> spatial clustering -> populate element coordinates
   - **Phase B (5-15s, background, needs ANTHROPIC_API_KEY):** Screenshot + AX tree to LLM -> semantic zone labels, element purposes, navigation hints
4. **Auto-trigger on first interaction** — when `focus()`/`launch()` hits an app with empty coordinates, auto-trigger Phase A. `map_app` tool for explicit re-mapping.
5. **Always use logical points** — store `scaleFactor` in metadata, normalize all coordinates.
6. **Store app version** — compare `CFBundleShortVersionString` on load. Mismatch -> demote confidence to 0.3, trigger re-scan.
7. **Sensitive app blocklist** — never screenshot password managers, banking, health apps without consent.

### Architecture

```
map_app tool call (or auto-trigger on first focus)
  |
  +-- Phase A: Quick Scan (500ms, inline)
  |   +-- screenshot_file() -> PNG
  |   +-- fast OCR -> text + positions
  |   +-- spatial clustering -> group elements into zones
  |   +-- fill AppMap element coordinates (relativeX/relativeY)
  |   +-- return immediately with zone count + element count
  |
  +-- Phase B: LLM Enrichment (5-15s, background)
      +-- send screenshot + AX tree to Claude Vision API
      +-- structured prompt -> JSON response
      +-- parse -> semantic zone labels, element purposes
      +-- cross-validate LLM labels against AX labels
      +-- store with source: "llm", confidence: 0.5
      +-- update AppMap (merge, don't overwrite)

Live Validation (ongoing, in perception MEDIUM loop):
  +-- compare AX element positions against map positions
  +-- match -> increment validationCount, boost confidence
  +-- mismatch -> increment mismatchCount
  +-- if mismatchRate > 30% after 10 checks -> mark zone stale
```

### Schema Extensions

```ts
// ADD to MapElement (app-map-types.ts)
labelSource?: "ax" | "ocr" | "llm" | "manual";
visualConfidence?: number;       // 0-1, LLM-assigned
validationCount?: number;        // times AX confirmed position
mismatchCount?: number;          // times AX contradicted position

// ADD to AppMapData
visualMeta?: {
  lastScannedAt: string;          // ISO timestamp
  appVersion: string;             // CFBundleShortVersionString
  scaleFactor: number;            // display scale at capture time
  captureSize: { w: number; h: number };
  screenshotHash: string;         // for staleness detection
  screensMapped: string[];        // window titles mapped
  confidence: number;             // overall map confidence
};
```

### New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/state/visual-mapper.ts` | Core: quickScan(), llmEnrich(), validate() | ~300 |
| `tests/visual-mapper.test.ts` | Tests with mocked LLM responses | ~200 |

### Modified Files

| File | Change | Est. Lines |
|------|--------|-----------|
| `src/state/app-map-types.ts` | Add fields to MapElement + AppMapData | ~30 |
| `src/state/app-map.ts` | Add `populateFromVisualScan()`, `getVisualMeta()` | ~60 |
| `src/context-tracker.ts` | Auto-trigger quick scan, add visual hints to `getHints()` | ~40 |
| `mcp-desktop.ts` | `map_app` tool + `map_status` tool | ~80 |
| `src/perception/coordinator.ts` | Landmark validation in MEDIUM loop | ~30 |
| `src/util/sanitize.ts` | Deeper PII scrubbing | ~40 |

**Total: ~780 lines new/changed**

### Build Sequence

| Step | What | Time | Blocks on |
|------|------|------|-----------|
| **0** | Fix PII leak in dist-app-maps | 2 hrs | Nothing |
| **1** | Types + schema extensions | 1 hr | Step 0 |
| **2** | Quick scan (OCR-based, no LLM) | 3 hrs | Step 1 |
| **3** | `map_app` + `map_status` MCP tools | 2 hrs | Step 2 |
| **4** | Auto-trigger in context tracker | 1 hr | Step 3 |
| **5** | LLM enrichment (background) | 3 hrs | Step 4 |
| **6** | Live validation in perception | 2 hrs | Step 5 |
| **7** | Tests | 2 hrs | Step 6 |
| **8** | `npm run check` + `npm test` | 30 min | Step 7 |

### Risk Mitigations

| Risk | Mitigation |
|------|------------|
| LLM mislabeling cascades | Labels at `confidence: 0.5`, need 3 AX confirmations to promote |
| Screenshot timing (animations) | Wait for ReadySignal, take 2 screenshots 500ms apart |
| Scale factor breaks coords | Store `scaleFactor`, normalize to logical points |
| State explosion | Map what's visible NOW, add incrementally, state-aware via VisibilityCondition |
| Privacy/PII in screenshots | Sensitive app blocklist, PII scrub before LLM, never store screenshots |
| Map poisoning via community | Visual maps are LOCAL only, never shared |
| Perception conflicts with map | `labelSource` field — AX always wins over LLM |
| Stale maps after app updates | Store `appVersion`, auto-demote on version change |

### What We're NOT Building (Scope Control)

- No screenshot storage (only structured analysis)
- No multi-display handling in V1
- No video/animation analysis
- No custom ML models
- No community sharing of visual maps
- No manual map editing
- No web app visual mapping (CDP gives full DOM)

---

## License

AGPL-3.0-only — Copyright (C) 2025 Clazro Technology Private Limited
