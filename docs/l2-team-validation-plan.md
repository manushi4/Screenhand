# L2 Team Validation Plan — Perception Layer (v2)

> Daily Standup: 2026-03-16
> L1 Status: SHIPPED (545/545 tests, 37 files, 100%)
> L2 Target: Perception + World Model + Fusion + Entity Tracking
> Team: Breaker, Ghost, Builder, Outsider, Scribe, Chief

---

## 1. YESTERDAY: What did we ship?

| Role | Delivered |
|------|-----------|
| **Builder** | All L1 code solid -- 545 tests across 37 files, zero failures, 13.5s total runtime |
| **Breaker** | L1 validated end-to-end against 5 real apps (Finder, TextEdit, Notes, Safari, System Settings) |
| **Ghost** | L1 security regression suite shipped (`tests/security-regression-l1.test.ts`) -- bridge, path traversal, injection |
| **Scribe** | Full L1-L5 testing plan with benchmark data schema, gate thresholds in `docs/testing-plan.md` |
| **Outsider** | Confirmed MCP server starts clean, 111 tools register, L1 tools usable from Claude client |
| **Chief** | L1 GATE PASSED. Proceeding to L2. |

---

## 2. TODAY: L2 Assignments

### L2 Scope

**What we are proving:** Multi-rate perception loops (FAST 100ms / MEDIUM 300ms / SLOW 1000ms) feed AX, CDP, and Vision data through a fusion pipeline into the world model. Entity tracking persists identities across frames. Dialog detection works. State diffs are accurate. The system does NOT saturate the native bridge during rapid app switching.

**Existing L2 unit tests:** 124 tests across 6 files, ALL passing:

| File | Tests |
|------|-------|
| `tests/perception-coordinator.test.ts` | 18 |
| `tests/world-model.test.ts` | 73 |
| `tests/fusion.test.ts` | 6 |
| `tests/entity-tracker.test.ts` | 11 |
| `tests/frame-differ.test.ts` | 10 |
| `tests/vision-source.test.ts` | 6 |

---

### Builder -- Concrete Deliverables

**Task 1: Fix the timer pileup bug (KNOWN BLOCKER from L1)**

- **File:** `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`, lines 139-151
- **Problem:** `setInterval` fires the callback even if the previous async cycle has not completed. During rapid `switchContext()` calls (which does `stop()` then `start()`), timers pile up bridge calls that saturate the native bridge's JSON-RPC stdio pipe. The current code at lines 139-151 creates three `setInterval` timers with no concurrency guard:
  ```
  this.fastTimer = setInterval(() => {
    void this.fastCycle().catch(() => {});
  }, this.config.fastIntervalMs);
  ```
- **Fix:** Add in-flight boolean guards per loop. If `fastInFlight === true`, the next interval tick is a no-op. Same for `mediumInFlight` and `slowInFlight`. Reset flags in `stop()`.
- **Pass criteria:** New test -- mock `pollAXTree` to take 800ms, advance timers by 1500ms at 300ms medium interval, assert `pollAXTree` called exactly twice (not 5 times).

**Task 2: Add switchContext debounce**

- **File:** `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`, `switchContext()` at line 197
- **Problem:** `switchContext` does a full `stop()` + `start()` on every app focus change. If the user cmd-tabs through 5 apps in 2 seconds, that creates 5 stop+start cycles, each creating 3 new timers.
- **Fix:** Debounce `switchContext` by 150ms. If another switch arrives within the window, cancel the previous and use the latest context only.
- **Pass criteria:** New test -- call `switchContext` 5 times in 100ms, assert `start()` called exactly once (with the last context).

**Task 3: Reset cdpConsecutiveFailures on switchContext**

- **File:** `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`, line 461
- **Problem:** `cdpConsecutiveFailures` is a private field initialized to 0 but never reset in `stop()` or `start()`. Only `activateCDP()` at line 354 resets it. After 11 CDP failures, `pollCDP()` permanently returns at line 472, even after switching to a completely different app where CDP works fine.
- **Fix:** Reset `cdpConsecutiveFailures = 0` in `start()` method.
- **Pass criteria:** New test -- accumulate 15 CDP failures, call `switchContext`, assert CDP polling resumes.

**Task 4: Zero regressions**

- **Pass criteria:** `npm test` exits 0 with 545+ tests passing.

**Files Builder touches:**
- `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`
- `/Users/khushi/Documents/Automator/tests/perception-coordinator.test.ts`

