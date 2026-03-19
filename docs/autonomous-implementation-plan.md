# ScreenHand — Tool Mastery Platform Implementation Plan

> **Vision**: ScreenHand becomes the platform that lets AI master any desktop application — not by replacing tools, but by learning to operate them like an expert human would.

> **Core insight**: Premiere Pro, Canva, DaVinci Resolve, Photoshop, Figma — these tools have millions of users, thousands of tutorials, extensive docs, and decades of UI stability. ScreenHand's job is to encode that knowledge and execute it reliably, autonomously, and at scale.

> **Current state**: Layer 1 (Control: 88 tools, 4 methods) and Layer 2 (Knowledge: 38 references, 28 playbooks) are solid. Layers 3-6 are missing or partial.

> **Target state**: A 6-layer system where Layer 6 (Tool Mastery) systematically ingests expert knowledge, Layer 4 (Autonomy) executes it reliably, and Layer 5 (Learning) improves it over time.

---

## Architecture Layers (Implementation Order)

```
Layer 6: TOOL MASTERY     — "Know every tool like an expert"          Phase 6
Layer 5: LEARNING          — "Remember what works per app"             Phase 5
Layer 4: AUTONOMY          — "Plan, execute, recover, continue"        Phase 4 (Planner + Recovery)
Layer 3: AWARENESS         — "Always know what's on screen"            Phase 3 (World Model + Perception)
Layer 2: TOOL KNOWLEDGE    — "Know this app's shortcuts and selectors" BUILT
Layer 1: CONTROL           — "Click, type, read, navigate"             BUILT
```

**Implementation order**: Two parallel tracks

```
AUTONOMY TRACK:  3a → 3b → 4a → 4b → 5    (sequential, each builds on previous)
MASTERY TRACK:   6a → 6b → 6c              (parallel, no hard dependency on autonomy)
```

Phase 3 = World Model (3a) + Continuous Perception (3b)
Phase 4 = Planner (4a) + Recovery Engine (4b)
Phase 5 = Learning Engine
Phase 6 = Knowledge Ingestion (6a: menu scanner, 6b: doc parser, 6c: community) — runs in parallel with autonomy track, shares reference/playbook format

---

## Existing Groundwork

| Component | File | What it does | Reuse in |
|---|---|---|---|
| `StateObserver` | `src/runtime/state-observer.ts` | AX events → typed UIEvent buffer (200 max) | 3b — AX event source |
| `PlanningLoop` | `src/runtime/planning-loop.ts` | StateSnapshot (events + app context) | 3a — world state foundation |
| `LocatorCache` | `src/runtime/locator-cache.ts` | siteKey×actionKey → locator | 5 — learned locator store |
| `SessionManager` | `src/runtime/session-manager.ts` | Resilient session re-attach | 3a — state survives restarts |
| `MemoryService` | `src/memory/service.ts` | JSONL persistence, recall | 5 — extend with policies |
| `ContextTracker` | `src/context-tracker.ts` | Auto-loads references on domain/bundleId change | 3b — perception source |
| `Supervisor` | `src/supervisor/supervisor.ts` | Stall detection, recovery queue | 4b — fuse into recovery engine |
| `Observer Daemon` | `scripts/observer-daemon.ts` | Background capture + OCR, 2s loop | 3b — subsume into coordinator |
| `PlaybookEngine` | `src/playbook/engine.ts` | Deterministic step execution | 4a — deterministic plan runner |
| `RecallEngine` | `src/memory/recall.ts` | Strategy hints, error warnings | 4a — plan source |
| 38 reference files | `references/*.json` | Selectors, shortcuts, flows, errors | 6 — baseline to expand |
| 28 playbook files | `playbooks/*.json` | Recorded workflows | 4a + 6 — deterministic plans |
| `UIEvent` types | `src/types.ts:246-268` | 10 event types | 3a/3b — event sources |

---

## Phase 3a: World Model

**Depends on**: Nothing (first phase)
**Extends**: `PlanningLoop`, `SessionManager`, `MemoryStore`

### What It Does

Creates a persistent, per-session belief state about the desktop. Instead of rediscovering the UI on every tool call, the system maintains what it believes is true. This belief state is the foundation everything else reads from.

### Why It Matters for Tool Mastery

Without a world model, ScreenHand treats every tool call as isolated. With it:
- "I know the Export dialog is open in Premiere Pro" — no need to re-scan
- "I know the Format dropdown shows H.264" — can verify without re-reading
- "I know a Save dialog appeared" — can trigger recovery
- "The last 5 state transitions match the export flow" — can predict next step

### New Files

```
src/state/
  types.ts          — WorldState, WindowState, ControlState, DialogState
  world-model.ts    — WorldModel class: get/set/merge, confidence decay, diff
  persistence.ts    — Atomic read/write to ~/.screenhand/state/
  index.ts          — Public exports
```

### Key Interfaces

```typescript
interface WorldState {
  sessionId: string;
  updatedAt: string;
  confidence: number;                    // 0.0-1.0, decays without updates

  activeApp: AppState | null;
  windows: Map<number, WindowState>;
  pendingGoal: string | null;            // set by planner (Phase 4a)
  expectedPostcondition: StateAssertion | null;
  recentTransitions: StateTransition[];  // rolling buffer, max 50
}

interface WindowState {
  windowId: number;
  title: string;
  bundleId: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };

  // Generic UI state (all apps)
  focusedElement: ControlState | null;
  visibleControls: ControlState[];       // top-level interactive elements
  dialogStack: DialogState[];            // modal/sheet/popover stack
  scrollPosition: { x: number; y: number } | null;

  // App-specific domain state (Tier 3 pro apps)
  // Loaded from reference file's "domainSchema" field per bundleId.
  // Without this, the world model is useless for workspace operations.
  domainState: AppDomainState | null;

  // Perception metadata
  lastAXScanAt: string | null;
  lastCDPScanAt: string | null;
  lastOCRAt: string | null;
  lastScreenshotHash: string | null;
}

// App-specific domain state — typed per app family, loaded from references.
// This MUST be in Phase 3a, not deferred to Phase 6, because the planner
// and recovery engine need domain-aware state to be useful for pro apps.
interface AppDomainState {
  appFamily: AppFamily;
  // Concrete fields depend on family — see below
  [key: string]: unknown;
}

type AppFamily = "video_editor" | "image_editor" | "design_tool" | "audio_editor" | "browser" | "generic";

// Example domain schemas per app family:
//
// video_editor (Premiere Pro, DaVinci Resolve, Final Cut Pro):
//   playheadPosition: string | null       — timecode "00:01:23:15"
//   selectedClips: string[]               — clip names/IDs
//   activeSequence: string | null         — sequence/timeline name
//   activePage: string | null             — "Edit" | "Color" | "Fairlight" | "Deliver" (DaVinci)
//   activeTool: string | null             — "Selection" | "Razor" | "Pen" etc.
//   renderStatus: string | null           — "idle" | "rendering" | "queued"
//   mediaOffline: boolean                 — any offline media detected
//
// image_editor (Photoshop, GIMP):
//   activeLayer: string | null            — layer name
//   layerCount: number                    — total layers
//   selectedLayers: string[]              — selected layer names
//   activeTool: string | null             — "Brush" | "Move" | "Selection" etc.
//   canvasZoom: number | null             — zoom percentage
//   documentSize: { width: number; height: number } | null
//
// design_tool (Canva, Figma):
//   currentPage: string | null            — page/frame name
//   selectedElements: string[]            — element names/IDs
//   activeTool: string | null             — "Select" | "Text" | "Shape" etc.
//   canvasZoom: number | null
//   sidebarPanel: string | null           — "Elements" | "Text" | "Uploads" etc.
//
// These schemas are defined in references/{app}.json under a "domainSchema" key.
// The WorldModel loads the schema on context change and validates domain state
// updates against it. Unknown fields are stored but flagged low-confidence.

interface ControlState {
  role: string;
  label: string | null;
  value: string | null;
  enabled: boolean;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  stableId: string;                      // hash of role+label+position for tracking
  lastSeenAt: string;
  confidence: number;
}

interface DialogState {
  type: "modal" | "sheet" | "popover" | "alert" | "permission" | "save" | "unknown";
  title: string | null;
  message: string | null;
  buttons: string[];
  detectedAt: string;
  source: "ax" | "cdp" | "ocr" | "observer";
}

interface StateTransition {
  timestamp: string;
  trigger: string;          // tool name or event type
  field: string;            // what changed
  oldValue: string | null;
  newValue: string | null;
}

interface StateAssertion {
  type: "element_visible" | "element_focused" | "value_equals" | "dialog_dismissed" |
        "app_active" | "window_title" | "url_matches" | "text_appears";
  target: string;
  expected: string;
}
```

