# ScreenHand Architecture

## What ScreenHand Is

ScreenHand is an **MCP server that gives AI agents native desktop control** on macOS and Windows. It exposes 111 tools for controlling applications through accessibility APIs, Chrome DevTools Protocol, OCR/Vision, and keyboard/coordinate input.

**Current capability**: ScreenHand can reliably control apps with AX/CDP-exposed UI (browsers, native apps with standard controls, Electron apps). For canvas-heavy pro tools (Premiere Pro, Photoshop, Canva editor, DaVinci Resolve timeline), control is limited to menus, panels, keyboard shortcuts, and OCR+coordinates — the core workspace (timeline, canvas, viewport) is not semantically accessible.

**Target capability**: A tool mastery platform that systematically ingests expert knowledge about any application and executes workflows autonomously with continuous awareness, self-healing, and learning.

The core insight: **the tools already exist, the knowledge already exists, the experts already exist.** ScreenHand's job is to encode that knowledge and execute it reliably.

## Source of Truth

The canonical MCP server is **`mcp-desktop.ts`** (project root). 111 tools. Production entry point.

---

## Architecture Layers

ScreenHand is organized into 7 layers, from bottom (hardware) to top (mastery):

```
┌──────────────────────────────────────────────────────────────┐
│  LAYER 7: APP MASTERY MAP                                    │
│  "I have a complete reverse-engineered blueprint of this app"│
│                                                              │
│  Per-app spatial maps: zones, elements, nav graph,           │
│  hierarchy, I/O contracts, state machine, visibility,        │
│  timing profiles, ready signals, mastery levels              │
│  Status: BUILT (src/state/app-map.ts, 8 recording features) │
├──────────────────────────────────────────────────────────────┤
│  LAYER 6: TOOL MASTERY                                       │
│  "I know how to use Premiere Pro like an expert"             │
│                                                              │
│  Knowledge ingestion, expert workflow library,               │
│  community playbooks, documentation parsers,                 │
│  cross-tool skill transfer                                   │
│  Status: BUILT (src/ingestion/, src/community/)              │
├──────────────────────────────────────────────────────────────┤
│  LAYER 5: LEARNING                                           │
│  "I remember what worked and what didn't"                    │
│                                                              │
│  Locator stability, sensor effectiveness,                    │
│  recovery strategy ranking, adaptive timeouts,               │
│  per-app behavior profiles                                   │
│  Status: BUILT (src/learning/)                               │
├──────────────────────────────────────────────────────────────┤
│  LAYER 4: AUTONOMY                                           │
│  "I can plan, execute, recover, and continue"                │
│                                                              │
│  Goal planner, deterministic executor,                       │
│  recovery engine, self-healing, replanning                   │
│  Status: BUILT (src/planner/, src/recovery/)                 │
├──────────────────────────────────────────────────────────────┤
│  LAYER 3: AWARENESS                                          │
│  "I always know what's on screen"                            │
│                                                              │
│  World model, continuous perception,                         │
│  multi-source fusion, confidence scoring                     │
│  Status: BUILT (src/state/, src/perception/)                 │
├──────────────────────────────────────────────────────────────┤
│  LAYER 2: TOOL KNOWLEDGE                                     │
│  "I know this app's shortcuts, selectors, and workflows"     │
│                                                              │
│  references/*.json, playbooks/*.json,                        │
│  context tracker, memory service, intelligence wrapper       │
│  Status: BUILT (38 references, 28 playbooks)                 │
├──────────────────────────────────────────────────────────────┤
│  LAYER 1: CONTROL                                            │
│  "I can click, type, read, and navigate"                     │
│                                                              │
│  AX adapter (~50ms), CDP adapter (~10ms),                    │
│  OCR/Vision (~600ms), keyboard, coordinates,                 │
│  native bridge (Swift/C#), fallback chains                   │
│  Status: BUILT (111 MCP tools, all working)                  │
└──────────────────────────────────────────────────────────────┘
```

**Where we are today:** All 7 layers are built and tested (1306 tests, 53 files). 80-scenario real-app adversarial validation complete (77 pass, 2 skip, 1 resolved). 103 bugs found and fixed. S75 PII redaction (Option C) implemented. Layer 7 App Mastery Map adds persistent spatial understanding with 8 auto-recording features. Ship-ready as public beta.

---

## Layer 1: Control (BUILT)