---

### Breaker -- Concrete Deliverables

**Target the known weak spots. Find real bugs with reproduction tests.**

**Task 1: Timer leak on partial start failure**

- **File:** `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`, line 103
- **Test:** Call `start()` where `axSource.startObserving()` throws at line 123. The `catch` at line 124 swallows the error, but `this.running` is already set to `true` at line 109, and timers are created at lines 139-151. Now call `start()` again -- the guard at line 103 returns early. But we still have 3 orphaned timers from the first call.
- **Write a failing test** proving that timers leak when start() partially fails.
- **Severity:** High -- orphaned timers call methods on a coordinator with inconsistent state.

**Task 2: cdpConsecutiveFailures survives switchContext**

- **File:** `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`, lines 461, 472
- **Test:** Create coordinator, start with CDP client, fail CDP 15 times (exceed the `> 10` threshold at line 472). Then call `switchContext()` with a fresh context and working CDP client. Assert that `pollCDP` is called on the next medium cycle.
- **Expected result:** It is NOT called -- because `cdpConsecutiveFailures` is 15 and `stop()` does not reset it. `start()` does not reset it either.
- **Severity:** Medium-High -- once CDP goes silent, browser state tracking is blind for the rest of the session.

**Task 3: Vision permanently skipped when windowId is null**

- **File:** `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`, lines 420-428, 560-561
- **Test:** Start coordinator with `AppContext` where `windowId` is undefined. In `start()`, `activeWindowId` is set to `null` at line 106 (via `appContext.windowId ?? null`). In `slowCycle()` at line 560, `const windowId = this.activeWindowId ?? 0;` then line 561: `if (windowId === 0) return;`. Vision is permanently skipped.
- The `pollAX()` method at lines 420-428 tries to derive `activeWindowId` from the world model, but only if `this.activeWindowId === null`. If AX poll runs first and populates it, vision works. But there is a race -- if `slowCycle` fires before the first `mediumCycle` completes, vision is skipped on that tick.
- **Write a test** that starts perception without windowId and asserts vision does not fire until after AX poll derives the windowId.
- **Severity:** Medium -- vision blindness during the first few seconds of perception.

**Task 4: FusionPipeline dedup drops valid updates from different windows**

- **File:** `/Users/khushi/Documents/Automator/src/state/fusion.ts`, lines 43-54
- **Test:** Enqueue two AX updates for DIFFERENT windowIds (window 1 and window 2) from the same source "ax" at different timestamps. The dedup logic checks `u.source === update.source && u.windowId === update.windowId` -- this should be fine for different windows. But verify: enqueue AX for window 1, then AX for window 1 with older timestamp. Does the older one silently win?
- **Read the code:** Line 48: `if (update.timestamp >= existing.timestamp)` -- the newer update replaces. Line 51: comment says "existing is newer, drop incoming." This is correct. BUT: the dedup uses `>=` not `>`, meaning two updates with identical timestamps will replace (last-in wins). Is this intentional?
- **Severity:** Low -- edge case, but worth verifying.

**Task 5: Entity tracker Retina display scaling**

- **File:** `/Users/khushi/Documents/Automator/src/state/entity-tracker.ts`, line 8
- **Test:** `PROXIMITY_THRESHOLD = 50` pixels. On Retina (2x scale), the AX API reports positions in logical points (not physical pixels). So 50px threshold is actually 50 logical points = 100 physical pixels. Is this intentional? If a panel at (100, 200) moves to (140, 230) -- that is 40px X and 30px Y, both within threshold, so same entity. But what if the bridge reports physical pixels instead of logical? Then (100, 200) to (140, 230) in physical = 20 logical X, 15 logical Y = well within threshold. Document whichever behavior is correct.
- **Severity:** Low -- informational.

**Pass criteria:** At least 3 confirmed bugs with reproduction tests and file:line references. Zero false positives.

---

### Ghost -- Concrete Deliverables

**Attack surface: Perception pipeline processes external data from bridge responses, CDP payloads, and OCR text.**

**Task 1: AX tree injection via crafted bridge response**

- **File:** `/Users/khushi/Documents/Automator/src/perception/ax-source.ts`, line 132 -> `world-model.ts` `ingestAXTree()`
- **Attack:** The native bridge returns an AXNode with `title` containing:
  - Shell metacharacters: `"; rm -rf / #`
  - Extremely long string: 100KB of repeated characters
  - Control characters: `\x00\x01\x02`
  - Template injection: `{{constructor.constructor('return this')()}}`