### WorldModel Class

```typescript
class WorldModel {
  // Read — generic state
  getState(): Readonly<WorldState>;
  getWindow(windowId: number): WindowState | undefined;
  getActiveWindow(): WindowState | undefined;
  getFocusedElement(): ControlState | null;
  getDialogStack(): DialogState[];

  // Read — app-specific domain state
  getDomainState(): AppDomainState | null;
  getDomainField(key: string): unknown;     // e.g., getDomainField("playheadPosition")
  getAppFamily(): AppFamily;

  // Write — called by perception sources (Phase 3b) and tool post-calls
  updateFromAXTree(windowId: number, tree: AXNode[], timestamp: string): void;
  updateFromCDP(windowId: number, domState: CDPState, timestamp: string): void;
  updateFromOCR(windowId: number, ocrResult: OCRResult, timestamp: string): void;
  updateFromEvent(event: UIEvent): void;

  // Write — app-specific domain state (from OCR, AX title parsing, keyboard echo, etc.)
  updateDomainState(windowId: number, partial: Partial<AppDomainState>): void;
  loadDomainSchema(bundleId: string): void;  // loads schema from references/{app}.json

  // Post-action verification
  setExpectedPostcondition(assertion: StateAssertion): void;
  verifyPostcondition(): { matched: boolean; actual: string | null; confidence: number };

  // Confidence
  decayConfidence(): void;              // timer-based, stale entries lose confidence
  getConfidence(path: string): number;

  // Diff
  diff(previous: WorldState): StateTransition[];

  // Persistence
  save(): Promise<void>;                // atomic write to ~/.screenhand/state/{sessionId}.json
  static load(sessionId: string): Promise<WorldModel | null>;
}
```

### Integration Points

| Where | Change | Purpose |
|---|---|---|
| `mcp-desktop.ts` intelligence wrapper POST-CALL | Call `worldModel.updateFromAXTree()` or `updateFromCDP()` | Keep world model current after every action |
| `mcp-desktop.ts` intelligence wrapper PRE-CALL | Read world model for context hints | Richer hints: "Save dialog is blocking" |
| `src/runtime/service.ts` | WorldModel reference on service | After `elementTree()`, feed into world model |
| `src/runtime/session-manager.ts` | On re-attach, load world state from disk | State survives MCP restart |
| Persistence | `~/.screenhand/state/{sessionId}.json` | Atomic writes via existing `writeFileAtomicSync` |

### Validation

| Check | Method | Pass Criteria |
|---|---|---|
| State persists across restart | Kill MCP, restart, check state | State matches last save |
| Confidence decays | Set state, wait 10s | Confidence < 1.0 for stale entries |
| AX tree → world model | Call `ui_tree`, check model | focusedElement and visibleControls populated |
| Transitions recorded | 5 actions → check transitions | 5 entries with correct trigger/field |
| Postcondition verification | Set expected, check after action | Correct match/mismatch detection |
| Dialog detection | Open dialog, update from AX | dialogStack has correct type/buttons |
| Atomic persistence | Corrupt mid-write, reload | Valid state (old or new), never corrupt |
| Domain schema loads | Focus DaVinci Resolve, check domain state | `appFamily: "video_editor"`, schema fields present |
| Domain state updates | OCR reads playhead timecode, update domain state | `playheadPosition` updated, confidence set |
| Domain state from reference | Load Premiere Pro reference with `domainSchema` | Schema fields match reference definition |
| Memory usage | 100 windows, 1000 controls | Under 20MB for world model |

### Tests

```
tests/world-model.test.ts
  - creates empty state for new session
  - updates focused element from AX tree
  - tracks dialog stack correctly
  - decays confidence over time
  - persists and reloads atomically
  - verifies postconditions correctly
  - records state transitions
  - handles window add/remove
  - merges partial updates without losing state
  - generates correct diffs
  - loads domain schema from reference file
  - updates domain state fields (playhead, active tool, etc.)
  - validates domain state against schema
  - unknown domain fields stored with low confidence
  - domain state persists and reloads correctly
```

---

## Phase 3b: Continuous Perception

**Depends on**: Phase 3a (world model to write into)
**Extends**: `StateObserver`, `observer-daemon.ts`, `ContextTracker`, `VisionAdapter`

### What It Does

Replaces on-demand perception with continuous multi-source fusion. The world model is always current, not just updated when a tool is called.

### Why It Matters for Tool Mastery

For apps like Premiere Pro and Canva where the canvas is opaque to AX/CDP:
- Continuous screenshot diff tells you when something changed (~0ms to know)
- ROI OCR on the changed region tells you what changed (~100ms vs ~600ms full screen)
- AX events tell you about panel/menu changes instantly (push, ~0ms)
- The system sees dialogs, loading states, and errors before you ask

### New Files

```
src/perception/
  types.ts              — PerceptionSource, PerceptionEvent, ROI
  coordinator.ts        — PerceptionCoordinator: manages all sources, feeds world model
  ax-source.ts          — Wraps StateObserver + periodic AX tree polls
  cdp-source.ts         — CDP DOM mutation observer + periodic snapshots
  vision-source.ts      — Screenshot diff + ROI OCR (in-memory)
  frame-differ.ts       — Fast image hash + region extraction
  index.ts
```