The foundation. ScreenHand interacts with applications through multiple control channels. Coverage depth depends on app type.

### App Tiers — What Works Today

| Tier | App type | Examples | Primary method | What's accessible | What's not | Current reliability |
|---|---|---|---|---|---|---|
| **Tier 1: Browser** | Web apps in Chrome/Electron | Gmail, Canva sidebar, Figma sidebar, web apps | CDP + AX | Full DOM, all elements, forms, navigation | `<canvas>` internals | ~90% for standard UI |
| **Tier 2: AX-native** | Native apps with standard controls | TextEdit, Finder, System Settings, Mail, Notes | AX | Buttons, fields, menus, dialogs, text areas | Custom-drawn views | ~85% for standard UI |
| **Tier 3: Hybrid** | Pro apps with mix of standard + custom UI | Premiere Pro, DaVinci Resolve, Photoshop, After Effects | AX (panels/menus) + keyboard + OCR (workspace) | Menus, panels, tool palettes, dialogs, shortcuts | Timeline, canvas, viewport, preview | ~70% for panel UI, ~40% for workspace |
| **Tier 4: Canvas-only** | Apps where core UI is a single canvas | Games, some creative tools | OCR + coordinates + keyboard | Whatever is visually readable | Everything semantic | ~30% best effort |

Tier 3 is where most professional creative tools sit. The autonomy stack (Layers 3-5) and tool mastery (Layer 6) are primarily aimed at improving Tier 3 coverage from ~40% workspace control to ~75%+ through better perception, learned coordinates, and keyboard-first workflows.

### Execution Contract

| Priority | Method | Avg Latency | Can Click | Can Type | Can Read | Best For |
|----------|--------|-------------|-----------|----------|----------|----------|
| 1 | AX/UIA | ~50ms | Yes | Yes | Yes | Native app buttons, fields, menus |
| 2 | CDP | ~10ms | Yes | Yes | Yes | Browser/Electron DOM elements |
| 3 | OCR | ~600ms | No | No | Yes | Canvas content, visual-only UI |
| 4 | Coordinates | ~50ms | Yes | No | No | Known positions, OCR-located targets |

Retry: 2 per method, 5 total, 500ms delay. Fallback tools (`*_with_fallback`) try each method in order.

### Action Budget

| Phase | Default | Purpose |
|---|---|---|
| Locate | 800ms | Find the target element |
| Act | 200ms | Perform the action |
| Verify | 2000ms | Confirm effect |
| Retries | 1 | Retry once on failure |

### Adapter System

```
CompositeAdapter (routes per app)
  ├── AccessibilityAdapter  — macOS AX API via Swift bridge (default)
  ├── CdpChromeAdapter      — Chrome DevTools Protocol (Chromium/Electron)
  ├── AppleScriptAdapter    — Scriptable macOS apps (Finder, Mail, etc.)
  └── VisionAdapter         — OCR-based fallback via native bridge
```

### Native Bridge

JSON-RPC over stdio to platform-native binaries:
- **macOS**: Swift binary — accessibility, CoreGraphics capture, Vision OCR
- **Windows**: C# .NET 8 binary — UI Automation, screen capture, Windows OCR
- Timeouts: 10s default, 30s app launch, 20s OCR, 15s capture

### Tool Groups (88 total)

| Group | Count | Examples |
|---|---|---|
| Desktop | 19 | `apps`, `windows`, `focus`, `launch`, `screenshot`, `ocr`, `ui_tree`, `ui_press`, `click`, `type_text`, `key` |
| Browser | 12 | `browser_navigate`, `browser_click`, `browser_type`, `browser_dom`, `browser_js`, `browser_fill_form` |
| Fallback | 8 | `click_with_fallback`, `type_with_fallback`, `read_with_fallback`, `execution_plan` |
| Platform Knowledge | 6 | `platform_guide`, `playbook_preflight`, `platform_learn`, `platform_explore` |
| Observer/Orchestrator | 7 | `observer_start/stop/status`, `orchestrator_start/stop/submit/status` |
| Memory | 9 | `memory_save`, `memory_recall`, `memory_snapshot`, `memory_errors`, `memory_query_patterns` |
| Supervisor | 12 | `session_claim/heartbeat/release`, `supervisor_start/stop/status`, `recovery_queue_*` |
| Jobs | 15 | `job_create/run/status/list`, `worker_start/stop/status` |

---

