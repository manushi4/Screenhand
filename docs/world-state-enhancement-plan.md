# World State Enhancement Plan

> ScreenHand's perception engine upgrade: from 1.2 FPS blind polling to adaptive, source-aware, idle-gated intelligence.

## Current State (What We Have)

### 3-Rate Perception Loop

| Loop | Interval | Source | What It Captures | Latency |
|------|----------|--------|------------------|---------|
| **FAST** | 100ms | AX events + CDP mutations | Focus changes, value changes, dialog opens | <5ms |
| **MEDIUM** | 300ms | AX tree poll + CDP snapshot | Full control tree, URL/title, node counts | 50-200ms |
| **SLOW** | 1000ms | Screenshot → hash diff → OCR | Visual text elements + positions | 370-831ms |

### World Model Storage

- **Windows**: Map<windowId, WindowState> — up to 500 controls per window
- **Controls**: stableId (SHA256 of role+label+quantized 50px position), role, label, value, enabled, position, size, source, confidence
- **Dialogs**: type (modal/sheet/alert/popover/permission/save), buttons, message, per-window stacks
- **Entities**: Cross-frame identity via EntityTracker — label + window + 50px proximity matching, 10-position history
- **Confidence**: Tracked<T> wrapper with time decay — `confidence * exp(-0.05 * elapsedMinutes)`. At 1 min: 0.95x, 5 min: 0.77x, 10 min: 0.61x
- **Stale pruning**: Windows from previous app pruned if not seen in 30s

### Fusion Pipeline

- Deduplicates by (source, windowId) — keeps newest per pair
- Max 100 updates in queue
- Orders by timestamp before flushing to WorldModel
- Learning-adaptive confidence: queries LearningEngine.rankSensors(bundleId)
- Default confidence weights: AX=0.9, CDP=0.85, OCR=0.7

### Current Performance (Benchmarked 2026-03-21, M4 Mac)

| Component | Current Speed | Bottleneck |
|-----------|--------------|------------|
| Screenshot (screencapture CLI) | 200ms | Shell spawn overhead |
| Screenshot (ScreenCaptureKit one-shot) | 53ms | Already fast |
| Screenshot (SCStream continuous) | 17-33ms | Device-limited at 57 FPS |
| OCR (ACCURATE + 13 langs + correction) | 631ms | Language count + recognition level |
| OCR (FAST + en-only + no correction) | 60ms | Near-optimal |
| OCR (FAST + quarter resolution) | 23ms | Resolution tradeoff |
| Frame hash diff | <1ms | Already optimal |
| Full slow cycle (screenshot + OCR) | 831ms → 1.2 FPS | **This is the bottleneck** |

### Current Safeguards (Already Built)

- **In-flight guards**: `fastInFlight`, `mediumInFlight`, `slowInFlight` — prevents timer pileup if previous cycle hasn't finished
- **Context switch debounce**: 150ms coalescing for rapid cmd-tab switching
- **AX adaptive backoff**: Skips polling after 5 consecutive failures or if avg latency >5s
- **CDP resilience**: Exponential retry with reconnection factory, resets on context switch
- **Vision skip**: Learning engine can disable vision for apps where it consistently fails (score <0.1), re-evaluates every 20th cycle
- **Capture lock**: Coordinates with observer daemon to prevent concurrent captures

---

## What Documents Suggest

### App Mastery Map Spec (docs/app-mastery-map.md)

- **Relative positions** (0.0-1.0): `pixelX = windowBounds.x + (relativeX * windowBounds.width)` — survives window resize, move, display change
- **Zone maps**: Named regions (toolbar, sidebar, canvas, status_bar) with relative bounds — group elements by spatial area
- **Navigation graph**: Directed edges with Bayesian success scores — which action from state A leads to state B
- **Mastery levels**: beginner → pro → expert → grandmaster — based on zone coverage, edge reliability, element count, success rate
- **Learn-First mode**: Systematic exploration on first visit — scan all menus, panels, tooltips in 30-60 seconds
- **Explore-Fast mode**: Skip learning, rely on OCR+AX live — for known apps or simple tasks
- **Stale detection**: Flag zones as stale when OCR doesn't match stored map — trigger partial re-learn

