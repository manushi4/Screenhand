# ScreenHand — Progressive Validation Plan

> Architect spec. A tester implements scripts from this.
> 5 levels. L1 = guaranteed. L5 = autonomous expert.
> Each level gates the next. Every call is a real MCP tool against a real app.

---

## Benchmark Data Schema

Every single MCP tool call across all levels MUST be recorded in this format. No exceptions.

### Per-Call Record

```typescript
interface ToolCallRecord {
  // Identity
  id: string;                          // UUID
  testId: string;                      // "L1-1.3" — level + case number
  level: 1 | 2 | 3 | 4 | 5;

  // What was called
  tool: string;                        // "focus", "ocr", "plan_goal"
  params: Record<string, unknown>;     // exact params sent

  // Timing
  startedAt: string;                   // ISO timestamp
  finishedAt: string;                  // ISO timestamp
  durationMs: number;                  // wall clock

  // Result
  success: boolean;                    // tool returned without error
  resultBytes: number;                 // response payload size
  resultPreview: string;               // first 500 chars of text content
  errorMessage?: string;               // if failed

  // Context
  targetApp: string;                   // bundleId or "none"
  toolGroup: string;                   // "desktop" | "browser" | "fallback" | "memory" | "planner" | "perception" | "recovery" | "learning" | "ingestion" | "community"
  usedIntelligenceWrapper: boolean;    // server.tool (true) vs originalTool (false)

  // Layer tracking
  layersTouched: number[];             // [1], [1,2], [1,2,3,4] etc.
  llmCallMade: boolean;               // did this trigger an LLM call (planner fallback)
}
```

### Per-Test Record

```typescript
interface TestRecord {
  testId: string;                      // "L1-1.3"
  level: 1 | 2 | 3 | 4 | 5;
  name: string;                        // human description
  app: string;                         // bundleId

  // Verdict
  passed: boolean;
  passReason: string;                  // what was checked
  failReason?: string;                 // why it failed

  // Aggregated from tool calls
  toolCalls: ToolCallRecord[];
  totalDurationMs: number;             // sum of all calls
  totalToolCalls: number;
  llmCalls: number;                    // count of calls where llmCallMade=true

  // For L5 convergence tracking
  runNumber?: number;                  // which iteration (1-10)
}
```

### Per-Level Report

```typescript
interface LevelReport {
  level: 1 | 2 | 3 | 4 | 5;
  timestamp: string;
  machineMeta: {
    os: string;                        // "macOS 15.3"
    chip: string;                      // "Apple M2"
    ram: string;                       // "16GB"
    nodeVersion: string;
    screenhandVersion: string;         // git SHA
  };

  // Results
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;                    // 0.0 - 1.0
  gatePass: boolean;                   // passRate >= required threshold

  tests: TestRecord[];

  // Benchmark aggregates
  benchmark: {
    // Per-tool latency
    toolLatency: Record<string, {
      count: number;
      avgMs: number;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      minMs: number;
    }>;

    // Per-app latency
    appLatency: Record<string, {
      avgMs: number;
      totalMs: number;
      toolCalls: number;
    }>;

    // Per-tool-group latency
    groupLatency: Record<string, {
      avgMs: number;
      totalMs: number;
      toolCalls: number;
      successRate: number;
    }>;

    // Overall
    totalDurationMs: number;
    totalToolCalls: number;
    totalLlmCalls: number;
    avgCallMs: number;

    // Layer-specific (populated at relevant levels)
    referenceLoadTimeMs?: number;           // L2: time to load reference on context switch
    worldStateAccuracy?: number;            // L3: % of state assertions that matched reality
    dialogDetectionLatencyMs?: number;      // L3: time from dialog appear to detection
    planGenerationMs?: number;              // L4: time to generate plan from goal
    recoveryLatencyMs?: number;             // L4: time from blocker to recovery complete
    convergenceRatio?: number;              // L5: run_N time / run_1 time (< 1.0 = improvement)
  };
}
```

### Full Run Report