## Layer 2: Tool Knowledge (BUILT)

This is ScreenHand's competitive advantage. Curated, machine-readable knowledge about how to operate specific tools.

### Reference Files (references/*.json)

38 reference files covering:

| Category | Apps | Examples |
|---|---|---|
| Design | Canva, Figma | Selectors, shortcuts, UI patterns, API mappings |
| Video | DaVinci Resolve | 4 menu map files, keyboard shortcuts, edit/color/render flows |
| Social | Twitter/X, LinkedIn, Instagram, Threads, Reddit, Discord | Post flows, selectors, navigation |
| Browser | YouTube, DevTo, DevPost | Search, upload, navigation flows |
| Developer | Codex Desktop, N8N, VS Code | CDP ports, panel selectors |
| Ads/Research | Google Ads, Meta Ad Library | Search flows, competitor research |

### Reference File Structure

```json
{
  "id": "canva",
  "platform": "canva",
  "bundleId": "com.canva.CanvaDesktop",
  "cdpPort": 9333,
  "urls": { ... },
  "shortcuts": {
    "general": { "Create new design": "Cmd+N", ... },
    "text": { "Bold": "Cmd+B", ... },
    "elements": { "Add rectangle": "R", ... }
  },
  "selectors": {
    "toolbar": { "search": "[aria-label='Search']", ... },
    "auto_discovered": { ... }
  },
  "flows": {
    "create_design": { "steps": [...] },
    "export_png": { "steps": [...] }
  },
  "errors": [
    { "error": "Element not interactable", "solution": "Wait for loading overlay", "severity": "high" }
  ]
}
```

### Playbooks (playbooks/*.json)

28 executable playbooks — recorded step-by-step workflows:

| App | Playbooks | What they do |
|---|---|---|
| DaVinci Resolve | 3 | Color grade, edit timeline, render |
| Google Flow | 7 | Create project, edit image/video, generate image/video, search assets |
| Social platforms | 6 | Post to X, LinkedIn, Reddit, Instagram, Discord, Threads |
| Research | 3 | Competitor research via Google Ads, Google Search, Meta Ad Library |
| Canva | 1 | Create carousel |
| N8N | 1 | Workflow automation |
| YouTube | 1 | Upload flow |

### Context Tracker (src/context-tracker.ts)

Automatically connects tool execution to knowledge:
1. **DETECT**: When `browser_navigate("canva.com")` or `focus("com.canva.CanvaDesktop")` is called, loads matching reference
2. **HINT**: Before each tool call, suggests known selectors and warns about known errors
3. **LEARN**: Records which selectors work, auto-promotes to reference after 2+ successes
4. **FLUSH**: Merges learnings back into reference files

### Intelligence Wrapper (mcp-desktop.ts:173-345)

Every tool call (52 of 88) goes through this pipeline:

```
PRE-CALL:
  1. quickErrorCheck(tool)      → warn if this tool failed before + show fix
  2. contextTracker.update()    → load reference on domain/bundleId change
  3. contextTracker.getHints()  → suggest selectors, warn known errors, offer playbook

POST-CALL (success):
  4. memory.recordEvent()       → log to actions.jsonl
  5. contextTracker.record()    → learn which selectors work
  6. mcpRecorder.capture()      → record into playbook if recording
  7. quickStrategyHint()        → suggest next step from known sequences

POST-CALL (failure):
  8. memory.appendError()       → record error pattern
  9. backgroundResearch()       → async search for fix
```

### What's Missing in Layer 2

| Gap | Impact | Solution |
|---|---|---|
| No documentation parser | Can't auto-ingest from official docs | Build doc-to-reference converter |
| No YouTube tutorial extractor | Can't learn from video workflows | Extract steps from transcripts |
| No community playbook sharing | Each user starts from scratch | Shared playbook repository |
| No version tracking | References may not match app version | Add version field + detection |
| No coverage map | Don't know which app areas are covered | Audit tool for reference completeness |
| Few playbooks for pro tools | Only 3 DaVinci, 0 Premiere Pro, 0 Photoshop | Systematic recording campaigns |

---

## Layer 3: Awareness (BUILT)

### Components