### Architecture Doc (docs/architecture.md)

- Layer 3 (Awareness) feeds Layer 4 (Planning) — world state is the planner's input
- Reliability targets: A-tier apps need 95%+ action success, C-tier apps 70%+
- Perception should be "invisible cost" — fast enough that tool calls don't wait for it

---

## Enhancement Plan

### Phase 1: OCR Speed (Immediate, Code Change Only)

**Change**: Add dual-mode OCR in VisionBridge.swift

```
Current:  .accurate + 13 languages + languageCorrection = 631ms
New:      .fast + en-only + no correction = 60ms (perception loop)
          .accurate + en-only + no correction = 299ms (tool actions)
```

**Implementation**:
- Add `recognitionMode` parameter to `vision.ocr` bridge call: `"fast"` or `"accurate"`
- VisionBridge.swift: if mode == "fast" → `.fast`, `usesLanguageCorrection = false`, `recognitionLanguages = ["en-US"]`
- Perception coordinator's slow loop: always use `"fast"` mode
- `ocr` tool (user-facing): keep `"accurate"` mode
- `click_text` tool: keep `"accurate"` mode

**Impact**: Slow cycle drops from 831ms → 260ms (screenshot 200ms + OCR 60ms). Perception goes from 1.2 FPS → 3.8 FPS.

**Tradeoff**: FAST mode finds 111 elements vs 138 for ACCURATE (20% fewer). Acceptable for perception loop — it's diffing frames, not finding exact click targets.

**Files to modify**:
- `native/macos-bridge/Sources/VisionBridge.swift` — add mode parameter
- `src/perception/vision-source.ts` — pass `mode: "fast"` to bridge OCR calls
- `src/native/bridge-client.ts` — no change (already passes arbitrary params)

### Phase 2: Region-Based OCR (1-2 Days)

**Change**: Only run OCR on screen regions that actually changed between frames.

```
Current:  Full-screen OCR every cycle = 60ms (fast mode) on entire 2940x1912
New:      OCR only changed regions = 6-23ms per region, avg 2-3 regions
```

**Implementation**:
- FrameDiffer already identifies changed regions (128px grid cells)
- Group adjacent changed cells into rectangular ROIs
- Cap at `maxROIsPerCycle: 3` (already in config)
- Run `vision.ocrRegion` per ROI instead of full `vision.ocr`
- Merge OCR results back into world model with region coordinates

**Impact**: If 20% of screen changes per cycle → OCR cost drops from 60ms → ~15ms. Combined with screenshot: 215ms → 70ms per slow cycle = **14 FPS**.