```typescript
interface FullRunReport {
  runId: string;                       // UUID
  timestamp: string;
  machineMeta: LevelReport["machineMeta"];
  levels: LevelReport[];

  // Cross-level
  highestPassedLevel: number;          // 1-5 (highest level where gatePass=true)
  totalTests: number;
  totalPassed: number;
  totalToolCalls: number;
  totalDurationMs: number;

  // Product scorecard
  scorecard: {
    controlReliability: number;        // L1 pass rate
    knowledgeAccuracy: number;         // L2 pass rate
    awarenessAccuracy: number;         // L3 pass rate
    autonomyCapability: number;        // L4 pass rate
    expertLevel: number;               // L5 pass rate
    overallScore: number;              // weighted: L1*0.3 + L2*0.25 + L3*0.2 + L4*0.15 + L5*0.1
  };
}
```

### Storage

```
tests/results/
  runs/
    {runId}.json                       — FullRunReport
  levels/
    L1-{timestamp}.json                — LevelReport (can run levels independently)
    L2-{timestamp}.json
    ...
  calls/
    {runId}-calls.jsonl                — every ToolCallRecord, one per line (for bulk analysis)
  summary.json                         — latest scorecard + historical trend (last 20 runs)
```

---

## Gate Thresholds

| Level | Pass Rate Required | Must Also |
|-------|-------------------|-----------|
| L1 | 100% | Avg tool latency < 500ms (excl. launch) |
| L2 | 95% | All references load successfully |
| L3 | 90% | Dialog detection latency < 1000ms |
| L4 | 85% | At least 1 goal executes with 0 LLM calls |
| L5 | 75% | Convergence ratio < 0.85 (15%+ faster by run 5) |

If a level fails its gate, the run stops. Higher levels are not attempted.

---

## Level 1: Raw Control

**Proving:** Layer 1 only. Native bridge works. Every tool causes the expected real-world state change.

**Pass bar:** 100%. Any failure = broken foundation. Do not proceed to L2.

**Verification rule:** NO OCR for verification unless there is no AX/AppleScript path. Every mutating test must capture state BEFORE the action and assert a DELTA after. "Tool didn't throw" is NOT a pass.

**Verification methods by app:**

| App | Primary verification | How |
|-----|---------------------|-----|
| Finder | `windows` (titles, count), `applescript`, `ui_find` | `windows` returns exact titles; AppleScript returns Finder properties |
| TextEdit | `applescript('tell app "TextEdit" to get text of front document')` | Returns exact document text content |
| Notes | `applescript('tell app "Notes" to get body of first note')` | Returns exact note body as text |
| Safari | `applescript('tell app "Safari" to get {URL, name} of current tab of front window')` | Returns exact URL and page title |
| System Settings | `ui_find`, `ui_tree` | AX tree gives exact elements with roles and titles |

**Cleanup rule:** Every test that creates state (opens windows, types text, creates notes) MUST clean up after itself so later tests don't inherit stale state. Cleanup failures are logged but do not fail the test.

---

### Finder (`com.apple.finder`)

#### 1.1 — List running apps

```
CALL:   apps()
VERIFY: Response text contains "com.apple.finder" AND contains "pid"
WHY:    Proves bridge can enumerate running processes
```

#### 1.2 — Focus Finder

```
BEFORE: apps() → note which app is currently frontmost (may not be Finder)
CALL:   focus(bundleId: "com.apple.finder")
AFTER:  applescript('tell app "System Events" to get bundle identifier of first process whose frontmost is true')
VERIFY: Returns "com.apple.finder"
WHY:    Proves focus actually changed the frontmost app, not just returned success
```

#### 1.3 — List windows

```
CALL:   windows(bundleId: "com.apple.finder")
VERIFY: Response contains at least 1 window object with a non-empty "title" field
WHY:    Proves bridge can read AX window list
```

#### 1.4 — Screenshot

```
CALL:   screenshot()
VERIFY: Response contains base64 image data OR image content block. Payload size > 10000 bytes.
WHY:    Proves CoreGraphics capture works. This is the ONE test where we check raw image output.
```

#### 1.5 — UI tree

```
CALL:   ui_tree(pid: <finder_pid from 1.1>, maxDepth: 3)
VERIFY: Response contains "AXApplication" AND at least one child with role "AXWindow"
WHY:    Proves AX tree traversal works
```

#### 1.6 — Find element by role

```
CALL:   ui_find(pid: <finder_pid>, role: "AXToolbar")
VERIFY: Returns at least 1 match with bounds (x, y, width, height all present)
WHY:    Proves AX element search works and returns actionable data
```

#### 1.7 — Open new window (state delta)