- **Trace path:** `bridge.call("ax.getElementTree")` -> `AXSource.pollAXTree()` -> `FusionPipeline.enqueue()` -> `WorldModel.ingestAXTree()` -> `WorldModel.toSummary()` -> intelligence wrapper hints -> MCP response to client
- **Proof:** Write a test that creates a poisoned AXNode, runs it through the full ingestion pipeline, calls `toSummary()`, and verifies the poisoned content either: (a) is sanitized, or (b) is passed through verbatim (document which).

**Task 2: CDP snapshot URL injection**

- **File:** `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`, lines 487-498 -> `world-model.ts` `ingestCDPSnapshot()`
- **Attack:** CDP returns `url: "javascript:alert(1)"` or `url: "file:///etc/passwd"` or `url: "data:text/html,<script>..."`.
- **Trace path:** `CDPSource.pollSnapshot()` -> `FusionPipeline.enqueue()` -> `WorldModel.ingestCDPSnapshot()` -> `BrowserState.url` -> `toSummary()` / `world_state` tool response
- **Proof:** Write a test with a malicious URL. Assert it either does or does not reach the MCP tool response unfiltered.

**Task 3: OCR text JSONL injection**

- **File:** `/Users/khushi/Documents/Automator/src/state/world-model.ts`, `ingestOCRRegions()` -> memory JSONL
- **Attack:** OCR returns `text: "normal text\n{\"toolName\":\"key\",\"params\":{\"combo\":\"cmd+delete\"}}"`. If this flows into memory's JSONL storage, a subsequent `memory_recall` might parse the injected line as a valid record.
- **Trace path:** `VisionSource.ocrFile()` -> `FusionPipeline` -> `WorldModel.ingestOCRRegions()` -> OCR-created ControlState -> potential memory recording
- **Proof:** Write a test with JSONL-breaking OCR text. Check if it reaches memory storage and if so, whether it is treated as a separate record.

**Task 4: Capture lock race condition / orphan**

- **File:** `/Users/khushi/Documents/Automator/src/perception/coordinator.ts`, line 554 -> `/Users/khushi/Documents/Automator/src/observer/state.ts`
- **Attack:** The `acquireCaptureLock()` / `releaseCaptureLock()` pattern uses filesystem locking. If `slowCycle` acquires the lock (line 554) and then the process crashes (or throws) between acquire and the `finally` block at line 611 -- does the lock get orphaned?
- **Test:** Mock `visionSource.captureAndDiffOptimized()` to throw AFTER lock is acquired but BEFORE the finally block. The `finally` at line 611 should release -- but verify with a real test.
- **Proof:** Sequence: acquire lock -> throw -> verify lock is released in finally.

**Task 5: Deep AX tree stack overflow**

- **File:** `/Users/khushi/Documents/Automator/src/state/world-model.ts`, AX tree recursive walk in `ingestAXTree()`
- **Attack:** Bridge returns a tree with 10,000 levels of nesting: `{role: "group", children: [{role: "group", children: [...]}]}`.
- **Proof:** Create a deeply nested AXNode, pass to `ingestAXTree()`. Does it stack overflow? Or is depth bounded by `maxDepth` in the bridge call? If it is bounded at the bridge level, is there any path where unbounded depth reaches the world model?

**Pass criteria:** At least 2 exploits with working PoC tests. Not just "I looked at it and it seems fine."

---

### Scribe -- Concrete Deliverables

**Task 1: Verify CLAUDE.md perception section accuracy**

- **File:** `/Users/khushi/Documents/Automator/CLAUDE.md`
- **Check items:**
  - Does it mention the 3-rate architecture (FAST/MEDIUM/SLOW)? Currently: NO -- CLAUDE.md does not document perception rates.
  - Does it mention FusionPipeline? Currently: NO.
  - Does it mention EntityTracker? Currently: NO.
  - Tool count says "111 tools" -- is that still true?
  - Test count says "202 tests" -- WRONG, actual is 545 tests in 37 files.
  - `DEFAULT_PERCEPTION_CONFIG` in `src/perception/types.ts` line 107-116 shows `mediumIntervalMs: 300` and `slowIntervalMs: 1000`, but the coordinator test and some docs say 500ms and 2000ms. Which is canonical? The code is canonical.
