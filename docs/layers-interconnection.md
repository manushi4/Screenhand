# ScreenHand — 7 Layer Interconnection Map

> **Status**: 56 working, 2 partial, 0 missing — Phases 1-8 complete.
> **Last validated**: 2026-03-23 (Phase 8: website feature discovery — 19 issues found and fixed by 3-agent team)
> **Bugs fixed**: 40 total. 1405 tests pass (0 failures).

---

## The Problem

Every layer is built and tested individually. But they don't talk to each other. Data flows in one direction (up from tools, into storage) and is never read back to improve execution. The system records everything and learns nothing.

**Layer 7 (App Mastery Map) is the worst offender**: 8 rich data features are recorded on every tool call, but zero other layers read this data. It's a black hole.

---

## Layer-by-Layer Breakdown

### Layer 1: Control (src/runtime/, native/, mcp-desktop.ts tools)

The foundation. 111 MCP tools, 4 adapters, native bridge, fallback chains.

```
Components:
  ├── AccessibilityAdapter      (~50ms — macOS AX API)
  ├── CdpChromeAdapter          (~10ms — Chrome/Electron CDP)
  ├── AppleScriptAdapter        (scriptable macOS apps)
  ├── VisionAdapter             (~600ms — OCR fallback)
  ├── CompositeAdapter          (routes per app type)
  ├── Native Bridge             (Swift macOS / C# Windows, JSON-RPC stdio)
  ├── Executor                  (locate → act → verify pipeline)
  ├── ExecutionContract         (fallback chain + retry policy)
  └── 111 MCP tools             (57 server.tool + 54 originalTool)
```

#### Layer 1 Outbound (data flowing OUT of control)

| Connection | Target | Status | Validated | Evidence |
|-----------|--------|--------|-----------|----------|
| Tool result → POST-CALL → AppMap | L7 | ✅ WORKS | YES | `mcp-desktop.ts:635-1027` — 8 distinct `appMap.record*` calls |
| Tool result → POST-CALL → Learning | L5 | ✅ WORKS | YES | `mcp-desktop.ts:655` (success), `:1359` (failure) |
| Tool result → POST-CALL → Memory | L2 | ✅ WORKS | YES | `mcp-desktop.ts:598` (success), `:1352` (failure) |
| Raw AX/CDP/OCR data → Perception | L3 | ✅ WORKS | YES | `coordinator.ts:461-530` medium cycle feeds `fusionPipeline.flush(worldModel)` |
| Tool failure → Memory errors | L2 | ✅ WORKS | YES | `mcp-desktop.ts:1437` |

**Gaps in outbound data:**
```
What's recorded:     tool, bundleId, durationMs, success (boolean)
What's NOT recorded: locator method used (AX/CDP/OCR), retry count,
                     fallback path taken, which adapter succeeded,
                     element coordinates found, confidence score
```

#### Layer 1 Inbound (data flowing INTO control)