```
BEFORE: windows(bundleId: "com.apple.finder") → store count as N
CALL:   key(combo: "cmd+n")
WAIT:   500ms
AFTER:  windows(bundleId: "com.apple.finder") → store count as M
VERIFY: M === N + 1
WHY:    Proves keyboard shortcut executed AND caused real window creation
CLEANUP: key(combo: "cmd+w") to close the window we opened
```

#### 1.8 — Close window (state delta)

```
SETUP:  key(combo: "cmd+n") → wait 300ms (ensure we have a window to close)
BEFORE: windows(bundleId: "com.apple.finder") → store count as N
CALL:   key(combo: "cmd+w")
WAIT:   500ms
AFTER:  windows(bundleId: "com.apple.finder") → store count as M
VERIFY: M === N - 1
WHY:    Proves close shortcut executed AND window actually disappeared
```

#### 1.9 — Menu click changes window location

```
BEFORE: windows(bundleId: "com.apple.finder") → store front window title as T1
CALL:   menu_click(bundleId: "com.apple.finder", menuPath: ["Go", "Home"])
WAIT:   500ms
AFTER:  windows(bundleId: "com.apple.finder") → store front window title as T2
VERIFY: T2 contains the home folder name (os.homedir() basename) OR T2 !== T1
WHY:    Proves menu_click executed a real menu action and the window navigated
```

#### 1.10 — AppleScript read Finder selection

```
CALL:   applescript(script: 'tell app "Finder" to get name of front Finder window')
VERIFY: Returns a non-empty string (the window name)
WHY:    Proves AppleScript execution works and returns real data from Finder
```

---

### TextEdit (`com.apple.TextEdit`)

#### 2.1 — Launch TextEdit

```
BEFORE: apps() → confirm "com.apple.TextEdit" is NOT in the list (or note if it is)
CALL:   launch(bundleId: "com.apple.TextEdit")
WAIT:   1000ms
AFTER:  apps() → confirm "com.apple.TextEdit" IS in the list
VERIFY: TextEdit appears in app list after launch
WHY:    Proves launch actually started the app, not just returned success
```

#### 2.2 — Type text into document (state delta)

```
SETUP:  focus(bundleId: "com.apple.TextEdit")
        key(combo: "cmd+n") → wait 500ms (fresh document)
BEFORE: applescript('tell app "TextEdit" to get text of front document') → store as T1
        T1 should be empty string "" or "\n"
CALL:   type_text(text: "Hello ScreenHand 12345")
WAIT:   300ms
AFTER:  applescript('tell app "TextEdit" to get text of front document') → store as T2
VERIFY: T2 contains "Hello ScreenHand 12345" AND T1 did NOT contain it
WHY:    AppleScript gives exact document text. Delta proves type_text actually inserted characters.
```

#### 2.3 — Select all (AX verification)

```
BEFORE: applescript('tell app "TextEdit" to get text of front document') → confirm has text from 2.2
CALL:   key(combo: "cmd+a")
WAIT:   200ms
VERIFY: No error. (Selection state is not directly readable via AppleScript, but the next test depends on it.)
WHY:    Setup for 2.4. Selection itself is verified by 2.4's delete succeeding.
```

#### 2.4 — Delete selected text (state delta)

```
BEFORE: applescript('tell app "TextEdit" to get text of front document') → store as T1
        T1 must contain "Hello ScreenHand 12345"
CALL:   key(combo: "delete")
WAIT:   200ms
AFTER:  applescript('tell app "TextEdit" to get text of front document') → store as T2
VERIFY: T2 does NOT contain "Hello ScreenHand 12345" AND T2.length < T1.length
WHY:    Proves select-all + delete actually cleared the document
```

#### 2.5 — Undo restores text (state delta)

```
BEFORE: applescript('tell app "TextEdit" to get text of front document') → store as T1 (should be empty from 2.4)
CALL:   key(combo: "cmd+z")
WAIT:   200ms
AFTER:  applescript('tell app "TextEdit" to get text of front document') → store as T2
VERIFY: T2 contains "Hello ScreenHand 12345" (undo restored the deleted text)
WHY:    Proves undo shortcut works. More useful than testing bold (which AppleScript can't verify).
CLEANUP: key(combo: "cmd+w") then key(combo: "cmd+d") to close without save.
         Then: apps() to verify TextEdit still running (closing doc ≠ quitting app).
```

