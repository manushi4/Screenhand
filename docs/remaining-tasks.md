# Remaining Tasks — Phase 3a, 3b, 4, 5

> Generated from code audit on 2026-03-13. Each task references exact files and line numbers.
> Estimated total: **7-11 days** of focused engineering work.

---

## Phase 3a: World Model — 40-45% done, needs ~3 days

### Current state
- Core WorldState/WindowState/ControlState types exist (`src/state/types.ts`)
- AX tree ingestion works (`world-model.ts:165`)
- Atomic persistence with debouncing works (`persistence.ts`)
- Confidence decay formula works on read (`world-model.ts:81-89`)
- 13 tests pass

### Remaining tasks

#### 3a.1 — Add missing WorldState fields
**File:** `src/state/types.ts:25-33`
**What:** Add these fields to the `WorldState` interface:
```
updatedAt: string
confidence: number               // top-level overall confidence
pendingGoal: string | null       // set by planner when a goal is active
expectedPostcondition: StateAssertion | null
recentTransitions: StateTransition[]  // rolling buffer, max 50
```
**Why:** The planner needs `pendingGoal`, the executor needs `expectedPostcondition`, and learning needs `recentTransitions` to detect patterns.
**Effort:** 1 hour
**Tests to add:** Update `world-model.test.ts` — verify new fields initialized, persisted, reloaded.

---

#### 3a.2 — Add missing WindowState fields
**File:** `src/state/types.ts:41-49`
**What:** Add:
```
focusedElement: ControlState | null
visibleControls: ControlState[]       // top-level interactive elements (subset of controls map)
dialogStack: DialogState[]            // per-window dialog stack (currently only on WorldState)
scrollPosition: { x: number; y: number } | null
lastAXScanAt: string | null
lastCDPScanAt: string | null
lastOCRAt: string | null
lastScreenshotHash: string | null
```
**Why:** Perception sources need to record WHEN each window was last scanned. The planner needs `focusedElement` to know what's selected.
**Effort:** 1.5 hours
**Tests to add:** Verify `lastAXScanAt` updated after `ingestAXTree()`, `focusedElement` set correctly.

---

#### 3a.3 — Add missing DialogState fields
**File:** `src/state/types.ts:69-75`
**What:** Add:
```
message: string | null
buttons: string[]
source: "ax" | "cdp" | "ocr" | "observer"
```
Add missing type values: `"permission" | "save" | "unknown"` to the `type` union.
**Why:** Recovery engine needs `buttons` to know which button to click. `source` helps debug which perception source found the dialog.
**Effort:** 30 min
**Tests to add:** Verify dialog buttons extracted from AX tree children.

---

#### 3a.4 — Add missing VideoEditorState fields
**File:** `src/state/types.ts:84-93`
**What:** Add:
```
playheadPosition: string | null       // timecode "00:01:23:15"
selectedClips: string[]
activeSequence: string | null         // timeline/sequence name
activePage: string | null             // "Edit" | "Color" | "Fairlight" | "Deliver" (DaVinci)
activeTool: string | null             // "Selection" | "Razor" | "Pen"
renderStatus: string | null           // "idle" | "rendering" | "queued"
mediaOffline: boolean
```
**Effort:** 30 min

---

#### 3a.5 — Add missing ImageEditorState & DesignToolState fields
**File:** `src/state/types.ts:95-108`
**What:**
ImageEditorState — add: `layerCount: number`, `selectedLayers: string[]`, `documentSize: Tracked<{width, height}> | null`
DesignToolState — add: `activeTool: Tracked<string> | null`, `sidebarPanel: Tracked<string> | null`, `canvasSize: Tracked<{width, height}> | null`
**Effort:** 30 min

---

#### 3a.6 — Implement missing WorldModel read methods
**File:** `src/state/world-model.ts`
**What:** Add these methods:
```typescript
getWindow(windowId: number): WindowState | undefined
getActiveWindow(): WindowState | undefined        // uses focusedWindowId
getFocusedElement(): ControlState | null           // from active window
getDialogStack(): DialogState[]                    // return activeDialogs
getDomainState(): AppDomainState | null            // for focused app
getDomainField(key: string): unknown               // e.g. getDomainField("playheadPosition")
getAppFamily(): AppFamily                          // from focused app's domain
getConfidence(path: string): number                // read confidence at dotted path
```
**Why:** Planner, recovery engine, and MCP tools all need structured access to world state. Currently they can only call `getState()` and dig through raw data.
**Effort:** 2 hours
**Tests to add:** 1 test per method, verify correct return values.