| Connection | Source | Status | Validated | Evidence |
|-----------|--------|--------|-----------|----------|
| Playbook steps → tool params | L4 | ✅ WORKS | YES | `executor.ts:575` calls `toolRegistry.execute()` |
| Recovery → dismiss/refocus | L4 | ✅ WORKS | YES | `recovery/engine.ts:129` strategies call `executeTool()` |
| Reference hints → display text | L2 | ⚠️ HINTS ONLY | YES | `context-tracker.ts:260-348` — strings appended to output, never modify tool params |
| AppMap positions → locate | L7 | ✅ WORKS | YES | `mcp-desktop.ts:resolveMapPosition()` → click/locate_with_fallback try known coords first (Phase 1 #4) |
| AppMap timing → timeout | L7 | ✅ WORKS | YES | `mcp-desktop.ts:getAdaptedRetryPolicy()` reads `appMap.getTimingProfile()` for per-tool timing (Phase 1 #3) |
| Learning → fallback order | L5 | ✅ WORKS | YES | `execution-contract.ts:136` accepts `sensorRanking`, `getSensorRanking()` passes to all `planExecution` calls (Phase 1 #1) |
| Learning → retry budget | L5 | ✅ WORKS | YES | `getAdaptedRetryPolicy()` adjusts `delayBetweenRetriesMs` based on learning data (Phase 1 #3) |
| Learning → locator choice | L5 | ✅ WORKS | YES | `deterministic.ts:342` calls `recommendLocator()`, mutates `params.target` at score ≥0.7 |
| WorldModel → pre-check | L3 | ✅ WORKS | YES | `mcp-desktop.ts:preExecutionCheck()` — auto-focus, dialog/offscreen/stale warnings in all 6 *_with_fallback tools (Phase 1 #2) |
| Reference selectors → inject | L2 | ✅ WORKS | YES | `contextTracker.getSelector()` → CDP `querySelector()` in all 6 fallback tools (Phase 1 #5 + Bug #7 fix) |
| Window buffer → vision-only fallback | L3/L5 | ✅ WORKS | YES | `execution-contract.ts` window_buffer method, `isVisionOnlyApp()` detection, click/locate/read_with_fallback GPU capture (Phase 7) |

#### Layer 1 Internal — Fallback Chains

```
LEARNING-GUIDED ORDER (Phase 1 #1):
  planExecution("click", infra(), getSensorRanking())
  → getSensorRanking() calls learningEngine.rankSensors(bundleId)
  → returns e.g. [cdp, ax, ocr] for web-heavy apps, [ax, cdp] for native apps
  → execution-contract.ts uses this ordering

FALLBACK CHAIN (Phase 7):
  ax → cdp → ocr → window_buffer → coordinates
  window_buffer: captures GPU buffer via cg.captureWindow(windowId)
    → works even when window is hidden/behind other apps
    → OCR finds text, translates window-relative to screen-absolute coords
    → activated when isVisionOnlyApp() = true (AX score < 0.15, vision > 0.3)

Retry policy is adaptive (Phase 1 #3):
  getAdaptedRetryPolicy(toolName, bundleId) reads appMap timing profiles
  → adjusts delayBetweenRetriesMs per app/tool
  → remaining: maxRetriesPerMethod still fixed at 2
```

---

### Layer 2: Tool Knowledge (src/context-tracker.ts, references/, playbooks/)

Curated platform knowledge — selectors, flows, errors, playbooks.

```
Components:
  ├── Context Tracker        (auto-load references on app/domain switch)
  ├── References             (38 JSON files — selectors, flows, errors)
  ├── Playbooks              (28 JSON files — recorded workflows)
  ├── Intelligence Wrapper   (PRE/POST-CALL pipeline in mcp-desktop.ts)
  └── Memory Service         (JSONL — actions, errors, strategies)
```

| Connection | Direction | Status | Validated | Evidence |
|-----------|-----------|--------|-----------|----------|
| References → contextTracker.getHints() | → L1 | ✅ WORKS | YES | Selectors injected via `getSelector()` into CDP branches of all 6 fallback tools |
| References → error warnings | → L1 | ✅ WORKS | YES | `mcp-desktop.ts:527` `quickErrorCheck()` |
| Playbooks → DeterministicPlanner | → L4 | ✅ WORKS | YES | `planner.ts:282-303` `findPlaybookPlan()` |
| Memory → strategy hints | → L5/wrapper | ✅ WORKS | YES | `mcp-desktop.ts:1302` `quickStrategyHint()` |
| ReferenceMerger ← L6 ingestion | ← L6 | ✅ WORKS | YES | `mcp-desktop.ts:6109,6148-6149` |
| Context tracker ← selector learning | L2 internal | ✅ WORKS | YES | `context-tracker.ts:recordOutcome` promotes after 2+ successes |
| AppMap hint ← L7 | ← L7 | ⚠️ DISPLAY ONLY | YES | `context-tracker.ts:299-348` — text string only, no numeric data consumed |
| References → perception config | → L3 | ✅ WORKS | YES | Wire F10: `contextTracker.getPerceptionConfig()` → coordinator `adjustIntervals()` on context switch |
| Reference selectors → tool params | → L1 | ✅ WORKS | YES | `contextTracker.getSelector()` → CDP `querySelector()` in all 6 fallback tools |
| Reference errors → pre-fail | → L1 | ✅ WORKS | YES | Wire F11: blocks execution when tool has 5+ failures with known resolution |

---

### Layer 3: Awareness (src/state/, src/perception/)

Continuous screen understanding — world model, perception loop, entity tracking.

```
Components:
  ├── WorldModel              (app, windows, controls, dialogs, focus, scroll)
  ├── EntityTracker           (persistent cross-frame identity)
  ├── FusionPipeline          (dedup by source+windowId, confidence scoring)
  ├── PerceptionCoordinator   (3-rate multi-source loop)
  │     ├── FAST   100ms      (AX events, CDP mutations)
  │     ├── MEDIUM 300ms      (AX tree poll, DOM snapshot)
  │     └── SLOW   1000ms     (screenshot diff → OCR if changed)
  ├── AXSource                (accessibility events + tree polling)
  ├── CDPSource               (DOM mutations + snapshots)
  ├── VisionSource            (screenshot capture + OCR)
  └── FrameDiffer             (hash-based change detection)
```

| Connection | Direction | Status | Validated | Evidence |
|-----------|-----------|--------|-----------|----------|
| WorldModel → planner | → L4 | ✅ WORKS | YES | `planner.ts:279,344,408` reads `worldModel.getState()` |
| WorldModel → recovery | → L4 | ✅ WORKS | YES | `recovery/engine.ts:129,310-342` reads worldModel |
| Learning → FusionPipeline confidence | ← L5 | ✅ WORKS | YES | `fusion.ts:114-128` calls `learningEngine.rankSensors()` |
| Learning → rankSensors reorder | ← L5 | ✅ WORKS | YES | `coordinator.ts:521-545` reorders AX/CDP; `:726-730` skips low-score vision |
| Raw data → perception sources | ← L1 | ✅ WORKS | YES | AX/CDP/Vision feed fusionPipeline → worldModel |
| Perception → appMap timestamp | → L7 | ✅ WORKS | YES | `coordinator.ts:783` — `lastValidated` touched on OCR confirmation |
| Perception → auto-add elements | → L7 | ✅ WORKS | YES | `coordinator.ts:updateAppMapFromPerception()` — new controls → `appMap.addElement()` every 5th medium cycle (Phase 3 #9) |
| Perception → auto-state changes | → L7 | ✅ WORKS | YES | `coordinator.ts:updateAppMapFromPerception()` — dialog open/close → `appMap.recordStateChange()` (Phase 3 #9) |
| Perception → auto-nav edges | → L7 | ✅ WORKS | YES | `coordinator.ts:updateAppMapFromPerception()` — window title change → `appMap.recordPageTransition()` (Phase 3 #9) |
| Perception → auto-visibility | → L7 | ✅ WORKS | YES | `coordinator.ts:recordVisibilityFromOCR()` — OCR text → `appMap.recordElementVisibility()` every 3rd slow cycle (Phase 3 #9) |
| AppMap zones → ROI OCR | ← L7 | ✅ WORKS | YES | `coordinator.ts:getZoneROIs()` → zone-targeted OCR replaces full-screen fallback (Phase 3 #10) |
| AppMap known elements → skip verify | ← L7 | ✅ WORKS | YES | `executor.ts:shouldSkipVerify()` — skips verify for elements with 3+ successes within 5min via `appMap.isElementVerified()` (Phase 5 #15) |
| AppMap timing → poll interval | ← L7 | ✅ WORKS | YES | `coordinator.ts:adjustIntervals()` — adapts perception intervals on context switch based on AppMap timing profiles (Phase 5 #16) |
| WorldModel → pre-execution check | → L1 | ✅ WORKS | YES | `mcp-desktop.ts:preExecutionCheck()` — auto-focus, dialog/offscreen/stale warnings in all 6 *_with_fallback tools |
| Vision-only → never skip slow cycle | ← L5 | ✅ WORKS | YES | `coordinator.ts:slowCycle()` — `isVisionOnlyApp()` exempts from vision skip, records window_buffer sensor outcome (Phase 7) |

---

### Layer 4: Autonomy (src/planner/, src/recovery/)

Goal planning, deterministic execution, recovery, self-healing.

```
Components:
  ├── Planner                 (goal → subgoals → action plan)
  ├── PlanExecutor            (run steps, verify postconditions)
  ├── DeterministicPlanner    (playbook at full speed, no LLM)
  ├── ToolRegistry            (map plan steps → MCP tool calls)
  ├── GoalStore               (persistent goal tracking)
  ├── RecoveryEngine          (detect blockers, select strategy)
  ├── Detectors               (dialog, focus loss, crash detection)
  └── Strategies              (dismiss dialog, refocus, restart app)
```

| Connection | Direction | Status | Validated | Evidence |
|-----------|-----------|--------|-----------|----------|
| WorldModel → planner | ← L3 | ✅ WORKS | YES | `planner.ts:279,344,408` |
| WorldModel → recovery | ← L3 | ✅ WORKS | YES | `recovery/engine.ts:129,310-342` |
| Playbooks → DeterministicPlanner | ← L2 | ✅ WORKS | YES | `deterministic.ts:289` |
| Learning → recommendLocator | ← L5 | ✅ WORKS | YES | `deterministic.ts:342` calls `recommendLocator()` — actually mutates `params.target` at score ≥0.7 |
| Learning → adaptive budget | ← L5 | ⚠️ PARTIAL | YES | Sets `postconditionWaitMs` + `defaultStepTimeout` (`:5209,5275,5323`), injects `_budget` into params (`executor.ts:569`), but NO tool handler reads `_budget` for locate/act/verify. Only `delayBetweenRetriesMs` is adapted. |
| Recovery → strategy ranking | ← L5 | ✅ WORKS | YES | `recovery/engine.ts:186-195` calls `rankRecoveryStrategies()` |
| Planner → tool invocation | → L1 | ✅ WORKS | YES | `executor.ts:575` |
| AppMap → BFS pathfinding | ← L7 | ✅ WORKS | YES | `planner.ts:findNavigationPlan()` → `appMap.findPath()` BFS → PlanSteps (Phase 2 #6) |
| AppMap → contract preconditions | ← L7 | ✅ WORKS | YES | `executor.ts` checks `appMap.getContract()` preconditions before ACT (Phase 2 #7) |
| AppMap → verified edges | ← L7 | ✅ WORKS | YES | `planner.ts:computeNavConfidence()` uses edge.verified + success rates (Phase 2 #6) |
| AppMap → zone layout | ← L7 | ✅ WORKS | YES | Wire F3: `enrichStepsWithStateContext()` checks zone `relativePosition` → scroll prepend |
| AppMap → state machine | ← L7 | ✅ WORKS | YES | `planner.ts:enrichStepsWithStateContext()` checks dimensions + transitions, prepends fix steps (Phase 2 #8) |
| Recovery → contracts (expected outcomes) | ← L7 | ✅ WORKS | YES | `executor.ts:inferPostcondition()` uses reliable contract outcomes as assertions (Phase 2 #7) |
| Recovery → undo paths | ← L7 | ✅ WORKS | YES | `recovery/engine.ts:buildUndoStrategy()` creates strategy from contract undoPath (Phase 2 #7) |
| Learning → recommendTiming | ← L5 | ✅ WORKS | YES | Wire F1: executor blends `_budget` (locateMs+actMs+verifyMs) into step timeout |
| Learning → recommendRecovery | ← L5 | ✅ WORKS | YES | Wire F2: `replan()` queries `rankRecoveryStrategies()`, prepends recovery step |
| Planner → inject appMap params | → L1 | ✅ WORKS | YES | Wire F4: executor injects `_mapHintX`/`_mapHintY` from verified AppMap elements |

---

### Layer 5: Learning (src/learning/engine.ts)

6 policies that track what works per app and action.

```
Components:
  ├── LearningEngine          (central coordinator)
  ├── LocatorPolicy           (which selectors are stable per app)
  ├── SensorPolicy            (which perception source works best)
  ├── RecoveryPolicy          (which recovery strategy works per blocker)
  ├── PatternPolicy           (pre-failure state patterns)
  ├── TimingModel             (adaptive timing per tool/app)
  └── TopologyPolicy          (nav edge reliability — Bayesian)
```

| Connection | Direction | Status | Validated | Evidence |
|-----------|-----------|--------|-----------|----------|
| POST-CALL → recordToolTiming | ← L1 | ✅ WORKS | YES | `mcp-desktop.ts:655,1359` |
| POST-CALL → recordOutcome | ← L1 | ✅ WORKS | YES | `mcp-desktop.ts:658-685` |
| Recovery → recordRecoveryOutcome | ← L4 | ✅ WORKS | YES | `recovery/engine.ts:280` |
| FusionPipeline → confidence | → L3 | ✅ WORKS | YES | `fusion.ts:114-128` |
| recommendLocator → planner | → L4 | ✅ WORKS | YES | `deterministic.ts:342` mutates `params.target` |
| getAdaptiveBudget → planner | → L4 | ⚠️ PARTIAL | YES | Sets step-level timeouts but `_budget` values never consumed by tool handlers |
| rankRecoveryStrategies → recovery | → L4 | ✅ WORKS | YES | `recovery/engine.ts:187` |
| quickErrorCheck → wrapper | → L2 | ✅ WORKS | YES | `mcp-desktop.ts:527` |
| quickStrategyHint → wrapper | → L2 | ✅ WORKS | YES | `mcp-desktop.ts:1302` |
| rankSensors → perception reorder | → L3 | ✅ WORKS | YES | `coordinator.ts:521-545` reorders; `:726-730` skips low-score vision |
| AppMap timing → bootstrap TimingModel | ← L7 | ✅ WORKS | YES | `engine.ts:seedTimingFromAppMap()` scans AppMap for timing profiles, feeds into `timing-model.ts:seedFromTimingProfiles()` (Phase 5 #14) |
| AppMap contracts → RecoveryPolicy | ← L7 | ✅ WORKS | YES | Wire F5: `seedRecoveryFromContracts()` — undo paths seeded as recovery strategies |
| AppMap ready signals → SensorPolicy | ← L7 | ✅ WORKS | YES | Wire F6: `seedSensorsFromReadySignals()` — signal type → sensor source mapping |
| TopologyPolicy ↔ nav edges | ↔ L7 | ✅ WORKS | YES | AppMap delegates edge scoring to TopologyPolicy via `setTopologyPolicy()`, stamps Bayesian scores on edges (Phase 4 #11) |
| recommendRecovery → planner | → L4 | ✅ WORKS | YES | Wire F2: `replan()` queries ranked strategies, prepends best recovery step |
| rankSensors → fallback chain | → L1 | ✅ WORKS | YES | `execution-contract.ts:136` accepts `sensorRanking` param, `mcp-desktop.ts:getSensorRanking()` passes to all 7 `planExecution` calls |
| isVisionOnlyApp → window_buffer | → L1/L3 | ✅ WORKS | YES | `engine.ts:isVisionOnlyApp()` — AX<0.15 + vision>0.3 → enables window_buffer fallback + slow cycle exemption (Phase 7) |
| PatternPolicy → pre-fail warnings | → L4 | ✅ WORKS | YES | Planner `annotateAndReturn()` queries `queryPatterns()` and stamps `_patternWarning` on steps with score<0.4 & failCount≥3 (Phase 4 #13) |
| AppMap → cold start bootstrap (beyond timing) | ← L7 | ✅ WORKS | YES | Wire F7: `seedLocatorsFromAppMap` + `seedPatternsFromAppMap` + UIArchitecture → SensorPolicy |

---

### Layer 6: Tool Mastery (src/ingestion/, src/community/)

Knowledge ingestion, expert workflows, community sharing.

```
Components:
  ├── MenuScanner             (AX tree scan of entire menu bar)
  ├── DocParser               (docs → features, shortcuts, UI terms)
  ├── TutorialExtractor       (video transcripts → playbook steps)
  ├── FeatureExtractor        (website HTML → real features + value-adds) ← Phase 8
  ├── ReferenceMerger         (merge extracted data → reference JSON)
  ├── CoverageAuditor         (audit reference completeness + feature gaps)
  ├── Publisher               (share playbooks to community)
  ├── Fetcher                 (pull community playbooks)
  └── Validator               (validate shared playbooks)
```

| Connection | Direction | Status | Validated | Evidence |
|-----------|-----------|--------|-----------|----------|
| ReferenceMerger → references | → L2 | ✅ WORKS | YES | `mcp-desktop.ts:6109,6148-6149` |
| Playbooks → DeterministicPlanner | → L4 | ✅ WORKS | YES | Playbook execution |
| MenuScanner → appMap zones | → L7 | ✅ WORKS | YES | `mcp-desktop.ts` scan_menu_bar calls `appMap.bootstrapFromMenuScan()` (Phase 4 #12) |
| DocParser → appMap contracts | → L7 | ✅ WORKS | YES | Wire F8: `ingest_documentation` seeds learning patterns from extracted flows |
| Ingestion → cold start policies | → L5 | ✅ WORKS | YES | Wire F8: `scan_menu_bar` → locators+patterns, `ingest_documentation` → patterns |
| Community → pre-built maps | → L7 | ✅ WORKS | YES | Wire F9: `community_fetch` → `AppMap.importFromPlaybook()` per result |
| Website → feature ladder | → L7 | ✅ WORKS | YES | Phase 8: `discover_features` → `extractFeaturesFromHTML()` → `mergeWebsiteFeatures()` → `ladder-generator.ts` Step 2.5 creates `web_*` ladder entries |
| Website → value-add features | → L7 | ✅ WORKS | YES | Phase 8: `generateValueAddFeatures()` rule-based (no LLM) → `mergeWebsiteFeatures()` → `ladder-generator.ts` Step 2.6 creates `va_*` ladder entries |
| Feature coverage → reference enrichment | → L2 | ✅ WORKS | YES | Phase 8: `ReferenceMerger.mergeWebsiteFeatures()` stores websiteFeatures + valueAddFeatures in reference JSON with id-based dedup |

---

### Layer 7: App Mastery Map (src/state/app-map.ts)

Persistent spatial understanding of every app. **Now fully connected** — data flows to L1 (positions, timing, skip-verify), L3 (zone ROIs, adaptive intervals), L4 (BFS nav, contracts, state machine), L5 (timing bootstrap, topology scoring, feature signals), and receives real feature ladders from L6 website discovery (Phase 8).

```
Components:
  ├── AppMap class              (~2200 lines — load/save/CRUD/BFS/mastery)
  ├── Zones                     (per-page element maps with positions)
  ├── Navigation Graph          (nodes, edges, BFS pathfinding)
  ├── Hierarchy                 (parent/child containment)
  ├── I/O Contracts             (element → action → outcome)
  ├── State Machine             (dimensions, transitions, triggers)
  ├── Visibility Conditions     (per-page element tracking)
  ├── Timing Profiles           (per-element response times)
  ├── Ready Signals             (post-action readiness detection)
  └── Mastery Levels            (beginner → pro → expert → grandmaster)
```

| Connection | Direction | Status | Validated | Evidence |
|-----------|-----------|--------|-----------|----------|
| POST-CALL → all 8 recording features | ← L1 | ✅ WORKS | YES | `mcp-desktop.ts:635-1027` — all 8 appMap.record* |
| Perception → auto-updates map | ← L3 | ✅ WORKS | YES | `coordinator.ts:updateAppMapFromPerception()` — elements, nav edges, state changes, visibility (Phase 3 #9) |
| AppMap hint → contextTracker | → L2 | ⚠️ DISPLAY ONLY | YES | `context-tracker.ts:299-348` — text string |
| Nav graph → planner BFS | → L4 | ✅ WORKS | YES | `planner.ts:findNavigationPlan()` BFS path → PlanSteps (Phase 2 #6) |
| Contracts → planner preconditions | → L4 | ✅ WORKS | YES | `executor.ts` checks contract preconditions before ACT (Phase 2 #7) |
| Contracts → recovery expected outcomes | → L4 | ✅ WORKS | YES | `executor.ts:inferPostcondition()` uses reliable outcomes (Phase 2 #7) |
| Contracts → undo paths | → L4 | ✅ WORKS | YES | `recovery/engine.ts:buildUndoStrategy()` (Phase 2 #7) |
| State machine → planner context | → L4 | ✅ WORKS | YES | `planner.ts:enrichStepsWithStateContext()` + LLM context prompt (Phase 2 #8) |
| Timing → tool timeouts | → L1 | ✅ WORKS | YES | `mcp-desktop.ts:getAdaptedRetryPolicy()` reads `appMap.getTimingProfile()` for per-tool timing |
| Positions → element locate | → L1 | ✅ WORKS | YES | `mcp-desktop.ts:resolveMapPosition()` → click/locate_with_fallback try known coords first |
| Zones → perception ROI | → L3 | ✅ WORKS | YES | `coordinator.ts:getZoneROIs()` → `captureAndDiffOptimized(priorityROIs)` replaces full-screen OCR fallback (Phase 3 #10) |
| Timing → learning bootstrap | → L5 | ✅ WORKS | YES | `engine.ts:seedTimingFromAppMap()` seeds TimingModel from AppMap profiles at init (Phase 5 #14) |
| Nav edges → TopologyPolicy sync | ↔ L5 | ✅ WORKS | YES | `appMap.setTopologyPolicy()` + Bayesian scoring on edges (Phase 4 #11) |
| Pre-built maps ← community | ← L6 | ✅ WORKS | YES | Wire F9: `community_fetch` → `AppMap.importFromPlaybook()` |
| Feature ladder ← website | ← L6 | ✅ WORKS | YES | Phase 8: `extractFeaturesFromHTML()` → `mergeWebsiteFeatures()` → ladder-generator creates `web_*` entries with real features |
| Feature coverage → coverage audit | → L5 | ✅ WORKS | YES | Phase 8: `coverage-auditor.ts` counts `websiteFeaturesKnown`, flags gap if 0 — "run discover_features" |
| Feature discovery → learning signals | ← L5 | ✅ WORKS | YES | Phase 8: `ladder-generator.ts` Step 2.5 generates signals via `extractKeywordsFromName()` for each web feature |

---

## Full Scorecard

```
WORKING CONNECTIONS (34):
  --- Pre-existing (before Phase 1) ---
  ✅ L1 → L7  POST-CALL records all 8 features
  ✅ L1 → L5  recordToolTiming (tool, bundleId, duration, success)
  ✅ L1 → L2  recordEvent to actions.jsonl
  ✅ L1 → L3  AX/CDP/Vision sources feed WorldModel
  ✅ L1 → L2  appendError on failure
  ✅ L2 → L4  playbooks → DeterministicPlanner
  ✅ L2 internal  selector auto-promote after 2+ successes
  ✅ L2 ← L6  ReferenceMerger writes references
  ✅ L3 → L4  WorldModel → planner reads state
  ✅ L3 → L4  WorldModel → recovery detects blockers
  ✅ L5 → L3  FusionPipeline learning-adaptive confidence
  ✅ L5 → L3  rankSensors → perception reorder + vision skip
  ✅ L5 → L4  recommendLocator → DeterministicPlanner (mutates params.target at score ≥0.7)
  ✅ L5 → L4  rankRecoveryStrategies → recovery ordering
  ✅ L4 → L1  planner/recovery → tool invocation

  --- Phase 1: Learning-Guided Execution (#1-5) ---
  ✅ L5 → L1  rankSensors → fallback chain order (#1)
  ✅ L3 → L1  pre-execution worldModel check (#2)
  ✅ L7 → L1  timing profiles → tool timeout adaptation (#3)
  ✅ L5 → L1  learning data → adaptive retry budgets (#3)
  ✅ L7 → L1  element positions → locate shortcut (#4)
  ✅ L2 → L1  reference selectors → injection into all 6 fallback CDP branches (#5)

  --- Phase 2: Map-Guided Planning (#6-8) ---
  ✅ L7 → L4  nav graph BFS for pathfinding (#6)
  ✅ L7 → L4  verified edges for confidence (#6)
  ✅ L7 → L4  contract preconditions for steps (#7)
  ✅ L7 → L4  contracts for expected outcome validation (#7)
  ✅ L7 → L4  contract undo paths for recovery (#7)
  ✅ L7 → L4  state machine for context checks (#8)

  --- Phase 3: Perception ↔ AppMap (#9-10) ---
  ✅ L3 → L7  perception auto-updates map: elements, nav, state, visibility (#9)
  ✅ L7 → L3  zone ROI → targeted OCR (#10)

  --- Phase 4: Cross-Layer Intelligence (#11-13) ---
  ✅ L7 ↔ L5  unified edge scoring via TopologyPolicy Bayesian scores (#11)
  ✅ L6 → L7  MenuScanner → pre-built app map zones on first encounter (#12)
  ✅ L5 → L4  PatternPolicy pre-fail warnings annotated on plan steps (#13)

  --- Phase 5: Closing Gaps (#14-16) ---
  ✅ L7 → L5  timing bootstrap from map profiles (#14)
  ✅ L7 → L3  known elements → skip verify (#15)
  ✅ L7 → L3  timing → adaptive poll intervals (#16)

PARTIAL CONNECTIONS (2):
  ⚠️ L5 → L4  getAdaptiveBudget — sets step-level timeouts but _budget values never consumed by L1 handlers
  ⚠️ L7 → L2  appMap hint in contextTracker — display text only, no numeric data consumed

  --- Phase 6: Future Connections (#F1-F11) — ALL DONE ---
  ✅ L5 → L4  recommendTiming → planner step timeouts (F1)
  ✅ L5 → L4  recommendRecovery → planner replan (F2)
  ✅ L7 → L4  zone layout → planner spatial awareness / scroll prepend (F3)
  ✅ L4 → L1  inject appMap params (_mapHintX/_mapHintY) into tool calls (F4)
  ✅ L7 → L5  contracts → RecoveryPolicy seeding (F5)
  ✅ L7 → L5  ready signals → SensorPolicy seeding (F6)
  ✅ L7 → L5  cold start bootstrap — locator/sensor/pattern (F7)
  ✅ L6 → L5  ingestion → cold start policies (F8)
  ✅ L6 → L7  community → pre-built maps via importFromPlaybook (F9)
  ✅ L2 → L3  references → perception config (F10)
  ✅ L2 → L1  known errors → pre-fail block (F11)

  --- Phase 7: Window Buffer Fallback ---
  ✅ L5 → L1  isVisionOnlyApp() → window_buffer in fallback chain
  ✅ L3 → L1  slow cycle never skips for vision-only apps
  ✅ L1 → L5  window_buffer sensor outcome recording
  ✅ L1 internal  window_buffer tier in click/locate/read_with_fallback

  --- Phase 8: Website Feature Discovery ---
  ✅ L6 → L7  website feature extraction → feature ladder (discover_features → extractFeaturesFromHTML → web_* ladder entries)
  ✅ L6 → L7  value-add generation → tier-2 features (generateValueAddFeatures rule-based → va_* ladder entries)
  ✅ L6 → L2  feature coverage → reference enrichment (mergeWebsiteFeatures → reference JSON with id-based dedup)
  ✅ L7 ← L6  feature ladder from website (ladder-generator Step 2.5 creates web_* entries)
  ✅ L7 → L5  feature coverage → learning signals (extractKeywordsFromName → signal keywords per feature)
  ✅ L6 → L5  feature coverage audit gap detection (coverage-auditor counts websiteFeaturesKnown)

TOTAL: 56 working | 2 partial | 0 missing
```

---

## Data Flow Diagram

```
                         ┌─────────────────────┐
                         │  LAYER 7: APP MAP    │
                         │  (fully connected)   │
                         │                      │
                         │  zones, nav, contracts│
                         │  state, timing, vis  │
                         └──────────┬───────────┘
                                    ↑ WRITES (✅)
                                    │ (8 recording features)
                                    │
                           ✅ L6 bootstraps zones (#12)
                         ✅ L5 scores edges (#11)
                                    │
┌──────────┐  inject(✅)  ┌─────────┴───────────┐  records(✅)  ┌──────────┐
│ LAYER 2  │◄────────────│  LAYER 1: CONTROL    │─────────────►│ LAYER 5  │
│ KNOWLEDGE│  selectors  │                      │  timing+s/f  │ LEARNING │
│          │  into CDP   │  111 tools, adapters  │              │          │
│ refs,    │             │  fallback chains      │  reorders(✅)│ 6 policies│
│ playbooks│             │  LEARNING-GUIDED      │  fallbacks   │          │
│ memory   │             │  (rankSensors order)  │  + timing    │          │
└────┬─────┘             └──────┬───────────────┘              └────┬─────┘
     │                          │                                   │
     │ playbooks(✅)            │ raw data(✅)          locator(✅) │
     │                          ↓                       budget(⚠️)  │
     │                   ┌──────────────────┐           ranking(✅) │
     │                   │  LAYER 3:        │◄──confidence(✅)──────┘
     │                   │  AWARENESS       │
     │                   │                  │──── ✅ auto-updates L7 (Phase 3 #9)
     │                   │  WorldModel,     │──── ✅ preExecutionCheck before L1 acts
     │                   │  Perception loop │
     │                   └────────┬─────────┘
     │                            │ state(✅)
     │                            ↓
     │                   ┌──────────────────┐
     └──────────────────►│  LAYER 4:        │◄──── ✅ L7 nav BFS/contracts/state
                         │  AUTONOMY        │◄──── ✅ L5 pre-fail warnings (#13)
                         │                  │
                         │  Planner,        │
                         │  Recovery        │
                         └──────────────────┘

┌──────────┐
│ LAYER 6  │──refs(✅)──► L2
│ MASTERY  │──playbooks(✅)──► L4
│          │──── ✅ MenuScanner → pre-built zones (#12)
│          │──── ✅ ingestion → cold start L5 policies (F8)
│          │──── ✅ community → pre-built L7 maps (F9)
│          │──── ✅ website → feature ladder (Phase 8: discover_features → web_* entries)
│          │──── ✅ website → value-add features (Phase 8: rule-based → va_* entries)
│          │──── ✅ website → reference enrichment (Phase 8: mergeWebsiteFeatures)
│          │──── ✅ website → coverage audit (Phase 8: websiteFeaturesKnown gap)
└──────────┘

Window Buffer (Phase 7):
  isVisionOnlyApp(bundleId) = true (AX score < 0.15, vision > 0.3)
    → slow cycle never skips → OCR feeds world_state
    → fallback chain: ax → cdp → ocr → [window_buffer] → coordinates
    → GPU capture via cg.captureWindow(windowId) — works hidden
    → coords translated: window-relative → screen-absolute
```

---

## What "Wired Together" Would Look Like

### Layer 7 → Layer 1 (map-guided execution) ✅ IMPLEMENTED
```
Before: click_with_fallback("Submit") → try AX → try CDP → try OCR → try coords
After:  click_with_fallback("Submit")
          → resolveMapPosition("Submit") → known at (0.85, 0.92) → click coords instantly
          → OR: rankSensors → [cdp, ax] for this app → try CDP first
          → getAdaptedRetryPolicy reads appMap timing → 150ms retry delay (not 500ms)
```

### Layer 7 → Layer 4 (map-guided planning) ✅ IMPLEMENTED
```
Before: "Navigate from Notes to Settings" → LLM guesses steps
After:  BFS(nav_graph, "Notes", "Settings") → [click sidebar, click gear icon]
        Contract says: gear icon requires sidebar visible
        State machine says: sidebar is currently collapsed
        → prepend: press Cmd+\ to expand sidebar
```

### Layer 5 → Layer 1 (learning-guided fallback) ✅ IMPLEMENTED
```
Before: AX → CDP → OCR → coords (always, for every app)
After:  planExecution("click", infra(), getSensorRanking())
        For Notion: rankSensors() → [ax, cdp]     (OCR rarely needed)
        For Canva:  rankSensors() → [cdp, ocr, ax] (canvas-heavy)
        For DaVinci: rankSensors() → [ocr, ax]     (timeline is canvas)
```

### Layer 3 → Layer 7 (perception auto-updates map) ✅ IMPLEMENTED
```
Before: Perception sees new elements → forgets them
After:  Perception sees new button "Export" →
          appMap.addElement("page::Settings", "Export", {relativeX, relativeY})
        Perception detects dialog open →
          appMap.recordStateChange("dialog_state", "closed", "open")
        Perception detects page change →
          appMap.recordPageTransition("Home", "Settings", "perception_detected")
        OCR sees "Export" text →
          appMap.recordElementVisibility("Export", "Settings", true)
        Zone ROIs guide OCR → targeted scan replaces full-screen fallback
```

### Layer 3 → Layer 1 (awareness-guided execution) ✅ IMPLEMENTED
```
Before: click("Submit") → fails → "element not found" → user retries
After:  preExecutionCheck(bundleId):
          → WorldModel says: app is in background → auto-focus via ax.focusApp
          → WorldModel says: dialog blocking → warn "[L3→L1] Active dialog detected"
          → WorldModel says: window off-screen → warn "[L3→L1] Window minimized"
          → WorldModel says: state stale (>10s, <0.5 confidence) → warn stale
```

### Layer 7 ↔ Layer 5 (unified edge scoring) ✅ IMPLEMENTED
```
Before: AppMap NavEdge has successCount/failCount, TopologyPolicy has Bayesian score
        → two separate stores, planner doesn't know which to trust
After:  appMap.setTopologyPolicy(learningEngine.topology)
          → recordEdgeOutcome stamps topologyScore on NavEdge
          → getEdgeScore() prefers Bayesian score, falls back to simple ratio
          → single source of truth for edge reliability
```

### Layer 6 → Layer 7 (menu bootstrap) ✅ IMPLEMENTED
```
Before: New app → createEmpty() → BEGINNER, 0 zones, 0 elements → fumbles blind
After:  scan_menu_bar(pid, bundleId, appName)
          → appMap.bootstrapFromMenuScan() creates:
            - toolbar zone with File/Edit/View/etc elements
            - per-menu sub-zones with all menu items
            - feature mastery at depth 2 for file_management, editing, etc.
          → app immediately has spatial structure, not just empty map
```

### Layer 5 → Layer 1 (window buffer for vision-only apps) ✅ IMPLEMENTED (Phase 7)
```
Before: click_with_fallback("Run") on LabVIEW → AX finds nothing → CDP N/A
        → OCR captures physical screen → window hidden behind VS Code → fails
After:  click_with_fallback("Run") on LabVIEW
          → isVisionOnlyApp("labview") = true (AX score 0.02, vision score 0.6)
          → AX/CDP/OCR all fail
          → window_buffer: cg.captureWindow(windowId=983818) captures GPU buffer
          → vision.findText(image, "Run") finds match at (120, 45) window-relative
          → app.windows → window at (200, 100) screen-absolute
          → click at (320, 145) screen-absolute → works!
          → perception slow cycle also never skips → world_state has OCR data
```

### Phase 8: Website Feature Discovery ✅ IMPLEMENTED
```
Before: New app → coverage_report → "0 features known" → generic 5-item ladder
         → scan_menu_bar → discovers 60 menu items → still no idea which are important
After:  New app "Notes"
          → discover_features(url="apple.com/notes", bundleId, appName)
          → extractFeaturesFromHTML(html) parses h2-h4, feature cards, dt/dd lists
            → 18 features with levels: Create Notes [beginner], Smart Folders [pro],
              Scan Documents [expert], API Integration [grandmaster]
          → generateValueAddFeatures() — 10 rule-based triggers (no LLM):
            bulk_create, bulk_delete, auto_organize, summarize_all,
            cross_app_export, change_monitor, etc.
          → mergeWebsiteFeatures() → stores in reference JSON (id-based dedup)
          → ladder-generator Step 2.5 creates web_* entries (exact key match,
            no false suppression), Step 2.6 creates va_* entries
          → coverage_report → "Website features: 18" (gap flagged if 0)

Security: SSRF blocks private/internal URLs, O(n) tag stripping (no ReDoS),
          control char stripping, 5MB response cap, bounded regex quantifiers.

LLM Decision Path for feature discovery:
  1. coverage_report(bundleId) → check websiteFeaturesKnown
  2. If 0 → discover_features(url, bundleId, appName) — fetches + extracts + merges
  3. Ladder auto-regenerates on next recomputeTier via hash mismatch
  4. No manual steps needed — fully automatic pipeline
```

### Layer 5 → Layer 4 (pre-fail pattern warnings) ✅ IMPLEMENTED
```
Before: Planner generates step "click_text('Export')" → fails at runtime → wastes time
After:  planSubgoal() → annotateAndReturn():
          → queryPatterns("com.notion.app", "click_text") → finds "Export" score=0.28, 5 fails
          → step._patternWarning = "⚠ click_text: 'Export' fails 5x (score 0.28) — try 'Export PDF' (score 0.85)"
          → agent reads warning, uses alternative before wasting a cycle
```

---

## Priority Wiring Plan

| # | Wire | What it does | Impact | Effort | Depends on |
|---|------|-------------|--------|--------|------------|
| 1 | L5→L1: rankSensors → fallback order | Stop trying wrong method first | HIGH | ✅ DONE | — |
| 2 | L3→L1: pre-execution worldModel check | Stop failing on stale/minimized/blocked | HIGH | ✅ DONE | — |
| 3 | L7→L1: timing profiles → tool timeouts | Every tool call uses learned timing | MED | ✅ DONE | — |
| 4 | L7→L1: element positions → locate hint | Skip locate phase for known elements | HIGH | ✅ DONE | — |
| 5 | L2→L1: reference selectors → inject | Auto-use known selectors | MED | ✅ DONE | — |
| 6 | L7→L4: BFS nav graph → planner | Navigate any app without LLM guessing | HIGH | ✅ DONE | — |
| 7 | L7→L4: contracts → recovery validation | Know when actions produce wrong results | MED | ✅ DONE | #6 |
| 8 | L7→L4: state machine → planner context | Check modal state before acting | MED | ✅ DONE | #6 |
| 9 | L3→L7: perception auto-updates map | Map stays current without tool calls | HIGH | ✅ DONE | — |
| 10 | L7→L3: zone ROI → targeted OCR | 10x faster perception for known apps | MED | ✅ DONE | #9 |
| 11 | L7↔L5: merge timing + nav stores | Single source of truth, not duplicates | LOW | ✅ DONE | — |
| 12 | L6→L7: MenuScanner → pre-built zones | New apps start at PRO, not BEGINNER | MED | ✅ DONE | — |
| 13 | L5→L4: PatternPolicy → pre-fail | Plans avoid known failure patterns | LOW | ✅ DONE | — |
| 14 | L7→L5: timing bootstrap from AppMap | TimingModel starts warm, not empty | MED | ✅ DONE | — |
| 15 | L7→L3: known elements → skip verify | 200ms saved per well-known element | MED | ✅ DONE | — |
| 16 | L7→L3: timing → adaptive poll intervals | Slow apps poll less, fast apps poll more | LOW | ✅ DONE | — |

**Phase 1 (#1-5)**: ✅ COMPLETE — Learning-guided fallbacks, pre-execution checks, map-guided timing, position hints, selector injection. Every tool call benefits immediately.

**Phase 2 (#6-8)**: ✅ COMPLETE — BFS navigation planning, contract-based preconditions/postconditions, undo-path recovery, state-machine-aware plan enrichment. Planner stops guessing.

**Phase 3 (#9-10)**: ✅ COMPLETE — Perception auto-updates map (elements, nav edges, state changes, visibility). Zone-targeted OCR replaces full-screen fallback.

**Phase 4 (#11-13)**: ✅ COMPLETE — Unified edge scoring via TopologyPolicy, MenuScanner bootstraps pre-built zones for new apps, planner annotates steps with known failure pattern warnings.

**Phase 5 (#14-16)**: ✅ COMPLETE — Timing bootstrap from AppMap profiles, skip-verify for well-known elements (3+ successes, <5min), adaptive perception intervals on context switch.

**Phase 6 (#F1-F11)**: ✅ COMPLETE — All 11 future connections wired: planner timing/recovery from learning, zone spatial awareness, appMap param injection, cold start bootstrap for all 4 policies, ingestion→learning, community→appMap, reference perception config, pre-fail block.

**Phase 7 (window_buffer)**: ✅ COMPLETE — 5th execution method for vision-only apps (LabVIEW, canvas apps). GPU buffer capture works when window is hidden. `isVisionOnlyApp()` detection, slow cycle exemption, window_buffer in click/locate/read fallback chains.

**Phase 8 (Feature Discovery)**: ✅ COMPLETE — `discover_features` tool fetches app website HTML → `extractFeaturesFromHTML()` extracts real features from headings/cards/lists/definition-lists → `generateValueAddFeatures()` creates rule-based value-adds (bulk, summarize, organize, cross-app, monitoring) → `mergeWebsiteFeatures()` stores in reference JSON → `ladder-generator.ts` creates `web_*` + `va_*` ladder entries. Security hardened: SSRF protection, ReDoS-safe O(n) tag stripping, terminal escape prevention, 5MB response cap. 19 issues found and fixed by 3-agent team review. 64 new tests.

**All 33 wires complete (16 + 11 + 6). Phases 1-8 done.**

---

## LLM Decision Guide — Best Path to Choose

When an LLM agent encounters a new app, this is the optimal execution path:

```
Step 0: ASSESS — What do we know?
  coverage_report(bundleId, appName)
  ├── "Has selectors + flows + website features" → GO (use existing knowledge)
  ├── "Has selectors but 0 website features" → DISCOVER (Step 1)
  └── "0 selectors, 0 flows, 0 features" → FULL LEARN (Steps 1-3)

Step 1: DISCOVER FEATURES (Phase 8)
  discover_features(url, bundleId, appName)
  → Extracts real features from official website HTML
  → Generates value-add features (bulk, cross-app, intelligence)
  → Merges into reference JSON (id-based dedup, safe re-runs)
  → Ladder auto-regenerates via hash mismatch
  Cost: ~2s (fetch + parse). No LLM needed.

Step 2: LEARN STRUCTURE
  scan_menu_bar(pid, bundleId, appName)
  → Maps menu items to zones + elements
  → Bootstraps app map with spatial structure
  platform_explore(bundleId)
  → Maps interactive elements via AX tree

Step 3: LEARN BEHAVIOR
  perception_start() → observe app behavior
  platform_guide(platform) → load curated selectors/flows
  memory_recall("task") → reuse past strategies

PRIORITY ORDER for new apps:
  discover_features > scan_menu_bar > platform_explore > platform_guide
  (features first — gives meaningful ladder before any interaction)

KEY FILES in the pipeline:
  feature-extractor.ts    → extractFeaturesFromHTML(), generateValueAddFeatures()
  reference-merger.ts     → mergeWebsiteFeatures() stores in reference JSON
  ladder-generator.ts     → Step 2.5 (web_*) + Step 2.6 (va_*) create ladder entries
  coverage-auditor.ts     → websiteFeaturesKnown gap detection
  mcp-desktop.ts          → discover_features tool (SSRF-protected, 5MB cap)

WHEN TO RE-RUN discover_features:
  → App major version update (new features on website)
  → coverage_report shows websiteFeaturesKnown = 0 but app has official site
  → Safe to re-run: id-based dedup prevents duplicates
```

---

## Remaining Gaps

### 2 Partial Connections

| Connection | What works | What's missing |
|-----------|-----------|----------------|
| L5→L4: `getAdaptiveBudget` | Sets step-level timeouts, injects `_budget` into params, **F1: consumed by executor for adaptive stepTimeout** | No L1 tool handler reads `_budget` for per-phase locate/act/verify durations |
| L7→L2: AppMap hint in contextTracker | Display text shown in tool output | No numeric data (positions, timing, confidence) consumed programmatically |

### Phase 6 Connections (all 11 wired — 2026-03-22)

| Wire | Connection | Direction | Status | Evidence |
|------|-----------|-----------|--------|----------|
| F1 | `_budget` → step timeouts | L5→L4 | ✅ WORKS | `executor.ts`: adaptive timeout = `locateMs + actMs + verifyMs` (min 3s) |
| F2 | `rankRecoveryStrategies` → replan | L5→L4 | ✅ WORKS | `planner.ts:replan()`: queries LearningEngine, prepends recovery step if score > 0.6 |
| F3 | Zone layout → scroll prepend | L7→L4 | ✅ WORKS | `planner.ts:enrichStepsWithStateContext()`: checks `relativePosition.top > 0.85` → prepend scroll |
| F4 | AppMap positions → tool params | L4→L1 | ✅ WORKS | `executor.ts`: injects `_mapHintX`/`_mapHintY` from verified AppMap elements |
| F5 | Contracts → RecoveryPolicy | L7→L5 | ✅ WORKS | `engine.ts:seedRecoveryFromContracts()`: undo paths seeded as recovery strategies |
| F6 | ReadySignals → SensorPolicy | L7→L5 | ✅ WORKS | `engine.ts:seedSensorsFromReadySignals()`: signal type → sensor source mapping |
| F7 | Cold start bootstrap (all policies) | L7→L5 | ✅ WORKS | `engine.ts`: `seedLocatorsFromAppMap` + `seedPatternsFromAppMap` + UIArchitecture → SensorPolicy |
| F8 | Ingestion → learning policies | L6→L5 | ✅ WORKS | `mcp-desktop.ts`: scan_menu_bar → locators+patterns, ingest_documentation → patterns |
| F9 | Community → pre-built maps | L6→L7 | ✅ WORKS | `app-map.ts:importFromPlaybook()`: community_fetch → recordElementOutcome per step |
| F10 | References → perception config | L2→L3 | ✅ WORKS | `context-tracker.ts:getPerceptionConfig()` → coordinator `adjustIntervals()` on context switch |
| F11 | Known errors → pre-fail block | L2→L1 | ✅ WORKS | `mcp-desktop.ts`: blocks execution when tool has 5+ failures with known resolution |