---

### Notes (`com.apple.Notes`)

#### 3.1 — Launch Notes

```
BEFORE: apps() → note presence of "com.apple.Notes"
CALL:   launch(bundleId: "com.apple.Notes")
WAIT:   1500ms (Notes is slow to launch)
AFTER:  apps()
VERIFY: "com.apple.Notes" in app list
```

#### 3.2 — Create new note (state delta)

```
SETUP:  focus(bundleId: "com.apple.Notes")
BEFORE: applescript('tell app "Notes" to get count of notes in first account') → store as N
CALL:   key(combo: "cmd+n")
WAIT:   800ms
AFTER:  applescript('tell app "Notes" to get count of notes in first account') → store as M
VERIFY: M >= N (note count did not decrease; may equal N if a blank note was already pending)
WHY:    AppleScript gives exact note count
```

#### 3.3 — Type into note (state delta)

```
BEFORE: applescript('tell app "Notes" to get body of first note') → store as T1
CALL:   type_text(text: "ScreenHand test 98765")
WAIT:   500ms
AFTER:  applescript('tell app "Notes" to get body of first note') → store as T2
VERIFY: T2 contains "ScreenHand test 98765" AND T1 did NOT contain it
WHY:    Exact text match via AppleScript. Delta proves typing landed in the note, not elsewhere.
```

#### 3.4 — Read note content back via ui_find

```
CALL:   ui_find(pid: <notes_pid>, role: "AXTextArea")
VERIFY: Returns at least 1 text area element (the note body)
WHY:    Proves AX can find the editable area — cross-validates with AppleScript result
```

#### 3.5 — Delete the test note (cleanup + state delta)

```
BEFORE: applescript('tell app "Notes" to get count of notes in first account') → store as N
CALL:   applescript('tell app "Notes" to delete first note')
WAIT:   500ms
AFTER:  applescript('tell app "Notes" to get count of notes in first account') → store as M
VERIFY: M === N - 1
WHY:    Proves AppleScript can mutate app state. Also cleans up test data.
        If this fails (Notes may show confirmation), log warning but don't fail the test.
```

---

### Safari (`com.apple.Safari`)

#### 4.1 — Launch Safari

```
BEFORE: apps()
CALL:   launch(bundleId: "com.apple.Safari")
WAIT:   1500ms
AFTER:  apps()
VERIFY: "com.apple.Safari" in app list
```

#### 4.2 — Reset to blank page first

```
SETUP:  focus(bundleId: "com.apple.Safari")
CALL:   applescript('tell app "Safari" to set URL of current tab of front window to "about:blank"')
WAIT:   500ms
AFTER:  applescript('tell app "Safari" to get URL of current tab of front window') → store as URL_BEFORE
VERIFY: URL_BEFORE is "about:blank" or empty
WHY:    CRITICAL — resets Safari so we can prove navigation actually changes state.
        Without this, Safari may already be on example.com from a prior run.
```

#### 4.3 — Navigate via keyboard (state delta)

```
BEFORE: applescript('tell app "Safari" to get URL of current tab of front window') → must be "about:blank"
CALL:   key(combo: "cmd+l") → wait 200ms → type_text(text: "https://example.com") → key(combo: "return")
WAIT:   2000ms (page load)
AFTER:  applescript('tell app "Safari" to get URL of current tab of front window') → store as URL_AFTER
VERIFY: URL_AFTER contains "example.com" AND URL_BEFORE did NOT
WHY:    Delta proves navigation happened via keyboard, not pre-existing state
```

#### 4.4 — Read page title via AppleScript

```
CALL:   applescript('tell app "Safari" to get name of front window')
VERIFY: Contains "Example Domain"
WHY:    Proves page loaded completely (title is set after page renders)
```

#### 4.5 — Navigate to second page (state delta)

```
BEFORE: applescript('tell app "Safari" to get URL of current tab of front window') → store as URL1 (example.com)
CALL:   key(combo: "cmd+l") → wait 200ms → type_text(text: "https://httpbin.org/html") → key(combo: "return")
WAIT:   2000ms
AFTER:  applescript('tell app "Safari" to get URL of current tab of front window') → store as URL2
VERIFY: URL2 contains "httpbin.org" AND URL2 !== URL1
WHY:    Proves we can navigate to multiple destinations, not just one lucky shot
```

