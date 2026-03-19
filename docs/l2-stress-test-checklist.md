# L2 Intelligence Layer — Stress Test Checklist

**Layer**: L2 (Intelligence — Perception, World Model, Learning, Recovery, Planning, Community)
**Platform**: macOS
**Date created**: 2026-03-17
**Components**: 13 | **Total scenarios**: 80

---

## 1. Perception Coordinator (`src/perception/coordinator.ts`)

### 1.1 Timer & Concurrency
- [ ] **PC-01**: Start perception → verify 3-rate loop fires (FAST 100ms, MEDIUM 300ms, SLOW 1000ms)
- [ ] **PC-02**: Inject 500ms+ bridge latency → confirm in-flight guards prevent timer pileup (fastInFlight, mediumInFlight, slowInFlight)
- [ ] **PC-03**: Rapid app switch (cmd-tab 5+ apps in <1s) → confirm switchContext debounce (150ms) coalesces into single stop+start
- [ ] **PC-04**: Start → stop → start rapidly (10x) → no leaked intervals, no double-starts
- [ ] **PC-05**: CDP consecutive failures → verify cdpConsecutiveFailures resets on context switch
- [ ] **PC-06**: Kill native bridge mid-perception-cycle → verify graceful error handling, no crash
- [ ] **PC-07**: Start perception with no windows open → verify no crash, empty world state

### 1.2 Data Flow
- [ ] **PC-08**: FAST tick: AXSource.drainEvents → verify WorldModel.ingestUIEvents called with correct data
- [ ] **PC-09**: FAST tick: CDPSource.drainMutations → verify WorldModel.ingestCDPMutations called
- [ ] **PC-10**: MEDIUM tick: AXSource.pollAXTree → FusionPipeline → WorldModel.ingestAXTree pipeline intact
- [ ] **PC-11**: SLOW tick: VisionSource.captureAndDiffOptimized → FrameDiffer → OCR only if changed
- [ ] **PC-12**: SLOW tick: Screen unchanged → confirm OCR skipped (saves ~250ms)

---

## 2. World Model (`src/state/world-model.ts`)

### 2.1 State Mutations
- [ ] **WM-01**: Ingest AX tree → verify windows, controls, focus updated correctly
- [ ] **WM-02**: Ingest CDP snapshot → verify browser state merged without clobbering native state
- [ ] **WM-03**: Ingest OCR regions → verify text overlays merged with AX data
- [ ] **WM-04**: Ingest UI events (focus change, window move, dialog open) → state reflects each
- [ ] **WM-05**: Rapid sequential ingests (AX + CDP + OCR within 50ms) → no race conditions, consistent state

### 2.2 State Queries
- [ ] **WM-06**: `world_state` tool returns current app, windows, controls, focus, scroll
- [ ] **WM-07**: `world_state_diff` returns meaningful diff after UI change
- [ ] **WM-08**: Query state when no perception running → returns stale/empty state, no crash
- [ ] **WM-09**: State with 50+ windows and 1000+ controls → no excessive memory or slowdown

---

## 3. Entity Tracker (`src/state/entity-tracker.ts`)

### 3.1 Identity Persistence
- [ ] **ET-01**: Same button across 5 frames → gets same entity ID (label + window + 50px proximity)
- [ ] **ET-02**: Button moves 30px between frames → still identified as same entity
- [ ] **ET-03**: Button moves 100px+ → treated as new entity (exceeds proximity threshold)
- [ ] **ET-04**: Two buttons with same label in same window → distinguished by position
- [ ] **ET-05**: Window closes and reopens → entities get fresh IDs (no stale references)

### 3.2 Edge Cases
- [ ] **ET-06**: Rapid frame updates (10 frames in 1s) → entity IDs remain stable
- [ ] **ET-07**: Entity tracker with 500+ tracked entities → no performance degradation
- [ ] **ET-08**: App switch → entity tracker clears old app entities, tracks new ones

---

## 4. Fusion Pipeline (`src/state/fusion.ts`)

### 4.1 Deduplication
- [ ] **FP-01**: Duplicate AX event + CDP event for same element → deduplicated by source+windowId
- [ ] **FP-02**: Events from 3 sources arrive out-of-order → flushed in timestamp order
- [ ] **FP-03**: Learning-adaptive confidence: LearningEngine adjusts fusion weights over time