| Component | File | Status |
|---|---|---|
| `WorldModel` | `src/state/world-model.ts` | Built — per-session state: app, windows, controls, dialogs, focus, scroll |
| `EntityTracker` | `src/state/entity-tracker.ts` | Built — persistent cross-frame identity (label + window + 50px proximity) |
| `FusionPipeline` | `src/state/fusion.ts` | Built — dedup by source+windowId, timestamp-ordered flush, learning-adaptive confidence |
| `PerceptionCoordinator` | `src/perception/coordinator.ts` | Built — 3-rate multi-source loops (FAST/MEDIUM/SLOW) |
| `AXSource` | `src/perception/ax-source.ts` | Built — AX event observation + tree polling |
| `CDPSource` | `src/perception/cdp-source.ts` | Built — CDP mutation observer + DOM snapshots |
| `VisionSource` | `src/perception/vision-source.ts` | Built — screenshot diff + ROI OCR |
| `FrameDiffer` | `src/perception/frame-differ.ts` | Built — fast hash-based change detection |
| `StateObserver` | `src/runtime/state-observer.ts` | Built — wraps AX events, buffers up to 200 |
| `Observer Daemon` | `scripts/observer-daemon.ts` | Built — background capture + OCR, 2s interval |

### Perception Data Flow (3-rate multi-source)

```
FAST (100ms):
  AXSource.drainEvents() --> WorldModel.ingestUIEvents()
  CDPSource.drainMutations() --> WorldModel.ingestCDPMutations()

MEDIUM (300ms):
  AXSource.pollAXTree() --> FusionPipeline.enqueue(ax) --> WorldModel.ingestAXTree()
  CDPSource.pollSnapshot() --> FusionPipeline.enqueue(cdp) --> WorldModel.ingestCDPSnapshot()
  BrowserEnricher (Safari AppleScript) --> WorldModel (best-effort)

SLOW (1000ms):
  VisionSource.captureAndDiffOptimized() --> FrameDiffer.quickChangedFile()
    If changed: VisionSource.ocrFile() --> FusionPipeline.enqueue(ocr) --> WorldModel.ingestOCRRegions()
    If unchanged: skip OCR (save ~250ms)
```

Default intervals from `DEFAULT_PERCEPTION_CONFIG` in `src/perception/types.ts` (lines 107-116): `fastIntervalMs: 100`, `mediumIntervalMs: 300`, `slowIntervalMs: 1000`.

---

## Layer 4: Autonomy (BUILT)

### Components

| Component | File | Status |
|---|---|---|
| `Planner` | `src/planner/planner.ts` | Built — goal to subgoals to action plan with postconditions |
| `PlanExecutor` | `src/planner/executor.ts` | Built — run plan steps, verify postconditions, trigger replan |
| `DeterministicPlanner` | `src/planner/deterministic.ts` | Built — playbook sequences at full speed without LLM |
| `ToolRegistry` | `src/planner/tool-registry.ts` | Built — maps plan steps to MCP tool calls |
| `GoalStore` | `src/planner/index.ts` | Built — persistent goal tracking |
| `RecoveryEngine` | `src/recovery/engine.ts` | Built — detect blockers, select strategy, execute recovery |
| `Detectors` | `src/recovery/detectors.ts` | Built — dialog, focus loss, crash detection |
| `Strategies` | `src/recovery/strategies.ts` | Built — dismiss dialog, refocus, restart app |
| Agent loop | `src/agent/loop.ts` | Built — observe, decide, act per step |
| Playbook engine | `src/playbook/engine.ts` | Built — deterministic step execution |
| Supervisor | `src/supervisor/supervisor.ts` | Built — stall detection, recovery queue |

---

## Layer 5: Learning (BUILT)

### Components

| Component | File | Status |
|---|---|---|
| `LearningEngine` | `src/learning/engine.ts` | Built — central engine coordinating all policies |
| `LocatorPolicy` | `src/learning/engine.ts` | Built — tracks which selectors are stable per app and action |
| `SensorPolicy` | `src/learning/engine.ts` | Built — tracks which perception source works best per app (rankSensors) |
| `RecoveryPolicy` | `src/learning/engine.ts` | Built — tracks which recovery strategy works per blocker and app |
| `PatternPolicy` | `src/learning/engine.ts` | Built — recognizes pre-failure state patterns |
| `TimingModel` | `src/learning/engine.ts` | Built — adaptive timing from actual durations per tool and app |
| Memory service | `src/memory/service.ts` | Built — JSONL persistence, error/strategy recall |
| Recall engine | `src/memory/recall.ts` | Built — strategy hints, error warnings |
| Context tracker | `src/context-tracker.ts` | Built — auto-promotes selectors after 2+ successes |