#### 4.6 — New tab (state delta)

```
BEFORE: applescript('tell app "Safari" to get count of tabs of front window') → store as N
CALL:   key(combo: "cmd+t")
WAIT:   500ms
AFTER:  applescript('tell app "Safari" to get count of tabs of front window') → store as M
VERIFY: M === N + 1
WHY:    Proves tab creation via keyboard
CLEANUP: key(combo: "cmd+w") to close the tab
```

---

### System Settings (`com.apple.systempreferences`)

#### 5.1 — Launch System Settings

```
BEFORE: apps()
CALL:   launch(bundleId: "com.apple.systempreferences")
WAIT:   1500ms
AFTER:  apps()
VERIFY: "com.apple.systempreferences" in app list
```

#### 5.2 — UI tree has correct structure

```
SETUP:  focus(bundleId: "com.apple.systempreferences")
CALL:   ui_tree(pid: <settings_pid>, maxDepth: 4)
VERIFY: Response contains "AXWindow" AND at least one of: "AXButton", "AXStaticText", "AXGroup"
WHY:    Proves AX tree traversal works on a complex app
```

#### 5.3 — Find specific element

```
CALL:   ui_find(pid: <settings_pid>, role: "AXStaticText", title: "General")
VERIFY: Returns at least 1 match with bounds (x > 0, y > 0, width > 0, height > 0)
WHY:    Proves element search finds real clickable targets with real positions
NOTE:   If "General" not found, try "Wi-Fi" or "Appearance" — System Settings layout varies by macOS version.
        Test should try a list of known labels and pass if ANY match.
```

#### 5.4 — Click element via ui_press

```
BEFORE: applescript('tell app "System Events" to get name of front window of process "System Settings"') → store as T1
CALL:   ui_press(pid: <settings_pid>, title: "General")
        OR click on the element found in 5.3
WAIT:   800ms
AFTER:  applescript('tell app "System Events" to get name of front window of process "System Settings"') → store as T2
VERIFY: T2 !== T1 OR T2 contains "General"
WHY:    Proves ui_press actually activates a control and the UI responded
NOTE:   May not change window title on all macOS versions. If titles match,
        fall back to: ui_tree and check if a new pane loaded (different child elements).
```

#### 5.5 — Navigate back

```
CALL:   key(combo: "cmd+[") OR ui_press on back button
WAIT:   500ms
VERIFY: ui_tree shows top-level settings list again (has multiple AXStaticText children like "General", "Wi-Fi")
WHY:    Proves navigation within the app works
CLEANUP: key(combo: "cmd+w") to close System Settings, or leave it (harmless)
```

---

### L1 Verification Method Summary

| Tool | How we verify it worked | NOT acceptable |
|------|------------------------|----------------|
| `focus` | AppleScript: frontmost app changed | "No error returned" |
| `launch` | `apps()` before/after delta | "No error returned" |
| `key` (shortcut) | `windows` count delta, or AppleScript state delta | "No error returned" |
| `type_text` | AppleScript: document text contains typed string (before/after) | OCR |
| `menu_click` | `windows` title changed, or AppleScript state | "No error returned" |
| `ui_tree` | Response contains expected AX roles | "Non-empty response" |
| `ui_find` | Returns matches with real bounds | "Non-empty response" |
| `ui_press` | State change detectable via AppleScript or ui_tree | "No error returned" |
| `screenshot` | Payload size > 10KB (only test — visual output) | N/A |
| `applescript` | Returns expected data type and content | "No error returned" |
| `windows` | Returns window objects with titles | "Non-empty response" |
| `apps` | Returns app objects with bundleId and pid | "Non-empty response" |

### L1 Benchmark Targets

| Tool | Target Latency | Notes |
|------|---------------|-------|
| `apps` | < 200ms | Listing only |
| `focus` | < 300ms | AX focus change |
| `windows` | < 200ms | AX window enumeration |
| `screenshot` | < 800ms | CoreGraphics capture |
| `ui_tree` | < 500ms | AX tree traversal depth 3-4 |
| `ui_find` | < 500ms | AX element search |
| `ui_press` | < 300ms | AX action execution |
| `key` | < 150ms | CoreGraphics key event |
| `type_text` | < 300ms | CoreGraphics text input |
| `menu_click` | < 500ms | AX menu traversal + click |
| `launch` | < 5000ms | App launch (cold start) |
| `applescript` | < 2000ms | Script execution (varies by script) |