### 4.2 Throughput
- [ ] **FP-04**: 100 events/second burst → all processed, no drops
- [ ] **FP-05**: Mixed source flush (AX + CDP + OCR) → correct interleaving

---

## 5. Learning Engine (`src/learning/engine.ts`)

### 5.1 Core Learning
- [ ] **LE-01**: Record successful tool outcome → selector confidence increases
- [ ] **LE-02**: Record failed tool outcome → selector confidence decreases
- [ ] **LE-03**: Selector promoted after 2+ consecutive successes (contextTracker threshold)
- [ ] **LE-04**: TimingModel adjusts estimates based on actual execution times
- [ ] **LE-05**: LocatorPolicy learns preferred locator strategy per app/context
- [ ] **LE-06**: SensorPolicy adjusts perception rates based on app activity level

### 5.2 Persistence & Reset
- [ ] **LE-07**: `learning_status` returns current state, confidence levels, learned patterns
- [ ] **LE-08**: `learning_reset` clears all learned data, returns to defaults
- [ ] **LE-09**: Learning data survives MCP server restart (persisted to disk)
- [ ] **LE-10**: Corrupted learning data file → engine initializes with defaults, no crash

---

## 6. Recovery Engine (`src/recovery/engine.ts`)

### 6.1 Detection
- [ ] **RE-01**: Dialog detector: unexpected dialog appears → detected and reported
- [ ] **RE-02**: Stall detector: no UI change for N seconds → stall detected
- [ ] **RE-03**: Crash detector: app PID disappears → crash detected
- [ ] **RE-04**: Navigation detector: unexpected URL/screen change → detected
- [ ] **RE-05**: Multiple simultaneous detectors fire → prioritized correctly

### 6.2 Strategies
- [ ] **RE-06**: Dialog recovery: dismiss unexpected dialog (click OK/Cancel/Close)
- [ ] **RE-07**: Stall recovery: retry last action or escalate
- [ ] **RE-08**: Crash recovery: relaunch app and resume from last checkpoint
- [ ] **RE-09**: Navigation recovery: navigate back to expected state
- [ ] **RE-10**: Recovery strategy fails → escalation to next strategy
- [ ] **RE-11**: Max retries exceeded → give up gracefully with clear error

### 6.3 Configuration
- [ ] **RE-12**: `recovery_status` shows active detectors, queue, recent recoveries
- [ ] **RE-13**: `recovery_configure` enables/disables specific detectors
- [ ] **RE-14**: `recovery_queue_add` manually adds item → processed by engine
- [ ] **RE-15**: `recovery_queue_list` shows pending items

---

## 7. Recovery Detectors (`src/recovery/detectors.ts`)

- [ ] **RD-01**: Each detector implements consistent interface (detect + confidence)
- [ ] **RD-02**: Detector runs without perception active → uses polling fallback
- [ ] **RD-03**: False positive rate: run detectors on stable UI for 60s → zero false triggers
- [ ] **RD-04**: Detector with world model data vs without → graceful degradation

---

## 8. Recovery Strategies (`src/recovery/strategies.ts`)

- [ ] **RS-01**: Each strategy implements consistent interface (canHandle + execute)
- [ ] **RS-02**: Strategy receives correct context (detected issue, current state, history)
- [ ] **RS-03**: Strategy timeout: long-running recovery → times out and returns failure
- [ ] **RS-04**: Strategy side effects: recovery action doesn't corrupt world model state

---

## 9. Planner (`src/planner/planner.ts`, `src/planner/index.ts`)

### 9.1 Goal Planning
- [ ] **PL-01**: `plan_goal` with simple task → generates step-by-step plan
- [ ] **PL-02**: `plan_goal` with complex multi-app task → generates cross-app plan
- [ ] **PL-03**: Plan references known platform selectors from references/ files
- [ ] **PL-04**: `plan_list` shows all plans, `plan_status` shows specific plan state

### 9.2 Plan Lifecycle
- [ ] **PL-05**: `plan_step` advances plan to next step
- [ ] **PL-06**: `plan_step_resolve` marks step complete/failed with outcome
- [ ] **PL-07**: `plan_cancel` cancels active plan cleanly
- [ ] **PL-08**: Plan step fails → recovery engine engaged (if configured)

---

## 10. Plan Executor (`src/planner/executor.ts`)