---

## Layer 6: Tool Mastery (BUILT)

This is the highest-value layer. It's about systematically acquiring and scaling tool expertise.

### Components

| Component | File | Status |
|---|---|---|
| `MenuScanner` | `src/ingestion/menu-scanner.ts` | Built — AX tree scan of entire menu bar |
| `DocParser` | `src/ingestion/doc-parser.ts` | Built — extracts features, shortcuts, UI terms from docs |
| `TutorialExtractor` | `src/ingestion/tutorial-extractor.ts` | Built — extracts steps from video transcripts |
| `ReferenceMerger` | `src/ingestion/reference-merger.ts` | Built — merges extracted data into reference JSON |
| `CoverageAuditor` | `src/ingestion/coverage-auditor.ts` | Built — audits reference completeness |
| `Publisher` | `src/community/publisher.ts` | Built — share playbooks to community |
| `Fetcher` | `src/community/fetcher.ts` | Built — pull community playbooks |
| `Validator` | `src/community/validator.ts` | Built — validate shared playbooks |

### Knowledge Sources

| Source | Volume | Quality | Extractable? |
|---|---|---|---|
| Official documentation | Thousands of pages per tool | High — authoritative | Yes — structured HTML/PDF |
| Keyboard shortcut lists | 50-500 per tool | High — complete | Yes — tables, easy to parse |
| YouTube tutorials | Millions of videos | Medium — varies | Yes — transcripts + timestamps |
| Community forums | Millions of posts | Medium — noisy | Partially — filter by upvotes/accepted |
| Plugin/extension APIs | Per tool | High | Yes — API docs |
| Existing automation scripts | Per tool | High — battle-tested | Yes — convert to playbooks |
| Expert screen recordings | Per workflow | Very high | Yes — with OCR + event logging |
| Menu bar structure | Complete per app | High — authoritative | Yes — AX tree of menu bar |
| Help center articles | Per tool | High | Yes — structured content |

### What Systematic Ingestion Looks Like

```
DOCUMENTATION PIPELINE:
  Official docs (HTML/PDF)
    → Parser extracts: features, shortcuts, menu paths, UI terms
    → Mapper converts to: reference JSON (selectors, shortcuts, flows)
    → Validator tests: do these selectors/shortcuts actually work?
    → Merge into: references/{tool}.json

TUTORIAL PIPELINE:
  YouTube tutorial (transcript + timestamps)
    → Extractor identifies: action steps, UI targets, expected results
    → Converter maps to: playbook steps with verification
    → Validator tests: does this playbook execute successfully?
    → Save to: playbooks/{tool}-{workflow}.json

MENU DISCOVERY PIPELINE:
  Launch app
    → AX tree scan of entire menu bar
    → Extract: all menu paths, keyboard shortcuts, enabled states
    → Map to: reference JSON shortcuts + flows
    → Already partially done for DaVinci Resolve (4 menu map files)

EXPERT RECORDING PIPELINE:
  Expert performs workflow with ScreenHand recording
    → McpPlaybookRecorder captures: every tool call, params, results
    → Post-processing: add verification steps, remove pauses, add variables
    → Save to: playbooks/{tool}-{workflow}.json
    → This already works — playbook_record tool exists

COMMUNITY PIPELINE:
  Users share playbooks
    → Central repository of validated playbooks
    → Version-tagged per app version
    → Ranked by success rate and usage count
    → Pull into: local playbooks/ on demand
```

### Coverage Target

| Tool | Current References | Current Playbooks | Target References | Target Playbooks |
|---|---|---|---|---|
| Canva | 7 files (very rich) | 1 | 7 (good) | 20+ (design types, exports) |
| DaVinci Resolve | 7 files (menus, shortcuts) | 3 | 7 (good) | 30+ (edit, color, fairlight, deliver) |
| Premiere Pro | 0 | 0 | 3+ (shortcuts, menus, panels) | 20+ (edit, effects, export, proxies) |
| After Effects | 0 | 0 | 3+ | 15+ |
| Photoshop | 0 | 0 | 3+ | 20+ |
| Figma | 1 | 0 | 3+ | 15+ |
| Final Cut Pro | 0 | 0 | 3+ | 15+ |
| Logic Pro | 0 | 0 | 2+ | 10+ |
| Blender | 0 | 0 | 3+ | 20+ |
| VS Code | 0 (codex-desktop only) | 1 | 2+ | 10+ |
| Excel/Sheets | 0 | 0 | 2+ | 15+ |
| Slack | 0 | 0 | 1+ | 5+ |
| Chrome | 0 (browser tools exist) | 0 | 1+ | 10+ |
| Social (X, LinkedIn, etc.) | 8 files | 6 playbooks | 8 (good) | 15+ |