### L1 Totals

| Metric | Target |
|--------|--------|
| Total test cases | 31 |
| Pass rate required | 100% |
| Avg tool latency (excl. launch) | < 500ms |
| Total LLM calls | 0 |
| OCR calls for verification | 0 (screenshot payload size check only) |
| Apps tested | 5 (all pre-installed, zero setup) |

---

## Level 2: Tool Knowledge + Context

**Proving:** Layer 2. References load. Intelligence wrapper fires hints. Selectors work. Memory records.

**Pass bar:** 95%.

### Safari → example.com (Context Tracker)

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 6.1 | Navigate | L1 Safari flow | Page loads |
| 6.2 | Wrapper fires | `click_text("More information...")` | Response contains hints/strategy text from wrapper |
| 6.3 | Memory recorded | `memory_recall(query:"example.com")` | Returns recent action |
| 6.4 | Error recorded on miss | `memory_errors(platform:"safari")` | Returns entries (may include the click attempt) |

### Canva in Chrome (CDP + Reference)

**Prereq:** Chrome with `--remote-debugging-port=9222`, Canva open.

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 7.1 | Navigate | `browser_navigate(url:"https://www.canva.com")` | Success |
| 7.2 | Reference loaded | `platform_guide(query:"canva")` | Non-empty guide with selectors/shortcuts |
| 7.3 | Selector test | `browser_dom(selector:"[aria-label='Search']")` | Returns element or specific not-found |
| 7.4 | Shortcut | `key(["cmd","n"])` | Context tracker records outcome |
| 7.5 | Playbook preflight | `playbook_preflight(playbookId:"canva-screenhand-carousel")` | Returns preflight result |
| 7.6 | Error patterns | `memory_errors(platform:"canva")` | Returns known patterns or empty |

### DaVinci Resolve (AX + Rich Reference)

**Prereq:** DaVinci Resolve open.

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 8.1 | Focus | `focus(bundleId:"com.blackmagic-design.DaVinciResolveLite")` | Success |
| 8.2 | Reference | `platform_guide(query:"davinci resolve")` | Returns shortcuts, menu paths |
| 8.3 | Menu scan | `scan_menu_bar(bundleId:...)` | Returns menu structure with items |
| 8.4 | Known shortcut | `key(["shift","5"])` | No error (Deliver page) |
| 8.5 | Playbook preflight | `playbook_preflight(playbookId:"davinci-render")` | Preflight result |
| 8.6 | Coverage | `coverage_report(bundleId:...)` | Coverage % returned |

### Finder (Selector Learning)

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 9.1 | Fallback click | `click_with_fallback(target:"Go", bundleId:"com.apple.finder")` | Succeeds via AX or OCR |
| 9.2 | Pattern learned | `memory_query_patterns(platform:"finder")` | >= 1 pattern |
| 9.3 | Repeat click | Same as 9.1 | Succeeds, wrapper shows hint from prior success |
| 9.4 | Strategy recall | `memory_recall(query:"finder click")` | Returns strategy |

### L2 Benchmark Targets

| Metric | Target |
|--------|--------|
| Reference load on context switch | < 100ms |
| `platform_guide` | < 300ms |
| `playbook_preflight` | < 500ms |
| `scan_menu_bar` | < 3000ms |
| `coverage_report` | < 2000ms |
| `memory_recall` | < 200ms |
| `memory_errors` | < 200ms |
| `click_with_fallback` | < 2000ms |
| Intelligence wrapper overhead per call | < 50ms |

---

## Level 3: Awareness + Perception

**Proving:** Layers 3a+3b. World model tracks state. Perception detects changes. Dialogs caught.

**Pass bar:** 90%.

### Finder (World Model)

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 10.1 | Start perception | `perception_start` | Running status |
| 10.2 | Baseline state | `world_state` | Finder focused, windows listed, controls > 0 |
| 10.3 | Open window → state update | `key(["cmd","n"])` → 500ms → `world_state` | Window count +1 |
| 10.4 | Close window → state update | `key(["cmd","w"])` → 500ms → `world_state` | Window count -1 |
| 10.5 | Persistence | `perception_stop` → `world_state` | State still available |