### Multi-Rate Architecture

```
FAST (100ms) — Event-driven, push
  ├── AX events from StateObserver buffer
  ├── CDP DOM mutation events
  └── Update world model with push events
  └── Check if postcondition is now satisfied

MEDIUM (500ms) — Structured polling
  ├── AX tree snapshot for active window
  ├── CDP DOM snapshot for active tab
  └── Update world model controls/focus/dialogs

SLOW (2000ms) — Visual verification
  ├── Screenshot of active window
  ├── Hash comparison with last frame
  ├── If changed AND low confidence: ROI OCR on changed region
  └── Update world model visual state

BACKGROUND (on-demand) — Full scan
  ├── Full-screen OCR (only when all sources fail)
  ├── Multi-window scan (only on context switch)
  └── Deep AX tree (only for unknown UI)
```

### ROI OCR: The Key to Canvas-Heavy Apps

This is the single most important change for tools like Premiere Pro, Canva, Photoshop:

```typescript
interface ROI {
  x: number; y: number; width: number; height: number;
  reason: "changed_pixels" | "low_confidence_control" | "dialog_area" | "focused_element";
}

class VisionSource {
  private lastFrameHash: string | null = null;
  private lastFrameBuffer: Buffer | null = null;  // in-memory, NO temp file

  // Capture + diff: did anything change?
  async captureAndDiff(windowId: number): Promise<{
    changed: boolean;
    changedRegions: ROI[];
    hash: string;
  }>;

  // OCR just the changed region: what changed?
  async ocrRegion(windowId: number, roi: ROI): Promise<{
    text: string;
    regions: Array<{ text: string; bounds: Bounds }>;
    latencyMs: number;
  }>;
}
```

**Performance comparison:**

| Operation | Current | With ROI | Improvement |
|---|---|---|---|
| Full screen OCR | ~600ms, file-based | Still available as fallback | Same |
| Region OCR | Not available | ~100ms, in-memory | NEW |
| Screenshot | ~400ms, writes temp file | ~200ms, in-memory buffer | 2x, no disk I/O |
| "Did anything change?" | Requires full OCR | Hash comparison ~5ms | 120x faster |

### Native Bridge Additions (Additive Only)

| New Method | Purpose | Existing method preserved |
|---|---|---|
| `cg.captureWindowBuffer` | Returns base64 PNG in memory, no temp file | `cg.captureWindow` unchanged |
| `vision.ocrRegion` | OCR with crop bounds, region-only | `vision.ocr` unchanged |

### Observer Daemon Boundary

The current observer daemon (`scripts/observer-daemon.ts`) runs as a separate process. **Keep this boundary.** Do not move capture/OCR into the MCP server process.

Reasons:
- **Restart resilience**: Observer survives MCP restarts. If capture crashes, it doesn't take down tool execution.
- **Hot-path isolation**: OCR at ~600ms or even ~100ms ROI must not block a 50ms AX tool call.
- **Resource isolation**: Capture/OCR memory and CPU spikes stay in a separate process.

The perception coordinator **manages** the daemon, it does not **replace** it:

```
PerceptionCoordinator (in MCP server process)
  ├── AX Source: push events from StateObserver (in-process, fast)
  ├── CDP Source: push events from mutation observer (in-process, fast)
  ├── Observer Daemon (separate process, managed)
  │     ├── Screenshot capture + hash diff
  │     ├── ROI OCR on changed regions
  │     └── Writes state.json atomically
  └── Daemon Reader: polls observer state.json (in-process, ~5ms read)
        └── Feeds results into world model
```

The coordinator adds value by:
1. Starting/stopping the daemon as needed
2. Reading its state.json and fusing results with AX/CDP data
3. Managing the multi-rate loop (fast AX events + medium structured polls + slow visual from daemon)
4. Requesting specific ROI OCR by writing to a daemon command file

### Integration Points

| Where | Change | Purpose |
|---|---|---|
| Observer daemon | Enhanced with ROI OCR + command file, stays as separate process | Better visual perception without hot-path risk |
| `observer_start/stop/status` tools | Coordinator manages daemon lifecycle | Same API, managed daemon behind it |
| Coordinator in MCP process | New: fuses AX/CDP events + daemon visual state → world model | Continuous awareness without blocking tools |
| Context tracker | Reads from world model, not tool params | Domain/bundleId from state transitions |
| Intelligence wrapper PRE-CALL | Include perception freshness in hints | "World model is 200ms stale" vs "5min stale" |

### Validation

| Check | Method | Pass Criteria |
|---|---|---|
| AX events → world model | Interact with app, check model | Changes reflected within 100ms |
| CDP mutations → world model | Navigate browser, check model | DOM changes within 200ms |
| Screenshot diff works | Change window, check diff | `changed: true` with regions |
| ROI OCR < full OCR | Benchmark both | ROI < 200ms, full > 500ms |
| Multi-rate loops run | Start coordinator, check all loops | Fast/medium/slow at correct intervals |
| Doesn't block tool calls | Run tool during active perception | Tool latency unchanged (<10ms overhead) |
| Memory bounded | Run 5 minutes | MCP process heap under 100MB (OCR/capture in daemon) |
| Observer daemon managed | Coordinator starts/stops daemon | Daemon PID tracked, clean lifecycle |
| Daemon crash isolated | Kill daemon, check MCP process | MCP continues, coordinator restarts daemon |
| Observer API compatible | Call `observer_status` | Returns equivalent data to current daemon |

### Tests

```
tests/perception-coordinator.test.ts
  - starts and stops cleanly
  - AX events flow to world model
  - screenshot diff detects changes correctly
  - ROI OCR produces correct text
  - multi-rate loops at correct intervals
  - handles bridge disconnect gracefully
  - pauses when no active session
  - memory bounded over extended run

tests/frame-differ.test.ts
  - identical frames = same hash
  - different frames = different hash
  - changed region extraction correct
  - edge cases (blank screen, tiny changes)

tests/vision-source.test.ts
  - ROI crop correct
  - in-memory avoids file I/O
  - region OCR returns bounded results
```

---

## Phase 4a: Planner

**Depends on**: Phase 3a (world model), Phase 3b (perception)
**Extends**: `loop.ts`, `execution-contract.ts`, `playbook/engine.ts`

### What It Does

Replaces "one LLM call per action" with goal-oriented planning:
- Known workflows → deterministic execution from playbooks (no LLM, fast)
- Novel tasks → LLM generates plan, then deterministic execution
- Failure → replan, not just retry

### Why It Matters for Tool Mastery

This is where Layer 2 (Tool Knowledge) gets its payoff:
- 28 playbooks become **deterministic execution plans** — zero LLM calls
- Strategy recall matches tool sequences → plans from memory
- Reference selectors → reliable target identification
- Known errors → preemptive avoidance in plans