### How Layer 6 Feeds Everything Below

```
Layer 6 (Tool Mastery) produces:
  ├── references/*.json     → Layer 2 (Tool Knowledge)
  │     Selectors, shortcuts, flows, errors per app
  │
  ├── playbooks/*.json      → Layer 4 (Autonomy) via Planner
  │     Deterministic execution plans for known workflows
  │
  ├── app profiles          → Layer 5 (Learning) cold start
  │     "Premiere Pro is canvas-heavy, prefer OCR+shortcuts over AX for timeline"
  │
  └── coverage maps         → Layer 3 (Awareness)
        "This app's toolbar is AX-accessible but canvas needs OCR"
```

---

## Layer 7: App Mastery Map (BUILT)

Persistent spatial understanding of every app ScreenHand interacts with. Builds a complete reverse-engineered blueprint from observation — zones, elements, navigation graph, hierarchy, I/O contracts, state machine, visibility conditions, and timing profiles.

### Components

| Component | File | Status |
|---|---|---|
| `AppMap` | `src/state/app-map.ts` | Built — ~2200 lines, load/save/CRUD/BFS/mastery/pruning |
| `AppMapData` types | `src/state/app-map-types.ts` | Built — all interfaces for zones, elements, nav, hierarchy |
| `TopologyPolicy` | `src/learning/topology-policy.ts` | Built — 6th policy, Bayesian nav edge scoring |
| POST-CALL recording | `mcp-desktop.ts` | Built — 8 features auto-record from every tool call |

### What It Records (8 features, all automatic)

| Feature | What | Trigger |
|---|---|---|
| Page Zones | Routes elements to `page::` zones by window title | Any tool with locator targets |
| Nav Graph | Page transitions, BFS-navigable graph | Any tool that changes window title |
| Hierarchy | Parent/child containment from AX tree + OCR | `ui_tree`, `ui_find`, `screenshot`, `ocr` |
| I/O Contracts | Element→action→outcome with reliability scoring | `click`, `click_text`, `type_text`, `key`, `menu_click` |
| State Machine | UI state dimensions (modal, sidebar, etc.) | `key` (Cmd+K, Escape, Cmd+\) + keyword detection |
| Visibility | Which elements appear on which pages | 7 inspection tools, every 3rd call |
| Timing | Per-element response times (running averages) | All interaction tools |
| Ready Signals | When app is "ready" after an action | `browser_wait`, slow responses (>1.5s), post-nav screenshots |

### Mastery Levels

| Level | Confidence | What It Means |
|---|---|---|
| `beginner` | 0.0-0.25 | Few zones, sparse elements, no nav edges |
| `pro` | 0.25-0.50 | Some zones mapped, basic navigation known |
| `expert` | 0.50-0.75 | Most zones, hierarchy, contracts, state machine |
| `grandmaster` | 0.75-1.0 | Complete map, all edges verified, timing profiled |

Formula: `0.25×zonesScore + 0.25×edgesScore + 0.20×elementsScore + 0.30×successRate`

### Key Design Decisions

- **Full JSON per app** (not JSONL) — structured document, 5-50KB per app, stored at `~/.screenhand/app-maps/`
- **`lastKnownBundleId`** — module-level variable survives transient `focusedApp` loss from `app_deactivated` events
- **`"auto"` zone search** — contracts search all zones for matching elements, not just the current page zone
- **OCR hierarchy heuristic** — short section names (1-2 words <=20 chars) followed by content = parent/child grouping
- **Structural state detection** — keyboard combos (Cmd+K=modal, Escape=close) detected structurally, not from result text

### How Layer 7 Feeds Everything Below