---

#### 3a.7 — Implement postcondition verification
**File:** `src/state/world-model.ts`
**What:** Add:
```typescript
setExpectedPostcondition(assertion: StateAssertion): void
verifyPostcondition(): { matched: boolean; actual: string | null; confidence: number }
```
Currently `assertState()` exists (line 404-420) but only handles `control_exists`, `value_equals`, `window_focused`, `dialog_absent`. The `setExpectedPostcondition` / `verifyPostcondition` pattern is missing — the plan says tools should set an expectation BEFORE executing, then verify AFTER.
**Why:** This is THE critical mechanism for autonomy — "did my action work?"
**Effort:** 1.5 hours
**Tests to add:** Set postcondition, update state, verify match. Set postcondition, don't update, verify mismatch.

---

#### 3a.8 — Implement state transition tracking
**File:** `src/state/world-model.ts`
**What:** Add:
```typescript
private recentTransitions: StateTransition[] = []  // max 50

// On every state change (ingestAXTree, ingestCDPSnapshot, ingestOCR, ingestUIEvents):
// Compare before/after, push transitions to buffer

diff(previous: WorldState): StateTransition[]
```
Every `ingest*()` method should snapshot before, diff after, and push transitions.
**Why:** The learning engine needs transition patterns to learn workflows. The planner needs transitions to detect "we're stuck in a loop."
**Effort:** 2 hours
**Tests to add:** 5 actions -> check 5 transitions with correct trigger/field/oldValue/newValue.

---

#### 3a.9 — Implement domain schema loading from references
**File:** `src/state/world-model.ts`
**What:** Add:
```typescript
loadDomainSchema(bundleId: string): void
updateDomainState(windowId: number, partial: Partial<AppDomainState>): void
```
`loadDomainSchema` should read `references/{platform}.json`, find `domainSchema` key, and use it to validate domain state updates.
**Why:** Without this, domain state for Premiere/DaVinci/Canva is hardcoded types only — no runtime validation, no dynamic loading.
**Effort:** 2 hours
**Tests to add:** Load DaVinci reference, verify schema fields match.

---

#### 3a.10 — Implement global confidence decay timer
**File:** `src/state/world-model.ts`
**What:** Add a `startDecayTimer(intervalMs: number)` method that periodically decays all tracked fields. Currently decay only happens on read (getter methods). The plan says there should be a scheduled decay so stale data is proactively degraded.
**Effort:** 1 hour
**Tests to add:** Set state, advance timer, verify confidence < 1.0 without any reads.

---

#### 3a.11 — Wire world model into tool POST-CALLs (CRITICAL)
**File:** `mcp-desktop.ts` — intelligence wrapper POST-CALL section
**What:** After these tools execute successfully, feed results into world model:
- `ui_tree` -> `worldModel.ingestAXTree(windowId, tree, ctx)`
- `ui_find` -> `worldModel.ingestAXTree()` with results
- `browser_navigate` / `browser_open` -> `worldModel.ingestCDPSnapshot()`
- `browser_dom` -> `worldModel.ingestCDPSnapshot()`
- `ocr` -> `worldModel.ingestOCRRegions()`
- `screenshot` -> update `lastScreenshotHash` on the window
**Why:** Currently the world model is initialized but barely fed. Only `focus` and `launch` update it (lines 481, 581). The world model is PASSIVE — this makes it ACTIVE.
**Effort:** 3 hours (most important task in Phase 3a)
**Tests to add:** Integration test — call `ui_tree`, verify world model has controls populated.

---

### Phase 3a total: ~16 hours (~2-3 days)

---

## Phase 3b: Continuous Perception — 40-70% done, needs ~2 days

### Current state
- AXSource, CDPSource, VisionSource all have real implementations
- PerceptionCoordinator runs FAST (100ms) + MEDIUM (500ms) + SLOW (2000ms) loops
- World model integration works — all 4 ingest methods are called
- 35 tests pass
- Vision is **hardcoded disabled** (`manager.ts:80`)
- 2 native bridge methods missing

### Remaining tasks