**The core loop:**

```
"Export Premiere Pro timeline as H.264"

1. CHECK: Do we have a playbook for premiere-pro-export? YES → use it
2. PLAN: playbook has 8 steps with postconditions
3. EXECUTE: step 1 → verify → step 2 → verify → ... → step 8 → verify
4. LLM CALLS: 0 (all deterministic)
5. TIME: ~4 seconds total

vs. current:
1. LLM: "What should I do?" → "Focus Premiere Pro"
2. LLM: "OK, focused. Now?" → "Press Cmd+M"
3. LLM: "Export dialog open. Now?" → "Set format to H.264"
... 8 LLM round-trips, each ~2-5 seconds
5. TIME: ~20-40 seconds total
```

### New Files

```
src/planner/
  types.ts          — Goal, Subgoal, ActionPlan, PlanStep
  planner.ts        — Goal decomposition, plan generation, replanning
  executor.ts       — PlanExecutor: runs steps, verifies postconditions
  deterministic.ts  — DeterministicRunner: executes playbooks at full speed
  index.ts
```

### Key Interfaces

```typescript
interface Goal {
  id: string;
  description: string;
  status: "pending" | "active" | "completed" | "failed" | "replanning";
  subgoals: Subgoal[];
}

interface Subgoal {
  id: string;
  description: string;
  status: "pending" | "active" | "completed" | "failed" | "skipped";
  plan: ActionPlan | null;
  attempts: number;
  maxAttempts: number;        // default 3
}

interface ActionPlan {
  steps: PlanStep[];
  currentStepIndex: number;
  confidence: number;          // how likely this plan works
  source: "playbook" | "strategy" | "llm" | "learned";
}

interface PlanStep {
  tool: string;
  params: Record<string, unknown>;
  expectedPostcondition: StateAssertion;
  timeout: number;
  fallbackTool?: string;
  requiresLLM: boolean;       // true = must ask LLM before executing
  status: "pending" | "executing" | "completed" | "failed";
}

type ReplanReason =
  | "postcondition_mismatch"
  | "unexpected_dialog"
  | "element_not_found"
  | "app_switched"
  | "confidence_low"
  | "timeout";
```

### Plan Source Priority

| Priority | Source | Speed | When used |
|---|---|---|---|
| 1 | Playbook match | Instant | Exact workflow match in `playbooks/*.json` |
| 2 | Strategy recall | Instant | Tool sequence match in `strategies.jsonl` |
| 3 | Reference flow | Instant | Named flow in `references/*.json` |
| 4 | LLM generation | 2-5s | No match found, novel task |

### Execution Flow

```
1. Goal received
   └── Planner.planGoal(goal)

2. For each subgoal:
   a. findDeterministicPlan(subgoal, worldState)
      - Check playbooks: PlaybookEngine match
      - Check strategies: RecallEngine.recallStrategies()
      - Check reference flows: ContextTracker.getActivePlaybook().flows
   b. If found → ActionPlan with source="playbook"|"strategy"|"learned"
   c. If not → LLM generates plan → ActionPlan with source="llm"

3. PlanExecutor runs plan:
   for each step:
     a. Read world model for current state
     b. Execute via existing executor (AX/CDP/OCR/coordinates)
     c. Set postcondition in world model
     d. Wait for perception to confirm postcondition

     IF postcondition fails:
       e. RecoveryEngine.diagnose(worldState) — Phase 4b
       f. If recovered: resume plan
       g. If not: Planner.replan(goal, reason, worldState)
```

### Integration with Existing Systems

| System | How planner uses it |
|---|---|
| `PlaybookEngine` | Deterministic plan execution — no LLM needed |
| `RecallEngine` | Strategy-based plan generation |
| `ContextTracker` | Reference flows as plan templates |
| `WorldModel` | State reads for plan decisions, postcondition verification |
| `Executor` | Actual action execution (locate → act → verify) |
| `MemoryService` | Error warnings to avoid known-bad paths |

### Validation

| Check | Method | Pass Criteria |
|---|---|---|
| Playbook → deterministic plan | Known workflow, check LLM calls | LLM calls = 0 |
| Strategy → plan | Execute previously successful sequence | Plan generated from strategy |
| Novel → LLM plan | New workflow, check plan quality | Valid steps with postconditions |
| Postcondition triggers replan | Force step failure | Replan generates alternative |
| Dialog triggers replan | Insert dialog mid-plan | Plan pauses, dialog handled, resumes |
| maxAttempts enforced | Repeated failure | Stops after 3, reports failure |
| 10-step known workflow | Execute 10 times | Success rate > 85% |
| Speed comparison | Same workflow, planner vs current | Planner 3-5x faster for known |

### Tests

```
tests/planner.test.ts
  - decomposes goal into subgoals
  - finds deterministic plan from playbook
  - finds plan from strategy recall
  - falls back to LLM when no match
  - replans on postcondition mismatch
  - respects maxAttempts
  - serializes and deserializes plans

tests/plan-executor.test.ts
  - executes steps in order
  - verifies postconditions after each step
  - triggers replan on failure
  - uses fallback tool when primary fails
  - skips satisfied subgoals
```

---

## Phase 4b: Recovery Engine

**Depends on**: Phase 3a (world model), Phase 4a (planner)
**Extends**: `supervisor.ts`, `execution-contract.ts`

### What It Does

Fuses supervisor recovery into the main execution loop. Recovery becomes a planner behavior — detect blocker from world model, select strategy, execute, verify, resume.

### Why It Matters for Tool Mastery

Pro tools are full of unexpected states:
- Premiere Pro: "Media Offline" dialog, render errors, plugin crashes, autosave prompts
- Canva: "Upgrade to Pro" modals, save conflicts, collaboration prompts
- DaVinci Resolve: database prompts, codec warnings, GPU errors
- Any app: permission dialogs, update notifications, focus loss

Without recovery, any of these breaks the workflow. With recovery, they're handled automatically.

### New Files

```
src/recovery/
  types.ts          — RecoveryEvent, RecoveryStrategy, BlockerType, RecoveryBudget
  engine.ts         — RecoveryEngine: detect, strategize, execute, verify
  detectors.ts      — Blocker detection from world model state
  strategies.ts     — Built-in + learned recovery strategies
  index.ts
```

### Blocker Types

```typescript
type BlockerType =
  | "unexpected_dialog"       // save, confirmation, alert
  | "permission_dialog"       // accessibility, camera, microphone
  | "login_required"          // session expired, auth wall
  | "captcha"                 // CAPTCHA challenge
  | "rate_limited"            // too many requests
  | "app_crashed"             // unresponsive
  | "focus_lost"              // wrong app active
  | "element_gone"            // target disappeared
  | "selector_drift"          // selector behavior changed
  | "network_error"           // page failed to load
  | "loading_stuck"           // spinner not resolving
  | "unknown_state"           // world model confidence too low
```