### 10.1 Execution
- [ ] **PE-01**: `plan_execute` runs full plan end-to-end
- [ ] **PE-02**: Executor uses tool-registry to map plan steps to MCP tool calls
- [ ] **PE-03**: Step execution respects budget (locate/act/verify timeouts from config)
- [ ] **PE-04**: Step fails mid-plan → executor pauses, allows manual intervention or recovery

### 10.2 Integration
- [ ] **PE-05**: Executor + perception: uses world_state to verify step outcomes
- [ ] **PE-06**: Executor + learning: records successful/failed steps for future planning
- [ ] **PE-07**: Executor + recovery: triggers recovery on step failure (if auto-recovery enabled)

---

## 11. Context Tracker (`src/context-tracker.ts`)

### 11.1 Context Detection
- [ ] **CT-01**: Browser navigate to known domain → reference file auto-loaded
- [ ] **CT-02**: Focus native app with known bundleId → reference file auto-loaded
- [ ] **CT-03**: Switch between 3 apps rapidly → correct reference loaded each time
- [ ] **CT-04**: Unknown domain/bundleId → no reference loaded, no error

### 11.2 Hints & Learning
- [ ] **CT-05**: `getHints()` returns selector suggestions for current context
- [ ] **CT-06**: `recordOutcome()` with success → selector promoted after 2+ successes
- [ ] **CT-07**: `recordOutcome()` with failure → selector demoted
- [ ] **CT-08**: Hints include known errors and playbook suggestions

---

## 12. Community Publisher (`src/community/publisher.ts`)

- [ ] **CP-01**: `community_publish` packages playbook with metadata
- [ ] **CP-02**: Publish validates playbook structure before submission
- [ ] **CP-03**: Publish with missing required fields → clear validation error
- [ ] **CP-04**: Publish with malicious content → sanitization or rejection

---

## 13. Community Validator (`src/community/validator.ts`)

- [ ] **CV-01**: `community_fetch` retrieves published playbooks
- [ ] **CV-02**: Fetched playbook validated against schema
- [ ] **CV-03**: Invalid/corrupt playbook → rejected with clear error
- [ ] **CV-04**: Playbook with unsafe tool calls (e.g., shell execution) → flagged or blocked

---

## Risk Matrix

| Priority | Category | Components | Scenarios |
|----------|----------|------------|-----------|
| CRITICAL | Timer/concurrency pileup | Perception Coordinator | PC-01 to PC-07 |
| CRITICAL | State mutation races | World Model, Fusion | WM-05, FP-01 to FP-05 |
| HIGH | Recovery correctness | Recovery Engine, Detectors, Strategies | RE-01 to RE-15, RD-01 to RD-04, RS-01 to RS-04 |
| HIGH | Learning persistence | Learning Engine | LE-07 to LE-10 |
| HIGH | Entity identity stability | Entity Tracker | ET-01 to ET-08 |
| MEDIUM | Plan execution integrity | Planner, Executor | PL-01 to PL-08, PE-01 to PE-07 |
| MEDIUM | Context tracking accuracy | Context Tracker | CT-01 to CT-08 |
| LOW | Community safety | Publisher, Validator | CP-01 to CP-04, CV-01 to CV-04 |

## Recommended Test File Structure

```
tests/
  l2-perception.test.ts      — PC-01 to PC-12, WM-01 to WM-09, ET-01 to ET-08, FP-01 to FP-05
  l2-learning.test.ts         — LE-01 to LE-10, CT-01 to CT-08
  l2-recovery.test.ts         — RE-01 to RE-15, RD-01 to RD-04, RS-01 to RS-04
  l2-planner.test.ts          — PL-01 to PL-08, PE-01 to PE-07
  l2-community.test.ts        — CP-01 to CP-04, CV-01 to CV-04
```

## Test Approach

- **Unit tests**: Mock native bridge and run each component in isolation (Learning, Recovery, Planner, EntityTracker, Fusion)
- **Integration tests**: Run Perception Coordinator with real bridge for timer/concurrency validation
- **Stress tests**: Burst events, rapid context switches, concurrent mutations to find race conditions
- **Persistence tests**: Kill process mid-write, corrupt data files, verify recovery to defaults
- **Real-app validation**: Run perception + recovery against live apps (Finder, Safari, Notes) to catch OS-level edge cases

---

**Total**: 80 test scenarios across 13 components
**Estimated execution**: ~3-4 sessions (perception/state first, then learning/recovery, then planner/community)