#### 3b.1 — Implement `cg.captureWindowBuffer` in Swift bridge (BLOCKER)
**File:** `native/macos-bridge/Sources/CoreGraphicsBridge.swift`
**What:** Add new method:
```swift
// cg.captureWindowBuffer(windowId) -> { base64: String, width: Int, height: Int }
// Returns in-memory PNG as base64 instead of writing to temp file
```
Currently only `cg.captureWindow` exists (writes to disk). The TypeScript VisionSource (`src/perception/vision-source.ts:55-72`) already calls `cg.captureWindowBuffer` but falls back to file-based when it fails.
**Why:** Without this, every screenshot writes to disk (~400ms). In-memory is ~200ms and avoids disk I/O. This is the foundation for fast visual diffing.
**Effort:** 3-4 hours (Swift/CoreGraphics work)
**Tests to add:** Bridge integration test — capture window, verify base64 PNG returned.

---

#### 3b.2 — Implement `vision.ocrRegion` in Swift bridge (BLOCKER)
**File:** `native/macos-bridge/Sources/VisionBridge.swift` (or equivalent)
**What:** Add new method:
```swift
// vision.ocrRegion(windowId, region: { x, y, width, height }) -> { text: String, regions: [{ text, bounds }] }
// OCR only the specified region instead of full screen
```
The TypeScript VisionSource (`src/perception/vision-source.ts:117-135`) already calls this but falls back to full `vision.ocr`.
**Why:** ROI OCR is ~100ms vs full screen ~600ms. This is "the single most important change for canvas-heavy apps" per the plan.
**Effort:** 2-3 hours (Swift/Vision framework work)
**Tests to add:** OCR a known region, verify text returned.

---

#### 3b.3 — Enable vision perception
**File:** `src/perception/manager.ts:80`
**What:** Change:
```typescript
// FROM:
{ enableVision: false, ...this.config }
// TO:
{ enableVision: true, ...this.config }
```
**Prerequisite:** Tasks 3b.1 and 3b.2 must be done first.
**Why:** The entire SLOW loop (screenshot diff + ROI OCR) is implemented but disabled. One line change enables it.
**Effort:** 5 minutes (after prerequisites)
**Tests to add:** Start coordinator with vision enabled, verify SLOW loop fires, verify diff detection works.

---