### Built-In Strategies

| Blocker | Strategy | Steps |
|---|---|---|
| `unexpected_dialog` | Dismiss | Detect buttons → click Cancel/Don't Save/OK → verify |
| `permission_dialog` | Grant | Click Allow/OK → verify |
| `login_required` | Escalate | Pause plan → notify user → wait |
| `focus_lost` | Refocus | `focus(bundleId)` → verify active app |
| `element_gone` | Relocate | Re-scan AX tree → search by label → OCR fallback |
| `selector_drift` | Adapt | Try alternates from LocatorCache → learn new selector |
| `app_crashed` | Restart | `launch(bundleId)` → wait → restore from world model |
| `loading_stuck` | Wait then retry | Wait 3s → recheck → reload if still stuck |
| `unknown_state` | Full perception | Full AX + screenshot + OCR → rebuild world model |

### App-Specific Recovery (From References)

Reference files can define app-specific recovery strategies:

```json
{
  "errors": [
    {
      "error": "Media Offline dialog",
      "context": "Premiere Pro timeline with missing media",
      "solution": "Click 'Link Media' button, then navigate to media folder",
      "severity": "high"
    }
  ]
}
```

The recovery engine checks reference errors first, then falls back to built-in strategies.

### Recovery Budget

```typescript
interface RecoveryBudget {
  maxRecoveryTimeMs: number;    // default 30s
  maxStrategies: number;        // default 3
  escalateAfter: number;        // escalate to user after N failed strategies
}
```

### Integration with Planner

```
Plan step fails
  → RecoveryEngine.diagnose(worldState)
  → Check references for app-specific recovery
  → Try built-in strategy
  → If recovered: resume plan
  → If not: try next strategy (up to budget)
  → If budget exhausted: escalate to planner for full replan
  → If replan fails: escalate to user
```

### Supervisor Refactoring

**Keep in supervisor**: Lease claim/release/heartbeat, PID file, one-client-per-window
**Move to RecoveryEngine**: Stall detection (from world model, not heartbeat), blocker detection (from dialog stack, not external OCR), recovery execution

### Validation

| Check | Method | Pass Criteria |
|---|---|---|
| Dialog auto-dismissed | Open Save dialog during task | Dismissed, task continues |
| Focus recovery | Switch app during task | Refocuses, resumes |
| Element relocation | Resize window during task | Element found at new position |
| App crash recovery | Kill target app during task | Relaunched, state restored |
| Budget enforced | Unrecoverable scenario | Stops after N, escalates |
| No recovery loop | Repeated failure | Different strategies, no same one twice |
| Reference-based recovery | App-specific error pattern | Uses reference solution first |

### Tests

```
tests/recovery-engine.test.ts
  - detects dialog from world model
  - selects correct strategy per blocker type
  - executes recovery and verifies
  - falls back to next strategy on failure
  - respects budget
  - escalates after exhaustion
  - uses reference errors when available
  - cooldown prevents immediate retry

tests/detectors.test.ts
  - identifies all 12 blocker types from world model
  - no false positives on clean state
```

---

## Phase 5: Learning Engine

**Depends on**: Phases 3-4 (all previous)
**Extends**: `MemoryService`, `LocatorCache`, `RecallEngine`, `ContextTracker`

### What It Does

Turns passive logging into active policy improvement. Every action outcome makes the system smarter for that specific app and workflow.

### Why It Matters for Tool Mastery

Each tool has its own patterns:
- "In Canva, AX never finds canvas elements — don't waste time trying, use OCR"
- "In Premiere Pro, Cmd+M is 3x faster than File → Export → Media"
- "In DaVinci Resolve, the Color page loads in ~2s — wait before clicking"
- "Dismissing Canva's upgrade modal by pressing Escape works 95% of the time"

Without learning, you rediscover this every session. With learning, each session starts smarter.

### New Files

```
src/learning/
  types.ts              — Policies, timing model, learning entry
  engine.ts             — LearningEngine: observe outcomes, update policies
  locator-policy.ts     — Per-app locator stability tracking
  recovery-policy.ts    — Per-blocker recovery strategy ranking
  timing-model.ts       — Per-tool×app adaptive timeout computation
  sensor-policy.ts      — Per-app perception source ranking
  index.ts
```

### What Gets Learned

| Signal | Source | Stored As | Used By |
|---|---|---|---|
| Locator stability | Executor success/fail per selector | Score per app×action×locator | Planner: prefer stable locators |
| Sensor effectiveness | Perception: which source found target | Ranking per app | Perception: prioritize best source |
| Recovery success | Recovery engine outcomes | Score per blocker×app×strategy | Recovery: try best strategy first |
| Action timing | Executor telemetry | Distribution per tool×app | Executor: adaptive timeouts |
| Shortcut vs menu | Plan source comparison | Preference per app×action | Planner: choose fastest path |
| UI state patterns | World model transitions | Pattern per app | Planner: predict next state |

### Feedback Loops

```
LOCATOR LEARNING:
  Planner picks locator (from learned policy or default)
  → Executor tries it
  → Success: increment score for this app×action×locator
  → Failure: decrement, try next
  → After 5+ data points: confident recommendation

SENSOR ROUTING:
  Perception polls all sources
  → For each that finds the target: record success
  → Over time: "Canva canvas → always OCR", "VS Code → always AX"
  → Coordinator adjusts priority per app

RECOVERY ORDERING:
  Recovery tries strategies in confidence order
  → Success: boost score for this blocker×app×strategy
  → Failure: reduce score
  → Next time: best strategy first

ADAPTIVE TIMEOUTS:
  Executor records duration per tool×app
  → After 10+ samples: compute p50, p95
  → Replace fixed 800ms/200ms/2000ms with:
    locateMs = max(p95, 200ms)
    actMs = max(p95, 100ms)
    verifyMs = max(p95, 500ms)
```

### Persistence

```
~/.screenhand/learning/
  locators.jsonl       — locator scores per app×action
  sensors.jsonl        — sensor effectiveness per app
  recoveries.jsonl     — recovery success rates per blocker×app
  timings.jsonl        — action durations per tool×app
  patterns.jsonl       — UI state patterns per app
```

### Validation

| Check | Method | Pass Criteria |
|---|---|---|
| Locator preference learned | Same app 10 times | Stable locator has highest score |
| Sensor preference learned | Mix of AX/CDP apps | Correct source prioritized per app |
| Recovery preference learned | Same blocker 5 times | Best strategy first by attempt 5 |
| Adaptive timeouts work | 20 actions in same app | Budgets adjust from defaults |
| Persists across restarts | Learn, restart, check | Same preferences |
| Cold start works | New app, no history | Falls back to defaults |
| No overfitting | 3 success then 1 failure | Score adjusts, doesn't reset |
| Performance impact | With/without learning | < 5ms overhead per action |

### Tests