### Safari (Perception + Navigation)

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 11.1 | Perception on Safari | Focus Safari → `perception_start` | Running, detects browser |
| 11.2 | Navigate | Address bar → type URL → enter → 2s wait | No error |
| 11.3 | State shows page | `world_state` | Window title reflects page |
| 11.4 | Navigate again | Different URL → 2s wait | No error |
| 11.5 | State updated | `world_state` | Title changed |
| 11.6 | Stale check | `world_state_diff(staleThresholdMs:30000)` | Returns stale list or empty |
| 11.7 | Stats | `perception_status` | Cycle counts > 0, low errors |

### Cross-App State

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 12.1 | Finder focused | `focus("com.apple.finder")` → `world_state` | Finder is active |
| 12.2 | Switch TextEdit | `focus("com.apple.TextEdit")` → 500ms → `world_state` | TextEdit active, Finder windows retained |
| 12.3 | Switch Safari | `focus("com.apple.Safari")` → 500ms → `world_state` | Safari active, all apps tracked |
| 12.4 | Verbose state | `world_state(verbose:true)` | Windows from all 3 apps |
| 12.5 | Perception stable | `perception_status` | No crash, adapted context |

### Dialog Detection

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 13.1 | Trigger Save dialog | TextEdit: type → `key(["cmd","w"])` | Dialog appears |
| 13.2 | Dialog in world state | `world_state` | `dialogs` non-empty, "Save" detected |
| 13.3 | Dismiss | `key(["cmd","d"])` or `click_text("Don't Save")` | Dismissed |
| 13.4 | State cleared | `world_state` | `dialogs` empty |

### L3 Benchmark Targets

| Metric | Target |
|--------|--------|
| `perception_start` | < 500ms |
| `world_state` | < 200ms |
| `world_state_diff` | < 200ms |
| `perception_status` | < 100ms |
| Window open → state reflects it | < 1000ms |
| Window close → state reflects it | < 1000ms |
| App switch → state reflects it | < 500ms |
| Dialog appear → detected in state | < 1000ms |
| Dialog dismiss → cleared from state | < 500ms |
| Perception fast loop (AX events) | ~100ms cycle |
| Perception medium loop (AX poll) | ~500ms cycle |
| Perception slow loop (vision) | ~2000ms cycle |

---

## Level 4: Autonomy + Recovery

**Proving:** Layers 4a+4b. Planner generates plans. Executor runs them. Recovery handles blockers.

**Pass bar:** 85%.

### Plan Generation

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 14.1 | Playbook goal | `plan_goal(goal:"Render in DaVinci Resolve", bundleId:...)` | source="playbook", confidence > 0.7 |
| 14.2 | Reference goal | `plan_goal(goal:"Navigate to Home in Finder", bundleId:"com.apple.finder")` | Returns steps, source="reference" or "strategy" |
| 14.3 | Novel goal | `plan_goal(goal:"Create folder test-screenhand on Desktop", bundleId:"com.apple.finder")` | Returns plan (may be LLM), has steps |
| 14.4 | Multi-step decomposition | `plan_goal(goal:"Open Safari and navigate to example.com; then take a screenshot")` | 2+ subgoals |

### Plan Execution

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 15.1 | Finder workflow | `plan_goal` → `plan_execute` | Steps execute, new window at Home |
| 15.2 | TextEdit workflow | `plan_goal("Open TextEdit, type 'Autonomy test', select all")` → `plan_execute` | OCR confirms text |
| 15.3 | Execution trace | `plan_status(goalId)` | Shows completed steps with timing |
| 15.4 | Strategy saved | `memory_recall(query:"finder new window")` | Strategy from successful run |

### Recovery

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 16.1 | Save dialog recovery | TextEdit: type → `plan_goal("Close TextEdit")` → `plan_execute` | Save dialog auto-dismissed, TextEdit closes |
| 16.2 | Permission dialog | Safari: trigger location permission → recovery | Dialog dismissed |
| 16.3 | Focus loss | Start Finder plan → activate another app mid-plan | Refocuses, resumes |
| 16.4 | Recovery status | `recovery_status` | Shows engine active, cooldowns, cache |