- **Fix:** Update every stale section in CLAUDE.md.

**Task 2: Document the perception data flow in architecture.md**

- **File:** `/Users/khushi/Documents/Automator/docs/architecture.md`
- **Required content:**
  ```
  Perception Data Flow (3-rate multi-source):

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
- **Pass criteria:** A new developer can read the doc and correctly predict which method is called at which rate.

**Task 3: Document the known timer pileup issue**

- **Where:** Inline in this file (`docs/l2-team-validation-plan.md`) under Blockers, plus a brief note in CLAUDE.md Critical Patterns section.
- **Content:** What caused it, where in the code, how it was fixed, and what test prevents regression.

**Task 4: Fix test count and file count in CLAUDE.md**

- Current: "14 test files in tests/" and "202 tests"
- Actual: 37 test files, 545 tests
- **Fix:** Update the TypeScript Config section.

---

### Outsider -- Concrete Deliverables

**Task 1: Test perception MCP tools end-to-end**

- Tools: `perception_start`, `perception_stop`, `perception_status`, `world_state`, `world_state_diff`
- **Scenario:** Start MCP server (`npm run dev`), connect via Claude/MCP client, focus Finder, call `perception_start`. Then call `world_state` -- does it show Finder windows? Switch to TextEdit. Call `world_state` again -- does it update?
- **Pass criteria:** Report with exact tool call sequences and response previews.

**Task 2: Test perception under rapid app switching**

- **Scenario:** Start perception. Rapidly cmd-tab between 3 apps (Finder, TextEdit, Safari) 10 times in 10 seconds. Call `perception_status`. Is the coordinator still running? Are error counts elevated?
- **Pass criteria:** Binary answer with evidence -- does rapid switching crash or degrade perception?

**Task 3: Check world_state output readability**

- Call `world_state` and `world_state(verbose: true)`. Is the output useful for an AI agent making decisions? Specific questions:
  - Can you tell which app is focused?
  - Can you tell what windows are open and their titles?
  - Can you tell what controls are available to interact with?
  - Are confidence values meaningful or noise?
  - Is dialog detection surfaced clearly when a dialog is present?
- **Pass criteria:** Written feedback with specific suggestions for improvement.

**Task 4: Test error paths**

- Call `world_state` before `perception_start` -- is the error actionable?
- Call `perception_stop` when not running -- graceful or crash?
- Call `world_state_diff(staleThresholdMs: -1)` -- handled or crash?
- **Pass criteria:** All error paths return useful messages, not stack traces.

---

## 3. BLOCKERS

| # | Blocker | Impact | Owner | Status |
|---|---------|--------|-------|--------|
| B1 | **Timer pileup on rapid switchContext** | Bridge saturation, dropped responses, potential SIGSEGV | Builder | KNOWN -- fix assigned as Task 1 |
| B2 | **cdpConsecutiveFailures not reset on switchContext** | CDP polling permanently silent after transient failures | Builder (Task 3) | SUSPECTED -- Breaker to confirm |
| B3 | **Vision skipped when windowId=null** | No visual change detection until first AX poll derives windowId | Builder awareness, Breaker to confirm | SUSPECTED |
| B4 | **DEFAULT_PERCEPTION_CONFIG mismatch** | Code says 300ms/1000ms, some docs say 500ms/2000ms, tests use both | Scribe to resolve | MINOR |
| B5 | **No real-app validation** | All 124 L2 unit tests use mocks. Real bridge timeouts/SIGSEGV untested | ALL -- this is the #1 gap | CRITICAL |
| B6 | **CLAUDE.md test count stale** | Says "202 tests, 14 files" -- actual is 545 tests, 37 files | Scribe | MINOR |

---

## 4. L2 VALIDATION PLAN -- Full Phase Structure

### Phase 2.1: Timer Safety (Builder) -- SEQUENTIAL FIRST

Everything else depends on this fix. No other phase starts until 2.1 passes.

| ID | Test Spec | Pass Gate |
|----|-----------|-----------|
| 2.1.1 | `fastCycle` in-flight guard: mock fastCycle to take 200ms, advance timer 400ms at 100ms interval, assert fastCycle called exactly 2 times not 4 | Calls <= expected |
| 2.1.2 | `mediumCycle` in-flight guard: mock pollAXTree to take 800ms, advance 1500ms at 300ms interval, assert pollAXTree called exactly 2 times not 5 | Calls <= expected |
| 2.1.3 | `slowCycle` in-flight guard: mock captureAndDiffOptimized to take 3000ms, advance 4000ms at 1000ms interval, assert called exactly 2 times not 4 | Calls <= expected |
| 2.1.4 | Rapid switchContext: call `switchContext()` 10 times in 500ms, assert total bridge calls < 30 | Bridge not saturated |
| 2.1.5 | switchContext debounce: 5 calls in 100ms, assert `start()` called exactly once (with last context) | Debounce coalesces |
| 2.1.6 | cdpConsecutiveFailures reset: accumulate 15 failures, `switchContext`, assert CDP polling resumes | CDP recovers |
| 2.1.7 | Regression: all 124 existing L2 unit tests pass | Zero regressions |
| 2.1.8 | Regression: full `npm test` passes (545+ tests) | Zero regressions |

**Pass gate:** ALL 8 tests pass.

---

### Phase 2.2: Bug Hunt (Breaker) -- PARALLEL with 2.1

Breaker tests against CURRENT code to confirm bugs. Builder fixes them in 2.1/2.4.

| ID | Target | File:Line | Severity |
|----|--------|-----------|----------|
| 2.2.1 | Timer leak on partial start failure (axSource.startObserving throws) | `coordinator.ts:103-151` | High |
| 2.2.2 | cdpConsecutiveFailures survives switchContext (permanent CDP blindness) | `coordinator.ts:461,472` | Medium-High |
| 2.2.3 | Vision permanently skipped when windowId=null at start | `coordinator.ts:420-428,560-561` | Medium |
| 2.2.4 | FusionPipeline dedup with identical timestamps (last-in-wins, is this correct?) | `fusion.ts:43-54` | Low |
| 2.2.5 | Entity tracker Retina proximity (50px logical vs physical) | `entity-tracker.ts:8` | Low |

**Pass gate:** >= 3 confirmed bugs with reproduction tests. Each has file:line, severity, failing test.

---

### Phase 2.3: Security Audit (Ghost) -- PARALLEL with 2.1 and 2.2

| ID | Attack Vector | Trace Path | File:Line |
|----|--------------|------------|-----------|
| 2.3.1 | AX tree poisoned title (100KB, shell chars, control chars) | bridge -> axSource -> fusion -> worldModel -> toSummary -> MCP response | `ax-source.ts:132` |
| 2.3.2 | CDP `javascript:` URL in snapshot | cdpSource -> fusion -> worldModel.ingestCDPSnapshot -> BrowserState.url | `coordinator.ts:487-498` |
| 2.3.3 | OCR text with JSONL-breaking newlines | visionSource -> fusion -> worldModel.ingestOCRRegions -> ControlState -> memory | `world-model.ts:ingestOCRRegions` |
| 2.3.4 | Capture lock orphan on crash between acquire and finally | `acquireCaptureLock()` -> throw -> does `finally` fire? | `coordinator.ts:554-612` |
| 2.3.5 | Deep AX tree (10000 levels) stack overflow | bridge returns deep tree -> worldModel.ingestAXTree recursive walk | `world-model.ts:ingestAXTree` |

**Pass gate:** >= 2 exploits with working PoC tests.

---

### Phase 2.4: Bug Fix Round (Builder) -- AFTER 2.2 and 2.3

| ID | Fix | Source | Pass Gate |
|----|-----|--------|-----------|
| 2.4.1 | Fix each confirmed Breaker bug | Phase 2.2 results | Breaker's failing test now passes |
| 2.4.2 | Fix each confirmed Ghost exploit | Phase 2.3 results | Ghost's PoC test passes (sanitized/bounded) |
| 2.4.3 | Full regression check | -- | `npm test` passes, 545+ tests |

**Pass gate:** ALL bugs fixed. ALL tests pass.

---

### Phase 2.5: Documentation Update (Scribe) -- PARALLEL with 2.4

| ID | Deliverable | File | Pass Gate |
|----|-------------|------|-----------|
| 2.5.1 | CLAUDE.md perception rates documented | `CLAUDE.md` | Mentions FAST/MEDIUM/SLOW, FusionPipeline, EntityTracker |
| 2.5.2 | CLAUDE.md test count fixed (545 tests, 37 files) | `CLAUDE.md` | Matches `npm test` output |
| 2.5.3 | architecture.md data flow diagram | `docs/architecture.md` | Accurate source -> rate -> method -> worldModel mapping |
| 2.5.4 | DEFAULT_PERCEPTION_CONFIG intervals documented | `CLAUDE.md` | States 100/300/1000ms, references `types.ts` lines 107-116 |
| 2.5.5 | Timer pileup fix documented | This file + `CLAUDE.md` | Future devs know what was fixed |

**Pass gate:** Every claim verified against code. Zero contradictions.

---

### Phase 2.6: Usability Validation (Outsider) -- AFTER 2.4

| ID | Scenario | Pass Gate |
|----|----------|-----------|
| 2.6.1 | `perception_start` on Finder | Returns running status, `world_state` shows Finder windows |
| 2.6.2 | App switch detection | Focus TextEdit, `world_state` updates within 500ms |
| 2.6.3 | Rapid app switching (10 times in 10 seconds) | `perception_status` shows coordinator still running |
| 2.6.4 | `world_state` output readability | Parseable, useful for agent decisions |
| 2.6.5 | `world_state_diff(staleThresholdMs: 30000)` stale detection | Reports stale controls after 30s idle |
| 2.6.6 | `perception_stop` + restart | Clean stop, restart succeeds, state resumes |
| 2.6.7 | Error paths (`world_state` before start, invalid params) | Useful error messages, no crashes |

**Pass gate:** >= 6 of 7 pass. Failures documented with exact call/response.

---

### Phase 2.7: Integration Smoke Test (ALL) -- FINAL GATE

Real apps, real bridge, real perception. This is the gap that matters.

| ID | Apps | Scenario | Pass Gate |
|----|------|----------|-----------|
| 2.7.1 | Finder | perception_start -> key(cmd+n) -> world_state shows +1 window -> key(cmd+w) -> -1 window | Window count delta correct |
| 2.7.2 | TextEdit | Type text -> world_state shows controls -> key(cmd+w) -> dialog in world_state | Dialog detected < 1000ms |
| 2.7.3 | Safari | Navigate to URL -> world_state shows page title -> navigate again -> title updates | Title changes detected |
| 2.7.4 | Cross-app | Finder -> TextEdit -> Safari rapid switch -> world_state shows correct active app each time | Active app correct |
| 2.7.5 | Stability | Run perception 60 seconds continuous -> perception_status | All cycle counts > 0, zero crashes |

**Pass gate:** >= 4 of 5 pass. This is the REAL-APP VALIDATION that has been missing.

---

## Execution Order

```
DAY 1 -- PARALLEL BLOCK:
  2.1 Timer Safety       [Builder]     ---+
  2.2 Bug Hunt           [Breaker]     ---+-- Run simultaneously
  2.3 Security Audit     [Ghost]       ---+