```
tests/learning-engine.test.ts
  - records outcomes correctly
  - computes locator preferences
  - computes sensor preferences
  - computes recovery preferences
  - adaptive timeouts converge
  - cold start graceful
  - persists and reloads
  - prunes at size limits

tests/timing-model.test.ts
  - p50/p95 correct
  - adapts budgets from distribution
  - handles outliers
  - defaults with insufficient data
```

---

## Phase 6: Tool Mastery at Scale

**Depends on**: Phases 3-5 (all autonomy + learning in place)
**Extends**: `references/`, `playbooks/`, `ContextTracker`

### What It Does

Systematically acquires tool expertise from existing knowledge sources: documentation, tutorials, menu bars, keyboard shortcut lists, community workflows, expert recordings. This is where ScreenHand stops being "a tool that can control apps" and becomes "a platform that masters apps."

### Why This Phase Exists

Right now, every reference file is hand-curated. That doesn't scale:
- Premiere Pro has 500+ keyboard shortcuts. Someone typed each one into JSON.
- DaVinci Resolve has 4 menu map files. Someone navigated every menu manually.
- Canva has 7 reference files. Someone explored the app exhaustively.

Phase 6 automates this.

### New Files

```
src/ingestion/
  types.ts              — KnowledgeSource, IngestedItem, CoverageReport
  doc-parser.ts         — Extract workflows from HTML/PDF documentation
  shortcut-extractor.ts — Parse keyboard shortcut lists into reference format
  menu-scanner.ts       — Scan entire menu bar via AX, extract all paths + shortcuts
  tutorial-extractor.ts — Extract steps from YouTube transcript + timestamps
  reference-merger.ts   — Merge ingested knowledge into existing reference files
  coverage-auditor.ts   — Audit: what's covered, what's missing per app
  index.ts

src/community/
  types.ts              — SharedPlaybook, PlaybookRating, ContributionMeta
  publisher.ts          — Publish validated playbook to shared repository
  fetcher.ts            — Fetch community playbooks by app + workflow
  validator.ts          — Test playbook against live app before accepting
  index.ts
```

### Knowledge Ingestion Pipelines

#### Pipeline 1: Menu Bar Scanner

**Input**: App is running
**Output**: Complete menu hierarchy with keyboard shortcuts
**Method**: AX tree scan of menu bar
**Already partially done**: DaVinci Resolve has 4 menu map files from manual scanning

```
Launch app
  → bridge.call("ax.getElementTree", { pid, maxDepth: 10, root: "AXMenuBar" })
  → Extract: every menu path, associated keyboard shortcut, enabled/disabled state
  → Convert to reference JSON:
    shortcuts: { "File.New Project": "Cmd+N", "File.Export.Media": "Cmd+M", ... }
    flows: { "export": { steps: ["File > Export > Media", "Set format", "Export"] } }
  → Merge into references/{app}.json
```

**Validation**: Compare extracted shortcuts against official shortcut list. Match rate should be > 90%.

#### Pipeline 2: Documentation Parser

**Input**: URL to official documentation or help center
**Output**: Structured reference data: features, shortcuts, UI terms, workflows
**Method**: Fetch HTML/PDF → extract structured content → convert to reference format

```
Fetch help page (e.g., helpx.adobe.com/premiere-pro/using/keyboard-shortcuts.html)
  → Parse HTML tables/lists
  → Extract: shortcut name, keys, context/condition
  → Convert to reference JSON shortcuts section
  → Merge into references/{app}.json
```

**Already partially built**: `src/platform/help-center-markdown.ts` and `scripts/export-help-center.ts` exist.

**Validation**: Spot-check 20 extracted shortcuts against app. Accuracy > 95%.

#### Pipeline 3: YouTube Tutorial Extractor

**Input**: YouTube video URL of a tutorial
**Output**: Playbook steps with verification
**Method**: Fetch transcript → identify action steps → map to tool calls → add verification

```
Fetch transcript via YouTube API or captions
  → NLP/LLM: identify action steps ("Click on File menu", "Select Export", "Choose H.264")
  → Map each to ScreenHand tool: menu_click(["File", "Export"]), etc.
  → Add postconditions: "Export dialog visible", "Format shows H.264"
  → Save as playbook: playbooks/{app}-{workflow}.json
```

**Validation**: Execute generated playbook against live app. Success rate for well-structured tutorials > 60% (iteratively improvable).

#### Pipeline 4: Expert Recording

**Input**: Human expert performs workflow with recording enabled
**Output**: Validated playbook with verification steps
**Method**: Already built — `playbook_record` tool captures every action

```
expert starts recording: playbook_record({ action: "start", ... })
  → expert performs workflow manually using ScreenHand tools
  → McpPlaybookRecorder captures every tool call, params, results
  → expert stops recording: playbook_record({ action: "stop", ... })
  → Post-processing: add verification steps, variables, descriptions
  → Save to playbooks/
```

**Enhancement needed**: Auto-add postconditions, detect and remove pauses/mistakes, add variable substitution for reusable parameters.

#### Pipeline 5: Community Sharing

**Input**: Validated local playbook
**Output**: Shared playbook available to all users
**Method**: Publish → review → distribute

```
User validates playbook locally (runs 3+ times successfully)
  → Publish to shared repository with metadata:
    app, version, workflow name, success rate, platform
  → Other users fetch: "Show me all Premiere Pro playbooks"
  → Local validation: run against their app version
  → Accept if passes, skip if fails
```

**Privacy model**: Playbooks contain tool sequences only (no personal data, no credentials, no file paths unless explicitly included).

### Coverage Auditor (src/ingestion/coverage-auditor.ts)

Answers: "How well do we know this app?"

```typescript
interface CoverageReport {
  app: string;
  bundleId: string;
  version: string;

  // What we know
  shortcutsKnown: number;
  selectorsKnown: number;
  flowsKnown: number;
  playbooksAvailable: number;
  errorsDocumented: number;

  // What we're missing
  menuPathsNotCovered: string[];      // from menu scan vs reference
  shortcutsNotInReference: string[];  // from official docs vs reference
  workflowsWithNoPlaybook: string[];  // common workflows with no automation

  // Quality
  selectorStabilityScore: number;     // from learning data
  playbookSuccessRate: number;        // from execution history
  averageRecoveryTime: number;        // from recovery data

  // Recommendations
  highValueGaps: string[];            // "Export workflow has no playbook — most requested"
}
```

### New MCP Tools

| Tool | Purpose |
|---|---|
| `scan_menu_bar` | Scan app's entire menu bar, extract to reference |
| `ingest_documentation` | Parse URL/file, extract to reference |
| `ingest_tutorial` | Extract playbook steps from YouTube transcript |
| `coverage_report` | Generate coverage audit for an app |
| `community_fetch` | Fetch community playbooks for an app |
| `community_publish` | Publish validated playbook |

### Coverage Targets