```
Layer 7 (App Mastery Map) produces:
  ├── Mastery hints        → Intelligence wrapper PRE-CALL context
  │     "Notion mastery: PRO (0.35) — 6 zones, 11 edges, 7 contracts"
  │
  ├── Navigation paths     → Planner (Layer 4) BFS pathfinding
  │     "To get from Notes to Settings: click sidebar gear → 3 steps"
  │
  ├── Element positions    → Fallback tools coordinate targeting
  │     "Search button at (0.12, 0.05) — OCR backup: 'Search'"
  │
  ├── I/O contracts        → Recovery (Layer 4) expected outcomes
  │     "click_text('New page') should create page, move cursor to title"
  │
  └── Timing profiles      → Timing model (Layer 5) per-element calibration
        "click_text on Notion averages 520ms, wait 1.5s for ready signal"
```

---

## How It All Connects

### Tier 1/2 Example: Browser/Native App (High confidence)

```
USER: "Open Safari and navigate to example.com"

Layer 4 (Autonomy):  Planner: focus Safari → Cmd+L → type URL → Enter
Layer 3 (Awareness): World model: Safari active, address bar focused, URL loaded
Layer 2 (Knowledge): Reference: address bar = AXTextField role "Address and Search"
Layer 1 (Control):   AX focuses field, types URL, presses Enter

Total: ~2-3s, 0 LLM calls, ~90% reliability
```

### Tier 3 Example: Pro App (Mixed confidence)

```
USER: "Export this Premiere Pro timeline as H.264 1080p"

Layer 6 (Mastery):   Reference for Premiere Pro: Cmd+M = export, dialog selectors, format menu
Layer 5 (Learning):  Knows Cmd+M is faster than File menu (learned). Export dialog controls
                     are AX-accessible, but timeline is not.
Layer 4 (Autonomy):  Planner: focus app → Cmd+M → set format → set preset → export
                     NOTE: This works because the export dialog is standard AX UI,
                     even though the timeline itself is canvas-heavy.
Layer 3 (Awareness): World model tracks: export dialog open (AXSheet), format dropdown
                     visible, "Export" button enabled. Confidence high for dialog,
                     low for timeline state (canvas, not AX-readable).
Layer 2 (Knowledge): Reference: export dialog = AXSheet, format = "Format" popup button
Layer 1 (Control):   AX presses "Format" popup → selects "H.264" → presses "Export"

Total: ~4-6s for dialog-based workflow, 0 LLM calls, ~75% reliability
Limitation: cannot verify timeline content before export — that requires OCR/visual check
Recovery: "Save Project?" dialog → auto-dismissed → continues
```

Tier 3 apps work well for **dialog/panel/menu workflows** (export, settings, file management). They are weaker for **workspace operations** (timeline editing, canvas manipulation, clip selection) where the core UI is not semantically exposed.

---

## Current State Summary

```
ALL 7 LAYERS BUILT AND TESTED (1306 tests, 53 files, zero failures):

  ✓ Layer 1 — 111 tools, 4 control methods, fallback chains, native bridges
  ✓ Layer 2 — 38 references, 28 playbooks, intelligence wrapper, context tracker
  ✓ Layer 3 — WorldModel, PerceptionCoordinator (3-rate), FusionPipeline, EntityTracker
  ✓ Layer 4 — Planner, PlanExecutor, DeterministicPlanner, RecoveryEngine, Detectors, Strategies
  ✓ Layer 5 — LearningEngine, 6 policies (Locator, Sensor, Recovery, Pattern, Timing, Topology)
  ✓ Layer 6 — MenuScanner, DocParser, TutorialExtractor, ReferenceMerger, CoverageAuditor, Community
  ✓ Layer 7 — AppMap, 8 auto-recording features, mastery levels, BFS pathfinding

103 BUGS FOUND AND FIXED:
  ✓ 80-scenario adversarial validation (77 pass, 2 skip, 1 resolved)
  ✓ S70 30-min soak test passed — perception alive, disk bounded, bridge responsive
  ✓ S75 PII redaction (Option C) — redact on persist, not on live reads
  ✓ lastKnownBundleId fix — all tools now record to correct app map
  ~ S08 (restart mid-session) — operator playbook ready, not yet executed
  ~ S69 (3 parallel clients) — operator playbook ready, not yet executed
```

---

## Performance Targets (by App Tier)

**Tier 1 (Browser) / Tier 2 (AX-native):**