**Tradeoff**: PNG-based diff produces approximate ROIs (compressed bytes don't map to pixels). Mitigated by padding ROIs +64px on each side. For pixel-accurate diff, need raw RGBA via `cg.captureWindowBuffer` — more complex but available.

**Files to modify**:
- `src/perception/vision-source.ts` — use ROIs from FrameDiffer, call ocrRegion per ROI
- `src/perception/frame-differ.ts` — add ROI padding, ensure grid cells merge into usable rectangles

### Phase 3: Idle Gating (1 Day)

**Change**: Stop all perception when ScreenHand is idle. Resume instantly when a tool is called.

```
Current:  3 loops run continuously, even when user hasn't called a tool in 5 minutes
New:      After 3s of no tool calls → pause all loops
          On next tool call → resume immediately, run one full cycle before tool executes
```

**Implementation**:
- Add `lastToolCallAt` timestamp in perception coordinator
- Each loop cycle checks: `if (Date.now() - lastToolCallAt > 3000) return` (skip cycle)
- `mcp-desktop.ts` intelligence wrapper: call `coordinator.notifyToolCall()` in PRE-CALL
- First cycle after wake: run full ACCURATE OCR to ensure world state is fresh

**States**:
```
ACTIVE:    All 3 loops running (tool called < 3s ago)
IDLE:      Loops skip (no tool calls for 3s)
WAKING:    First tool call after idle — run one ACCURATE cycle, then proceed
```

**Impact**: Zero CPU/battery at idle. ~100ms delay on first tool call after idle (one ACCURATE OCR cycle).

**Tradeoff**: If the user switches apps while idle, the world state won't track the change until the next tool call. Acceptable — if no tool is being called, the state isn't needed.

**Files to modify**:
- `src/perception/coordinator.ts` — add idle gating logic, `notifyToolCall()` method
- `mcp-desktop.ts` — call `notifyToolCall()` in PRE-CALL wrapper

### Phase 4: SCStream Continuous Capture (1 Week)

**Change**: Replace one-shot `screencapture` CLI with ScreenCaptureKit continuous stream during active workflows.

```
Current:  screencapture CLI per slow cycle = 200ms per frame
New:      SCStream at 30fps = 33ms per frame, frames buffered in native bridge
```

**Implementation**:
- Add `vision.startStream` / `vision.stopStream` / `vision.getLatestFrame` to native bridge
- Swift side: `SCStream` with `SCStreamOutput` delegate, ring buffer of last 2 frames
- `getLatestFrame` returns most recent frame (no capture cost — already in buffer)
- Perception coordinator: start stream when entering ACTIVE state, stop when entering IDLE

**Impact**: Screenshot cost drops from 200ms → 0ms (frame already captured). Combined with FAST region OCR: 0ms + 15ms = **15ms per slow cycle = 66 FPS theoretical** (capped by loop interval).

**Tradeoff**:
- Battery: ~5-10% higher drain during ACTIVE state (GPU encoding frames)
- Memory: ~20MB for frame buffers
- Complexity: Stream lifecycle management, error recovery on stream death
- Only useful during ACTIVE state — idle gating (Phase 3) prevents waste

**Files to modify/create**:
- `native/macos-bridge/Sources/VisionBridge.swift` — add SCStream capture mode
- `native/macos-bridge/Sources/StreamCapture.swift` — new file, SCStream delegate + ring buffer
- `src/perception/vision-source.ts` — add stream mode, switch between one-shot and stream
- `src/perception/coordinator.ts` — start/stop stream on state transitions

### Phase 5: YOLO Element Detection Fusion (1-2 Weeks)

**Change**: Run a CoreML YOLO model alongside OCR to detect non-text UI elements (icons, buttons, sliders, toggles, checkboxes).

```
Current:  OCR sees text only — misses ~40% of UI elements (icons, unlabeled buttons, toggles)
New:      OCR (text) + YOLO (visual elements) = ~85% UI element coverage
```

**Implementation**:
- Convert trained YOLOv8n to CoreML (.mlpackage, ~6MB)
- Add `vision.detectElements` bridge call — runs CoreML model on screenshot/frame
- Returns: `[{class: "button", confidence: 0.85, x, y, width, height}]`
- Fusion: match YOLO bounding boxes to nearest OCR text → labeled elements
  - YOLO says "button at (450, 200, 80, 30)" + OCR says "Submit at (460, 205)" → "Submit button"
  - YOLO says "icon at (50, 100, 24, 24)" + no nearby OCR text → "unknown icon at (50, 100)"
- Run YOLO in slow cycle alongside OCR (parallel, both ~60ms on different cores)

**16 YOLO classes** (training now):
```
link, button, input, select, textarea, label, checkbox, radio,
dropdown, slider, toggle, menu_item, clickable, icon, image, text
```

**Impact**: +60% more elements detected. Icons, unlabeled buttons, toggles, sliders all become visible. Canvas elements still invisible (YOLO trained on web UIs, not design canvases).

**Tradeoff**:
- CoreML inference: ~2-5ms on ANE (negligible)
- Model size: ~6MB in memory
- Fusion logic: ~5ms to match YOLO boxes to OCR text
- False positives: YOLO may detect canvas content as UI elements — mitigate by cross-checking with AX tree (if AX says nothing is there, demote confidence)

**Files to modify/create**:
- `native/macos-bridge/Sources/VisionBridge.swift` — add CoreML model loading + inference
- `native/macos-bridge/Resources/ui-elements.mlpackage` — trained model
- `src/perception/vision-source.ts` — add element detection call, run parallel with OCR
- `src/state/fusion.ts` — add YOLO+OCR matching logic
- `src/state/world-model.ts` — ingest YOLO-detected elements as controls with source="yolo"

---

## Decision Logic: When to Use What

### Source Selection Hierarchy

```
1. CDP connected?     → Use DOM. Skip everything else.      (99% reliable, <5ms)
2. AX tree available? → Use AX for controls.                 (90% reliable, 50-200ms)
                        Use OCR only for content AX misses.
3. App Map fresh?     → Use stored positions.                 (85% reliable, <1ms)
                        OCR to verify every 10th cycle.
4. None of above?     → Full OCR + YOLO.                     (40-60% reliable, 60-120ms)
```

### Activity-Based Mode Selection

```
┌─────────────────────────────────────────────────────────┐
│                    TOOL CALL ARRIVES                     │
│                          ↓                              │
│  Was perception IDLE?                                   │
│  ├─ YES → Run one ACCURATE OCR cycle first (260ms)      │
│  │        Then switch to ACTIVE mode                    │
│  └─ NO  → Already ACTIVE, world state is fresh          │
│                          ↓                              │
│  Is this a playbook/rapid workflow?                     │
│  ├─ YES → Start SCStream if not running                 │
│  │        Use FAST OCR on changed regions only          │
│  │        Expected: 15ms/cycle = 66 FPS                 │
│  └─ NO  → One-shot ACCURATE OCR for this action         │
│           Expected: 260ms (acceptable for single action) │
│                          ↓                              │
│  No tool call for 3 seconds?                            │
│  ├─ YES → Stop SCStream, enter IDLE                     │
│  └─ NO  → Stay ACTIVE                                  │
└─────────────────────────────────────────────────────────┘
```

### Per-Source Decision Matrix

| Condition | AX | CDP | OCR Mode | YOLO | SCStream | Map |
|-----------|:--:|:---:|:--------:|:----:|:--------:|:---:|
| Native app, ACTIVE | ON | — | FAST regions | ON | ON | Verify |
| Native app, ONE-SHOT | ON | — | ACCURATE full | — | — | Use |
| Native app, IDLE | OFF | — | OFF | OFF | OFF | Stale check |
| Browser app, CDP connected | OFF | ON | OFF | OFF | OFF | — |
| Browser app, no CDP | ON | retry | FAST regions | ON | ON | Verify |
| Electron app, CDP connected | OFF | ON | OFF | OFF | OFF | — |
| Electron app, no CDP | ON | retry | FAST regions | ON | ON | Verify |
| Unknown app, first visit | ON | probe | ACCURATE full | ON | ON | Learn |
| Canvas app (Figma/Canva) | ON* | probe | FAST regions | ON | ON | Learn |

*AX returns empty for canvas areas but still useful for menus/panels

---

## Implementation Priority & Timeline

| Phase | Change | Effort | FPS Gain | Dependencies |
|-------|--------|--------|----------|-------------|
| **1** | Dual-mode OCR (FAST/ACCURATE) | 2-3 hours | 1.2 → 3.8 FPS | None |
| **2** | Region-based OCR | 1-2 days | 3.8 → 14 FPS | Phase 1 |
| **3** | Idle gating | 1 day | ∞ at idle | None (parallel with 1-2) |
| **4** | SCStream continuous capture | 1 week | 14 → 66 FPS | Phase 1-3 |
| **5** | YOLO element detection | 1-2 weeks | Same FPS, +60% elements | Trained model (in progress) |

### Cumulative Performance

```
Current:    831ms/cycle →  1.2 FPS  →  40% element coverage (text only)
Phase 1:    260ms/cycle →  3.8 FPS  →  40% element coverage
Phase 2:     70ms/cycle → 14.0 FPS  →  40% element coverage
Phase 3:      0ms idle  → 14.0 FPS  →  40% element coverage + zero idle cost
Phase 4:     15ms/cycle → 66.0 FPS  →  40% element coverage
Phase 5:     20ms/cycle → 50.0 FPS  →  85% element coverage (text + visual)
```

---

## Cost & Resource Impact

| Resource | Current | After All Phases | Notes |
|----------|---------|-----------------|-------|
| CPU (active) | ~15% single core | ~8% (less OCR work) | Region OCR + idle gating saves CPU |
| CPU (idle) | ~15% single core | ~0% | Idle gating eliminates polling |
| GPU (active) | Minimal | ~5% (SCStream + CoreML) | ANE handles YOLO, GPU handles stream |
| GPU (idle) | Minimal | 0% | Stream stopped at idle |
| Memory | ~50MB | ~80MB | +20MB frame buffers, +6MB YOLO model |
| Battery (active) | Moderate | Similar (faster but more processing) | Tradeoff: faster cycles but more per cycle |
| Battery (idle) | Moderate | ~Zero | Biggest win: no perception at idle |
| Disk | 0 | ~6MB | YOLO CoreML model |

---

## Verification Criteria

### Phase 1
- [ ] `npm run check` passes
- [ ] `npm test` — all existing tests pass
- [ ] Benchmark: perception slow cycle < 300ms with FAST mode
- [ ] `ocr` tool still uses ACCURATE mode (verify via tool output quality)
- [ ] `click_text` still uses ACCURATE mode (verify click accuracy unchanged)

### Phase 2
- [ ] Region OCR produces same text elements as full OCR (within 90%)
- [ ] Slow cycle < 100ms when <30% of screen changed
- [ ] No regressions in dialog detection or entity tracking

### Phase 3
- [ ] Zero CPU from perception after 3s idle (verify via Activity Monitor)
- [ ] First tool call after idle completes within 500ms
- [ ] World state is fresh (confidence > 0.8) after wake cycle

### Phase 4
- [ ] SCStream delivers frames at 30+ FPS
- [ ] Stream starts/stops cleanly on state transitions
- [ ] No frame leaks (memory stable over 10-minute session)
- [ ] Graceful fallback to one-shot if stream fails

### Phase 5
- [ ] YOLO detects buttons, icons, toggles on 3+ test apps
- [ ] Fusion correctly labels: "Submit button", "Settings icon"
- [ ] False positive rate < 15% on non-UI canvas areas
- [ ] Total slow cycle < 25ms (OCR + YOLO parallel)

---

## Risk & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| FAST OCR misses critical text | Medium | Tool fails to find element | ACCURATE mode for tool actions (Phase 1 design) |
| Region diff misses small changes | Low | Stale control in world model | Pad ROIs +64px, full OCR every 10th cycle |
| SCStream crashes mid-session | Low | No frames until restart | Auto-detect stream death, fallback to one-shot |
| YOLO false positives on canvas | High | Phantom controls in world model | Cross-check with AX tree, demote confidence |
| Battery drain during long sessions | Medium | User complaint | Idle gating (Phase 3) is the primary defense |
| CoreML model loading time | Low | Slow first inference | Pre-load model at perception start, lazy init |

---

## What This Does NOT Solve

- **Canvas element interaction** — YOLO finds bounding boxes but can't name canvas objects (layers, shapes, text in design). Only Plugin API (Figma) or CDP (Chrome) can access canvas semantics.
- **Drag-and-drop without feedback** — knowing where an element is doesn't tell you where to drop it. Needs semantic app knowledge.
- **100% element detection** — Even OCR + YOLO caps at ~85%. The remaining 15% are custom-rendered widgets, animations, video content.
- **Cross-app state** — World model is per-window. Multi-app workflows (copy from Figma → paste in Notion) need higher-level orchestration.
- **App updates** — When an app updates its UI, stored maps become stale. Stale detection + partial re-learn handles this, but there's always a gap.