| Tool | Current | After Phase 6 |
|---|---|---|
| Premiere Pro | 0 refs, 0 playbooks | 3+ refs (menus, shortcuts, panels), 20+ playbooks |
| After Effects | 0, 0 | 3+, 15+ |
| Photoshop | 0, 0 | 3+, 20+ |
| Final Cut Pro | 0, 0 | 3+, 15+ |
| Logic Pro | 0, 0 | 2+, 10+ |
| Blender | 0, 0 | 3+, 20+ |
| Excel/Sheets | 0, 0 | 2+, 15+ |
| DaVinci Resolve | 7 refs, 3 playbooks | 7+, 30+ |
| Canva | 7, 1 | 7+, 20+ |
| Figma | 1, 0 | 3+, 15+ |

### Validation

| Check | Method | Pass Criteria |
|---|---|---|
| Menu scanner extracts correctly | Scan known app, compare to manual | > 90% match |
| Doc parser extracts shortcuts | Parse official shortcut page | > 95% accuracy |
| Tutorial playbook executes | Generate from tutorial, run | > 60% success rate |
| Coverage report accurate | Compare report to manual audit | All gaps identified |
| Community playbook validates | Fetch and test community playbook | Runs successfully on local app |
| Ingested knowledge improves autonomy | Before/after comparison | Higher success rate with more knowledge |

### Tests

```
tests/menu-scanner.test.ts
  - extracts menu hierarchy from AX tree
  - identifies keyboard shortcuts
  - detects enabled/disabled states
  - handles nested submenus

tests/doc-parser.test.ts
  - parses HTML shortcut tables
  - extracts workflow steps from documentation
  - handles multiple page formats

tests/coverage-auditor.test.ts
  - generates correct coverage report
  - identifies gaps between menu scan and reference
  - calculates quality scores correctly

tests/tutorial-extractor.test.ts
  - identifies action steps from transcript
  - maps steps to tool calls
  - adds postconditions
```

---

## Cross-Phase Integration

### How Layers Feed Each Other

```
Layer 6 (Tool Mastery) PRODUCES:
  ├── references/*.json → Layer 2 (Knowledge)
  ├── playbooks/*.json  → Layer 4 (Planner) deterministic plans
  ├── app profiles      → Layer 5 (Learning) cold start
  └── coverage maps     → Layer 3 (Perception) sensor routing hints

Layer 5 (Learning) IMPROVES:
  ├── Locator scores    → Layer 4 (Planner) picks stable locators
  ├── Sensor rankings   → Layer 3 (Perception) prioritizes best source
  ├── Recovery rankings → Layer 4 (Recovery) tries best strategy first
  ├── Timing models     → Layer 1 (Control) adaptive budgets
  └── Failure patterns  → Layer 6 (Mastery) updates reference errors

Layer 4 (Autonomy) USES:
  ├── World model       ← Layer 3 (Awareness) current state
  ├── Playbooks         ← Layer 2 (Knowledge) deterministic plans
  ├── Strategies        ← Layer 2 (Knowledge) recalled sequences
  ├── Error warnings    ← Layer 2 (Knowledge) known failures
  └── Learned policies  ← Layer 5 (Learning) preferences

Layer 3 (Awareness) FEEDS:
  └── World model       → Layers 4, 5, 6
```

### New MCP Tools by Phase

| Phase | Tools |
|---|---|
| 3a | `world_state`, `world_state_diff` |
| 3b | `perception_start`, `perception_stop`, `perception_status` |
| 4a | `plan_goal`, `plan_status`, `plan_cancel` |
| 4b | `recovery_status`, `recovery_configure` |
| 5 | `learning_status`, `learning_reset` |
| 6 | `scan_menu_bar`, `ingest_documentation`, `ingest_tutorial`, `coverage_report`, `community_fetch`, `community_publish` |

---

## End-to-End Validation Scenarios

Scenarios are grouped by tier. Each phase should be validated against at least one app per relevant tier.

### Tier 1/2 Scenarios (Browser / AX-native — high confidence expected)

| # | Scenario | Layers tested | Pass criteria |
|---|---|---|---|
| 1 | Open TextEdit, type "Hello", save as test.txt | 1, 3a, 4a | File saved correctly, 0 LLM calls |
| 2 | Same + unexpected Save dialog mid-typing | 1, 3a, 4a, 4b | Dialog dismissed, file saved |
| 3 | Open Safari, navigate to URL, extract page title | 1, 3a, 3b, 4a | Correct title, 0 LLM calls |
| 4 | Same + tab crash mid-navigation | 1, 3a, 4a, 4b | Tab reloaded, task completed |
| 5 | Finder: rename file, move to trash | 1, 3a, 4a | File in trash, 0 LLM calls |
| 6 | Scenario #1 repeated 10 times | 1-5 | Later runs measurably faster (learning) |
| 7 | Kill MCP mid-workflow, restart, continue | 3a, 4a | World state reloaded, resumes correctly |

### Tier 3 Scenarios (Pro apps — mixed confidence expected)

| # | Scenario | Layers tested | Pass criteria | Notes |
|---|---|---|---|---|
| 8 | DaVinci Resolve: open project, switch to Color page | 1, 2, 3a | Correct page active, domain state shows "Color" | Dialog workflow — AX accessible |
| 9 | DaVinci Resolve: render with playbook | 1, 2, 3a, 4a | Render completes, 0 LLM calls | Dialog workflow — uses existing playbook |
| 10 | Same + "Media Offline" dialog during render | 1, 2, 3a, 4a, 4b | Dialog handled per reference error entry | Recovery uses reference-defined strategy |
| 11 | Premiere Pro: Cmd+M → export H.264 (after Phase 6 reference exists) | 1, 2, 3a, 4a, 6 | Export dialog navigated correctly | Dialog workflow — AX accessible |
| 12 | Canva: toolbar operations (search, add text, change font) | 1, 2, 3a, 3b | Operations completed via CDP/AX | Panel workflow — not canvas |
| 13 | Canva: canvas element selection via OCR+coordinates | 1, 3b | Element selected | Workspace — low confidence expected |

### Phase 6 Scenarios (Knowledge ingestion)

| # | Scenario | Layers tested | Pass criteria |
|---|---|---|---|
| 14 | Scan Premiere Pro menu bar | 6, 2 | Reference file with 100+ shortcuts extracted |
| 15 | Parse official Premiere Pro shortcut page | 6, 2 | >90% match with menu scan results |
| 16 | New app with no reference: scan menus, then execute workflow | 3, 4, 6 | Reference generated, basic workflow succeeds |

## Performance Targets

Targets are **per app tier**, not platform-wide promises. What's achievable for a browser app is not achievable for Premiere Pro's timeline.

### Tier 1 (Browser) / Tier 2 (AX-native apps)