| Metric | Current | Target (after Layers 3-5) |
|---|---|---|
| AX/CDP action | ~10-50ms | ~10-50ms (same) |
| Know screen state | 10-50ms per call | Near-zero (world model current) |
| 10-step known workflow | ~5s + 10 LLM calls | ~2-3s + 0 LLM calls |
| 10-step novel workflow | ~30s + 10 LLM calls | ~12s + 2-3 LLM calls |
| Dialog recovery | Manual (minutes) | ~1-2s auto |
| Success rate | ~80% | ~90-95% |

**Tier 3 (Hybrid pro apps — Premiere Pro, DaVinci, Photoshop):**

| Metric | Current | Target (after Layers 3-6) |
|---|---|---|
| Panel/dialog actions | ~50ms (AX) | ~50ms (same) |
| Canvas/workspace read | ~600ms (full OCR) | ~100-200ms (ROI OCR) |
| 10-step dialog workflow | ~8s + 10 LLM calls | ~4-6s + 0-1 LLM calls |
| 10-step workspace workflow | ~15s + many OCR | ~8-10s + ROI OCR |
| Dialog recovery | Manual | ~2-3s auto |
| Success rate (dialogs) | ~65% | ~80-85% |
| Success rate (workspace) | ~40% | ~60-70% |

**System-wide:**

| Metric | Current | Target |
|---|---|---|
| Memory footprint | ~30MB | ~80-100MB |
| Background CPU (with perception) | ~0% | ~3-5% |

These targets are per-tier, not platform-wide promises. Tier 3 workspace improvements depend heavily on per-app reference quality and ROI OCR accuracy.

---

## File Map

```
mcp-desktop.ts                       ← Main MCP server (111 tools, intelligence wrapper)
mcp-bridge.ts                        ← Bridge-only server (17 tools)
src/mcp-entry.ts                     ← Modular server (adapter selection)

src/runtime/
  service.ts                         ← AutomationRuntimeService
  session-manager.ts                 ← Resilient session re-attach
  executor.ts                        ← Locate → act → verify pipeline
  execution-contract.ts              ← Fallback chain + retry policy
  accessibility-adapter.ts           ← macOS AX API
  cdp-chrome-adapter.ts              ← Chrome DevTools Protocol
  composite-adapter.ts               ← Routes to AX or CDP per app
  applescript-adapter.ts             ← Scriptable macOS apps
  vision-adapter.ts                  ← OCR-based fallback
  state-observer.ts                  ← AX event buffering (Layer 3 groundwork)
  planning-loop.ts                   ← State snapshots (Layer 3 groundwork)
  locator-cache.ts                   ← Simple locator cache (Layer 5 groundwork)
  app-adapter.ts                     ← Adapter interface

src/memory/
  service.ts                         ← MemoryService (unified facade)
  store.ts                           ← JSONL persistence + caching
  recall.ts                          ← Strategy/error recall engine
  session.ts                         ← Session tracking + auto-save
  types.ts                           ← Memory data types

src/context-tracker.ts               ← Auto-loads references, learns selectors
src/supervisor/                      ← Lease management, stall detection
src/playbook/                        ← Playbook engine + recorder
src/jobs/                            ← Multi-step job system
src/observer/                        ← Observer state reading
src/agent/                           ← Autonomous agent loop
src/native/                          ← Bridge client (JSON-RPC)
src/logging/                         ← Timeline logger

native/macos-bridge/                 ← Swift accessibility bridge
native/windows-bridge/               ← C# .NET 8 bridge

references/                          ← 38 curated tool knowledge files
playbooks/                           ← 28 executable workflow files
profiles/                            ← Client instruction profiles
scripts/                             ← Daemons, watchers, ops scripts

src/state/                           ← World model, entity tracker, fusion (Layer 3), app-map (Layer 7)
  app-map.ts                         ← AppMap class — per-app spatial maps (~2200 lines)
  app-map-types.ts                   ← All Layer 7 interfaces
src/perception/                      ← Coordinator, AX/CDP/Vision sources, frame differ (Layer 3)
src/planner/                         ← Goal planner, executor, deterministic planner (Layer 4)
src/recovery/                        ← Recovery engine, detectors, strategies (Layer 4)
src/learning/                        ← Learning engine, 6 policies incl. TopologyPolicy (Layer 5)
src/ingestion/                       ← Doc parser, menu scanner, tutorial extractor (Layer 6)
src/community/                       ← Publisher, fetcher, validator (Layer 6)
```

---

## License

AGPL-3.0-only — Copyright (C) 2025 Clazro Technology Private Limited