DAY 1-2 -- SEQUENTIAL:
  2.4 Bug Fix Round      [Builder]     <-- Depends on 2.2 + 2.3 outputs
  2.5 Doc Update         [Scribe]      <-- Parallel with 2.4

DAY 2 -- SEQUENTIAL:
  2.6 Usability          [Outsider]    <-- Depends on 2.4 (fixed code)
  2.7 Integration        [ALL]         <-- FINAL GATE. Ship decision after this.
```

---

## Decision Matrix

| Scenario | Decision |
|----------|----------|
| All 7 phases pass | **SHIP L2.** Proceed to L3 (Awareness with real-app perception). |
| 2.1-2.6 pass, 2.7 fails 1 test | **Fix and re-run 2.7 only.** Do not proceed to L3 until 2.7 passes. |
| 2.1-2.6 pass, 2.7 fails 2+ tests | **NOT READY.** Root-cause, fix, re-run from 2.4 forward. |
| 2.1 fails (timer fix broken) | **FULL STOP.** Timer pileup is a blocking bug. Nothing else matters until fixed. |
| 2.2 finds 0 bugs | **Investigate Breaker.** Either lazy or not targeting the right code. Re-assign with more specific targets. |
| 2.3 finds 0 exploits | **Acceptable IF** Ghost documented thorough audit with negative results for each target. "Looked fine" = F. |
| Any phase regresses existing 545 tests | **STOP.** Fix regressions before continuing. |

---

## L2 Gate Thresholds

From `docs/testing-plan.md` Level 3 benchmarks (these map to our L2 validation):

| Metric | Target |
|--------|--------|
| Unit test pass rate | 95% (118/124 minimum for existing, 100% for new) |
| `perception_start` latency | < 500ms |
| `world_state` latency | < 200ms |
| `world_state_diff` latency | < 200ms |
| `perception_status` latency | < 100ms |
| Window open -> state reflects | < 1000ms |
| Window close -> state reflects | < 1000ms |
| App switch -> state reflects | < 500ms |
| Dialog appear -> detected | < 1000ms |
| Dialog dismiss -> cleared | < 500ms |
| Perception fast loop | ~100ms cycle |
| Perception medium loop | ~300ms cycle |
| Perception slow loop | ~1000ms cycle |

---

## Test Count Targets

| Phase | New Tests | Cumulative (L2 files) | Full Suite |
|-------|-----------|----------------------|------------|
| Before L2 | 0 | 124 | 545 |
| 2.1 Timer Safety | +8 | 132 | 553 |
| 2.2 Bug Hunt | +5 | 137 | 558 |
| 2.3 Security Audit | +5 | 142 | 563 |
| 2.4 Bug Fixes | 0 (fixes existing) | 142 | 563 |
| 2.7 Integration | +5 (scripted e2e) | 147 | 568 |
| **L2 Total** | **+23** | **147** | **568+** |

---

## Key File Paths

### Source Code

| Component | Absolute Path |
|-----------|---------------|
| Perception Coordinator | `/Users/khushi/Documents/Automator/src/perception/coordinator.ts` |
| Perception Manager | `/Users/khushi/Documents/Automator/src/perception/manager.ts` |
| Perception Types | `/Users/khushi/Documents/Automator/src/perception/types.ts` |
| AX Source | `/Users/khushi/Documents/Automator/src/perception/ax-source.ts` |
| Vision Source | `/Users/khushi/Documents/Automator/src/perception/vision-source.ts` |
| Frame Differ | `/Users/khushi/Documents/Automator/src/perception/frame-differ.ts` |
| World Model | `/Users/khushi/Documents/Automator/src/state/world-model.ts` |
| State Types | `/Users/khushi/Documents/Automator/src/state/types.ts` |
| Entity Tracker | `/Users/khushi/Documents/Automator/src/state/entity-tracker.ts` |
| Fusion Pipeline | `/Users/khushi/Documents/Automator/src/state/fusion.ts` |
| Capture Lock | `/Users/khushi/Documents/Automator/src/observer/state.ts` |

### Tests

| Component | Absolute Path | Test Count |
|-----------|---------------|------------|
| Coordinator | `/Users/khushi/Documents/Automator/tests/perception-coordinator.test.ts` | 18 |
| World Model | `/Users/khushi/Documents/Automator/tests/world-model.test.ts` | 73 |
| Fusion | `/Users/khushi/Documents/Automator/tests/fusion.test.ts` | 6 |
| Entity Tracker | `/Users/khushi/Documents/Automator/tests/entity-tracker.test.ts` | 11 |
| Frame Differ | `/Users/khushi/Documents/Automator/tests/frame-differ.test.ts` | 10 |
| Vision Source | `/Users/khushi/Documents/Automator/tests/vision-source.test.ts` | 6 |

### Docs

| Document | Absolute Path |
|----------|---------------|
| Testing Plan (L1-L5) | `/Users/khushi/Documents/Automator/docs/testing-plan.md` |
| Architecture | `/Users/khushi/Documents/Automator/docs/architecture.md` |
| CLAUDE.md | `/Users/khushi/Documents/Automator/CLAUDE.md` |
| This Plan | `/Users/khushi/Documents/Automator/docs/l2-team-validation-plan.md` |

---

## TEAM SCORECARD (L1 Baseline)

```
TEAM SCORECARD (L1 Final)
==========================
Breaker:  A  -- Found real failure modes pre-fix, validated all 59 cases post-fix
Ghost:    A  -- Bridge spawning, PID isolation, path traversal -- real exploit chains
Builder:  A  -- 545 tests, zero regressions, clean code that survived full review
Scribe:   B  -- Testing plan is excellent, but CLAUDE.md is stale (test count, no perception docs)
Outsider: A  -- Found real flow issues, not surface-level feedback

BLOCKERS: 2 known perception bugs (timer pileup, CDP failure counter)
SCOPE CHECK: On track. L1 shipped. L2 is next per plan.
SHIP DECISION: L1 SHIPPED. L2 validation starts now.
```