| Metric | Current | After Phase 3 | After Phase 4 | After Phase 5 |
|---|---|---|---|---|
| Known workflow (10 steps) | ~5s + 10 LLM | ~4s + 10 LLM | ~2-3s + 0 LLM | ~2s + 0 LLM |
| Novel workflow (10 steps) | ~30s + 10 LLM | ~25s + 10 LLM | ~12s + 2-3 LLM | ~10s + 1-2 LLM |
| Dialog recovery | Manual | Detected 100ms | ~1-2s auto | ~1s (learned) |
| Success rate | ~80% | ~85% | ~90% | ~90-95% |

### Tier 3 (Pro apps — Premiere Pro, DaVinci, Photoshop)

| Metric | Current | After Phase 3 | After Phase 4 | After Phase 5 | After Phase 6 |
|---|---|---|---|---|---|
| Dialog/panel workflow (10 steps) | ~8s + 10 LLM | ~6s + 10 LLM | ~4-6s + 0-1 LLM | ~3-5s + 0 LLM | ~3s + 0 LLM |
| Workspace workflow (10 steps) | ~15s + many OCR | ~12s + ROI OCR | ~8-10s + 2-3 LLM | ~7-8s + 1-2 LLM | ~6s (rich refs) |
| OCR (when needed) | ~600ms full | ~100-200ms ROI | ~100-200ms | ~100ms (skip when unnecessary) | ~100ms |
| Dialog recovery | Manual | Detected 100ms | ~2-3s auto | ~1-2s (learned) | ~1s (app-specific) |
| Success rate (dialog workflows) | ~65% | ~70% | ~80% | ~80-85% | ~85% |
| Success rate (workspace workflows) | ~40% | ~50% | ~55-60% | ~60-65% | ~65-70% |

### System-wide

| Metric | Current | Target |
|---|---|---|
| Memory footprint | ~30MB | ~80-100MB |
| Background CPU (perception active) | ~0% | ~3-5% |
| Apps with references | 38 | 60+ (Phase 6) |
| Apps with playbooks | 28 | 80+ (Phase 6) |
| New app cold start | All manual | Menu scan + doc parse (Phase 6) |

Note: Tier 3 workspace success rates are fundamentally bounded by what OCR+coordinates can do. Reaching >70% for workspace operations requires either app-specific API integration (ExtendScript for Adobe, Fusion scripting for DaVinci) or significantly better vision models. The autonomy stack improves reliability for the *reachable* surface, not the unreachable one.

---

## Implementation Timeline

Two parallel tracks. The autonomy track is sequential (each phase builds on previous). The mastery track runs independently.

```
AUTONOMY TRACK (sequential):

PHASE 3a: World Model                              Weeks 1-3
  └── src/state/ (types, world-model, persistence)
  └── Domain state schemas per app family
  └── Wire into intelligence wrapper + service
  └── Tests + validate with 2 apps (1 Tier 1/2 + 1 Tier 3)

PHASE 3b: Continuous Perception                    Weeks 4-7
  └── src/perception/ (coordinator, sources, frame-differ)
  └── Native bridge additions (captureWindowBuffer, ocrRegion)
  └── Enhance observer daemon with ROI OCR + command file
  └── Coordinator manages daemon, reads state.json
  └── Tests + validate with same 2 apps

PHASE 4a: Planner                                  Weeks 8-11
  └── src/planner/ (types, planner, executor, deterministic)
  └── Refactor agent loop to use planner
  └── Wire playbooks + strategies as plan sources
  └── Tests + validate: known playbook runs 0-LLM

PHASE 4b: Recovery Engine                          Weeks 12-14
  └── src/recovery/ (detectors, strategies, engine)
  └── Refactor supervisor to thin lease manager
  └── Wire into plan executor
  └── Tests + validate: dialog recovery in 2 apps

PHASE 5: Learning Engine                           Weeks 15-18
  └── src/learning/ (engine, policies, timing model)
  └── Wire into planner, perception, recovery
  └── Tests + validate: measurable improvement after 10+ runs

INTEGRATION + TUNING                               Weeks 19-20
  └── End-to-end scenarios by tier
  └── Performance benchmarks per app tier
  └── Confidence threshold tuning
  └── Learning convergence testing


MASTERY TRACK (parallel, starts week 3):

PHASE 6a: Menu Scanner                             Weeks 3-6
  └── src/ingestion/menu-scanner.ts
  └── Scan 5 apps: Premiere Pro, Photoshop, After Effects, Final Cut Pro, Logic Pro
  └── Generate reference files from scans
  └── Validate extracted shortcuts against official lists

PHASE 6b: Documentation Parser                     Weeks 7-10
  └── src/ingestion/doc-parser.ts, shortcut-extractor.ts
  └── Parse official shortcut pages for 5 apps
  └── Merge with menu scan results
  └── Coverage auditor: src/ingestion/coverage-auditor.ts

PHASE 6c: Expert Recording Campaign                Weeks 10-16
  └── Record 10+ playbooks per app using existing playbook_record
  └── Post-processing: add postconditions, variables, descriptions
  └── Validate each playbook runs 3+ times successfully

PHASE 6d: Community (if warranted)                 Weeks 16+
  └── src/community/ (publisher, fetcher, validator)
  └── Only build if there's user demand — not a prerequisite for anything
```

Note: The timeline is scoped to **one target app per tier** initially, then expanded. Trying to deliver "tool mastery for 15 apps" in 20 weeks is not realistic. The first milestone is: one Tier 1/2 app (e.g., Safari) + one Tier 3 app (e.g., DaVinci Resolve) working end-to-end through the full autonomy stack.

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| World model too generic for pro apps | Planner can't reason about timeline/canvas state, Phase 6 forces Phase 3 redesign | Domain state schemas in Phase 3a from day one, typed per app family |
| In-process perception blocks tool calls | OCR/capture latency leaks into action hot path | Keep observer as daemon boundary, coordinator manages but doesn't replace it |
| Targets overpromise for canvas-heavy apps | Tier 3 workspace never reaches Tier 1 reliability | Separate benchmarks per tier, be honest about OCR+coordinates limits |
| Continuous perception uses too much CPU | Battery/performance complaints | Multi-rate design, pause when idle, perception stays in daemon |
| World model drifts from reality | Wrong actions on stale beliefs | Confidence decay + periodic full refresh + postcondition checks |
| Planner generates bad plans | Worse than current approach | Falls back to current one-step model when confidence low |
| Learning overfits to one machine | Bad recommendations elsewhere | Per-app policies, cold start always works, decay old data |
| Native bridge changes break tools | Regression | New methods additive, existing methods unchanged |
| Phase 6 blocks autonomy track | Never ships autonomy waiting for ingestion | Phase 6 is parallel track, no dependency on Phases 3-5 |
| Ingested knowledge is wrong | Bad playbooks from docs/tutorials | Validation against live app before accepting |
| App updates break references | Stale selectors/shortcuts | Version tracking, periodic re-scan, selector stability scores |
| Scope creep across phases | Never ships | Each phase validates against specific app(s), not "all apps" |
| Domain schemas proliferate | Unmaintainable type explosion per app | Cap at 5 app families, use generic fallback for others |