#### 3b.4 — Add Windows bridge equivalents (if Windows support needed)
**File:** `native/windows-bridge/` (C# .NET)
**What:** Implement the same two methods for Windows:
- `cg.captureWindowBuffer` equivalent using Win32 API
- `vision.ocrRegion` equivalent using Windows OCR
**Effort:** 4-6 hours (C#/.NET work)
**Priority:** LOW — only needed if shipping Windows support now.

---

#### 3b.5 — Add perception freshness to intelligence wrapper PRE-CALL
**File:** `mcp-desktop.ts` — intelligence wrapper PRE-CALL section
**What:** Currently `perceptionManager.getFreshnessSummary()` is included in hints (line 312-313). Add more detail:
- Include which sources are stale (e.g. "AX: 50ms ago, CDP: 200ms ago, Vision: DISABLED")
- Warn if world model is >5s stale for any source
**Effort:** 1 hour

---

#### 3b.6 — Implement daemon command file for targeted ROI OCR
**File:** New file or extend `scripts/observer-daemon.ts`
**What:** Per the plan, the coordinator should be able to REQUEST specific ROI OCR from the daemon by writing a command file. Currently the daemon runs independently.
**Why:** Allows the MCP server to say "OCR just this region" without blocking its own event loop.
**Effort:** 2-3 hours
**Priority:** MEDIUM — current architecture works, this is optimization.

---

### Phase 3b total: ~10-14 hours (~1.5-2 days)

---

## Phase 4: Planner + Recovery — ~87% done, needs ~1-2 days

### Current state
- Goal creation, deterministic planning (playbook/strategy/flow), and execution all work
- 12 blocker detectors, 13 recovery strategies with real MCP tool calls
- PlanExecutor runs step-by-step with postcondition verification
- Full MCP integration (6 tools: plan_goal, plan_execute, plan_step, plan_step_resolve, plan_status, plan_list)
- 23 tests pass across 4 test suites

### Remaining tasks

#### 4.1 — Add step-level timeout enforcement
**File:** `src/planner/executor.ts:374-419`
**What:** Wrap `this.executeTool(tool, params)` with `Promise.race`:
```typescript
const result = await Promise.race([
  this.executeTool(step.tool, step.params),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Step timeout")), step.timeout ?? this.config.stepTimeoutMs)
  ),
]);
```
Currently the `timeout` field exists on PlanStep but is never enforced. If a tool hangs, the step never completes.
**Why:** Prevents infinite hangs during autonomous execution.
**Effort:** 1 hour
**Tests to add:** Mock a tool that never resolves, verify step fails after timeout.

---

#### 4.2 — Improve recovery verification for optimistic blocker types
**File:** `src/recovery/engine.ts:257-285` (`verifyRecovery`)
**What:** Currently 6 of 12 blocker types return `true` without checking:
- `element_gone` -> should re-scan AX tree and check element exists
- `selector_drift` -> should verify the control is now findable
- `unknown_state` -> should check stale controls count decreased
- `loading_stuck` -> should verify screenshot changed
- `network_error` -> could retry the original request
- `rate_limited` -> could check if rate limit header expired

At minimum, do a world model re-read for `element_gone`, `selector_drift`, `unknown_state`.
**Why:** Optimistic verification means recovery "succeeds" but the problem persists, causing the plan to fail again.
**Effort:** 2-3 hours
**Tests to add:** Recovery strategy runs but doesn't fix the problem -> verify `recovered: false`.

---

#### 4.3 — Add multi-subgoal decomposition
**File:** `src/planner/planner.ts:65-85`
**What:** Currently every goal gets exactly 1 subgoal (the goal description itself). Add logic to split complex goals:
- If goal description contains "and" or "then" or numbered steps -> split into multiple subgoals
- Or: add an LLM-based decomposition option for complex goals
**Why:** "Export video as H.264, upload to YouTube, and verify captions" should be 3 subgoals, not 1.
**Effort:** 3-4 hours (more if LLM decomposition)
**Priority:** MEDIUM — single-subgoal works for most playbook-driven workflows.
**Tests to add:** Goal with "and" -> verify 2+ subgoals created.

---

#### 4.4 — Wire executor to update world model after step execution
**File:** `src/planner/executor.ts:374-419`
**What:** After `executeTool()` returns, call:
```typescript
// If the tool was ui_tree, browser_dom, etc. — the result contains state data
// Feed it into world model to keep it fresh between perception cycles
```
Currently the executor relies entirely on the async perception loop for world model freshness. If a step executes in <100ms and the postcondition check runs before the next perception cycle, it may see stale data.
**Why:** Reduces false-negative postcondition failures for fast tool sequences.
**Effort:** 2 hours
**Priority:** MEDIUM — perception loop mostly handles this.

---

#### 4.5 — Add strategy deduplication cooldown
**File:** `src/recovery/engine.ts`
**What:** Currently `usedStrategyIds` prevents re-use within a single recovery attempt. But across multiple attempts for the same plan, the same failed strategy can be tried again. Add a cooldown:
```typescript
// Don't retry a strategy that failed in the last 30 seconds for the same blocker type
```
**Effort:** 1 hour
**Priority:** LOW

---

### Phase 4 total: ~8-12 hours (~1-2 days)

---

## Phase 5: Learning Engine — 35-40% done, needs ~1.5-2 days

### Current state
- All 4 policies implemented and compute correct results (locator, recovery, timing, sensor)
- Persistence works (JSONL files in `~/.screenhand/learning/`)
- Recovery policy IS used by RecoveryEngine (the ONE working feedback loop)
- Other 3 policies compute recommendations that nothing reads
- 18 tests pass

### Remaining tasks

#### 5.1 — Wire locator recommendations into Planner (CRITICAL)
**File:** `src/planner/planner.ts` and `src/planner/deterministic.ts`
**What:** When generating plan steps, consult `learningEngine.recommendLocator()`:
```typescript
// In deterministic.ts, when converting a playbook step to PlanStep:
const learnedLocator = learningEngine?.recommendLocator(bundleId, action);
if (learnedLocator && learnedLocator.confidence > 0.7) {
  step.params.selector = learnedLocator.locator;
  step.params.method = learnedLocator.method;
}
```
Currently `recommendLocator()` is only used to generate hint text in `mcp-desktop.ts:319`.
**Why:** This is THE core promise of learning — "use the selector that works, not the one in the reference."
**Effort:** 2 hours
**Tests to add:** After 8 successes with `#submit-btn`, verify next plan uses `#submit-btn` instead of reference selector.

---

#### 5.2 — Wire adaptive budgets into tool execution (CRITICAL)
**Files:** `src/planner/executor.ts`, `mcp-desktop.ts`
**What:** Pass learned timing budgets to tool calls:
```typescript
// In PlanExecutor.executeStepInternal():
const budget = this.learningEngine?.getAdaptiveBudget(bundleId);
const result = await this.executeTool(step.tool, {
  ...step.params,
  _budget: budget,  // or pass separately
});
```
Currently `getAdaptiveBudget()` is called in `mcp-desktop.ts:3342,3404,3451` but ONLY for postcondition wait time. The actual tool locate/act/verify timeouts remain hardcoded at `800ms/200ms/2000ms` (from `src/config.ts`).
**Why:** If the learning engine knows a tool takes 50ms on average, waiting 800ms for locate is wasteful. If it knows a tool takes 1500ms, 800ms isn't enough.
**Effort:** 3 hours (need to thread budget through ToolExecutor -> RuntimeService -> Executor)
**Tests to add:** Record timing data showing tool completes in 100ms, verify adapted budget is ~120ms not 800ms.

---

#### 5.3 — Wire sensor ranking into perception coordinator (CRITICAL)
**File:** `src/perception/coordinator.ts`
**What:** In the MEDIUM and SLOW cycles, use `learningEngine.rankSensors()` to determine query order:
```typescript
// In mediumCycle():
const ranked = this.learningEngine?.rankSensors(this.context?.bundleId ?? "");
if (ranked) {
  for (const { sourceType } of ranked) {
    if (sourceType === "ax") await this.pollAXTree();
    else if (sourceType === "cdp") await this.pollCDP();
    else if (sourceType === "vision") await this.pollVision();
  }
} else {
  // Default: AX -> CDP -> Vision
}
```
Currently the coordinator always polls AX -> CDP -> Vision in that fixed order (lines 227-249), regardless of which source works best for the current app.
**Why:** For Canva, vision (OCR) might be the most useful source. For a web app, CDP is best. Learning should adapt.
**Effort:** 2 hours
**Tests to add:** After 10 Figma OCR successes + 10 Figma AX failures, verify OCR polled first.

---

#### 5.4 — Add data pruning / entry limits
**File:** `src/learning/engine.ts` (save methods)
**What:** Enforce `maxEntriesPerFile: 5000` from config. On save, if entries exceed limit, drop oldest by `lastUsed` timestamp.
Currently mentioned in types.ts:93 but never enforced — files can grow unbounded.
**Effort:** 1 hour
**Priority:** MEDIUM — won't matter until after weeks of usage.
**Tests to add:** Insert 6000 entries, save, reload, verify only 5000 remain.

---

#### 5.5 — Add integration tests for all 4 learning loops
**File:** New test file `tests/learning-integration.test.ts`
**What:** End-to-end tests proving learning actually changes behavior:
1. **Locator loop:** Record 10 successes with locator A, verify planner prefers A
2. **Recovery loop:** Record 5 successes with strategy X for blocker Y, verify X tried first (this one already works, just needs a test)
3. **Timing loop:** Record 20 samples at 100ms, verify adaptive budget < 200ms
4. **Sensor loop:** Record 10 OCR successes for Figma, verify OCR polled before AX
**Effort:** 3-4 hours
**Priority:** HIGH — without these, you can't prove learning works.

---

#### 5.6 — Wire LocatorCache to use learning data
**File:** `src/runtime/locator-cache.ts`
**What:** Currently the LocatorCache uses reference selectors only. Add fallback to learning engine:
```typescript
// If cache miss, check learning engine for a proven locator
const learned = learningEngine.recommendLocator(bundleId, action);
if (learned) return learned;
```
**Effort:** 1 hour
**Priority:** LOW — planner integration (5.1) is more impactful.

---

### Phase 5 total: ~12-16 hours (~1.5-2 days)

---

## Summary Table

| Task ID | Description | File(s) | Effort | Priority |
|---------|------------|---------|--------|----------|
| **3a.1** | Add missing WorldState fields | types.ts | 1h | HIGH |
| **3a.2** | Add missing WindowState fields | types.ts | 1.5h | HIGH |
| **3a.3** | Add missing DialogState fields | types.ts | 30m | HIGH |
| **3a.4** | Add VideoEditorState fields | types.ts | 30m | MEDIUM |
| **3a.5** | Add ImageEditor/DesignTool fields | types.ts | 30m | MEDIUM |
| **3a.6** | Implement read methods | world-model.ts | 2h | HIGH |
| **3a.7** | Implement postcondition verification | world-model.ts | 1.5h | CRITICAL |
| **3a.8** | Implement state transition tracking | world-model.ts | 2h | HIGH |
| **3a.9** | Implement domain schema loading | world-model.ts | 2h | MEDIUM |
| **3a.10** | Global confidence decay timer | world-model.ts | 1h | LOW |
| **3a.11** | Wire world model into tool POST-CALLs | mcp-desktop.ts | 3h | CRITICAL |
| **3b.1** | Swift: `captureWindowBuffer` | CoreGraphicsBridge.swift | 3-4h | CRITICAL |
| **3b.2** | Swift: `vision.ocrRegion` | VisionBridge.swift | 2-3h | CRITICAL |
| **3b.3** | Enable vision (flip flag) | manager.ts:80 | 5m | CRITICAL |
| **3b.4** | Windows bridge equivalents | windows-bridge/ | 4-6h | LOW |
| **3b.5** | Perception freshness detail | mcp-desktop.ts | 1h | LOW |
| **3b.6** | Daemon command file for ROI OCR | observer-daemon.ts | 2-3h | MEDIUM |
| **4.1** | Step timeout enforcement | executor.ts | 1h | HIGH |
| **4.2** | Recovery verification (non-optimistic) | engine.ts | 2-3h | HIGH |
| **4.3** | Multi-subgoal decomposition | planner.ts | 3-4h | MEDIUM |
| **4.4** | Executor -> world model updates | executor.ts | 2h | MEDIUM |
| **4.5** | Strategy cooldown | engine.ts | 1h | LOW |
| **5.1** | Wire locator recs -> Planner | planner.ts, deterministic.ts | 2h | CRITICAL |
| **5.2** | Wire adaptive budgets -> execution | executor.ts, mcp-desktop.ts | 3h | CRITICAL |
| **5.3** | Wire sensor ranking -> perception | coordinator.ts | 2h | CRITICAL |
| **5.4** | Data pruning / entry limits | engine.ts | 1h | MEDIUM |
| **5.5** | Integration tests for learning loops | New test file | 3-4h | HIGH |
| **5.6** | LocatorCache uses learning data | locator-cache.ts | 1h | LOW |

---

## Recommended execution order

### Sprint 1 (3 days) — Make existing code actually work
1. **3a.11** — Wire world model into tool POST-CALLs (3h) — unlocks everything
2. **3a.7** — Postcondition verification (1.5h) — executor needs this
3. **3a.1 + 3a.2 + 3a.3** — Add missing type fields (3h) — needed by everything below
4. **5.1** — Wire locator learning -> Planner (2h) — first real learning loop
5. **5.2** — Wire adaptive budgets -> execution (3h) — second learning loop
6. **5.3** — Wire sensor ranking -> perception (2h) — third learning loop
7. **4.1** — Step timeout enforcement (1h) — safety net

### Sprint 2 (2 days) — Vision perception + recovery
8. **3b.1** — Swift: `captureWindowBuffer` (3-4h) — native work
9. **3b.2** — Swift: `vision.ocrRegion` (2-3h) — native work
10. **3b.3** — Enable vision flag (5 min) — flip the switch
11. **4.2** — Recovery verification improvements (2-3h)
12. **3a.6** — WorldModel read methods (2h)

### Sprint 3 (2 days) — Polish + testing
13. **3a.8** — State transition tracking (2h)
14. **3a.9** — Domain schema loading (2h)
15. **3a.4 + 3a.5** — Domain state fields (1h)
16. **4.3** — Multi-subgoal decomposition (3-4h)
17. **5.5** — Integration tests for learning loops (3-4h)
18. **4.4** — Executor -> world model updates (2h)

### Deferred (do if time allows)
- **3b.4** — Windows bridge (4-6h)
- **3b.6** — Daemon command file (2-3h)
- **3a.10** — Global decay timer (1h)
- **4.5** — Strategy cooldown (1h)
- **5.4** — Data pruning (1h)
- **5.6** — LocatorCache learning (1h)
- **3b.5** — Perception freshness detail (1h)