### Deterministic (0 LLM)

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 17.1 | Playbook execution | `plan_goal` (playbook source) → `plan_execute` | plan_status shows llmCalls=0 |
| 17.2 | Strategy reuse | Repeat 15.1 | Uses saved strategy, 0 LLM |
| 17.3 | Speed comparison | Compare 17.2 timing vs 15.1 | 17.2 faster |
| 17.4 | Replan on failure | Execute with bad postcondition | Replan triggered, alternative attempted |

### L4 Benchmark Targets

| Metric | Target |
|--------|--------|
| `plan_goal` (playbook match) | < 200ms |
| `plan_goal` (reference match) | < 500ms |
| `plan_goal` (LLM fallback) | < 5000ms |
| `plan_execute` per step | < 1000ms |
| Full 5-step plan execution | < 6000ms |
| Recovery: dialog detection to dismissal | < 2000ms |
| Recovery: focus loss to refocus | < 1500ms |
| Replan latency | < 3000ms |
| Deterministic plan: LLM calls | 0 |

---

## Level 5: Expert Autonomy

**Proving:** Full stack. Learning converges. Multi-app orchestration. Expert-level.

**Pass bar:** 75%.

### Learning Convergence

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 18.1 | Baseline (run 1) | "Open Finder, new window, navigate Home, close window" | Record time T1 |
| 18.2 | Learning after run 1 | `learning_status(bundleId:"com.apple.finder")` | Timing samples, locator prefs recorded |
| 18.3 | Runs 2-5 | Repeat 18.1 four times | Each recorded with runNumber |
| 18.4 | Convergence | Compare T5 vs T1 | T5 < T1 * 0.85 (15%+ faster) |
| 18.5 | Adaptive budgets | `learning_status` | Budgets reflect observed timings |
| 18.6 | Locator prefs | `learning_status` | Ranked by success rate |

### Multi-App Orchestration

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 19.1 | Sequential | `plan_goal("Open TextEdit, type 'Hello', then switch to Finder, new window")` → `plan_execute` | Both apps operated, world model tracks both |
| 19.2 | Recovery mid-orchestration | Inject dialog during multi-app plan | Handled, correct app resumed |

### Expert Workflows

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 20.1 | Research flow | Plan: Safari → example.com → OCR title → httpbin.org/html → OCR title | Both titles extracted in result |
| 20.2 | Live ingestion | `scan_menu_bar("com.apple.TextEdit")` → `coverage_report(...)` | Shortcuts extracted, coverage calculated |

### Resilience

| ID | Test | Tools | Pass When |
|----|------|-------|-----------|
| 21.1 | Session persistence | Mid-plan → `perception_stop` → `perception_start` → continue | Resumes, state reloaded |
| 21.2 | Stale detection | Wait 60s → `world_state_diff(staleThresholdMs:30000)` | Reports stale controls |

### L5 Benchmark Targets

| Metric | Target |
|--------|--------|
| Convergence ratio (T5/T1) | < 0.85 |
| Multi-app plan execution | < 15000ms for 2-app workflow |
| Session resume latency | < 1000ms |
| Learning engine save | < 100ms |
| Full expert workflow (10 steps) | < 10000ms |
| Novel workflow success rate | >= 60% |

---

## Execution Rules

```
L1  ──100%──▸  L2  ──95%──▸  L3  ──90%──▸  L4  ──85%──▸  L5  ──75%──▸  DONE
    STOP if gate fails. Fix. Rerun.
```

**App prerequisites by level:**

| Level | Required (pre-installed) | Optional (needs install) |
|-------|-------------------------|-------------------------|
| L1 | Finder, TextEdit, Notes, Safari, System Settings | — |
| L2 | Safari, Finder | Chrome+Canva, DaVinci Resolve |
| L3 | Finder, TextEdit, Safari | — |
| L4 | Finder, TextEdit, Safari | DaVinci Resolve |
| L5 | Finder, TextEdit, Safari | — |

**L1-L3 and L5 run on any stock Mac. Zero installs.**

---

## What This Does NOT Cover

- Tier 3 workspace ops (timeline, canvas) — OCR+coordinates, separate plan
- Windows — macOS only
- CDP/Electron beyond Canva — needs Codex Desktop, etc.
- Load/stress testing — this is functional + benchmark
- Community remote publishing — needs server
- Multi-agent parallel orchestration — separate validation
- Browser-specific tests (Chrome vs Safari CDP) — separate plan
