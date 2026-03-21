# L3 Real-App Capability Validation — Findings

**Layer**: L3 (Electron hybrid, real desktop apps, capability-level proof)
**Platform**: macOS
**Started**: 2026-03-19
**Status**: IN PROGRESS

---

## Summary

| Capability | Tasks Done | Tasks Total | Pass Rate | Status |
|-----------|-----------|-------------|-----------|--------|
| C1 Electron Hybrid Control | 2 | 5 | — | IN PROGRESS |
| C2 Dynamic Element Discovery | 0 | 5 | — | NOT STARTED |
| C3 Cross-App Data Flow | 0 | 5 | — | NOT STARTED |
| C4 Async State Verification | 0 | 5 | — | NOT STARTED |
| C5 Non-Frontmost Interaction | 0 | 5 | — | NOT STARTED |
| C6 Self-Healing Under UI Change | 0 | 5 | — | NOT STARTED |
| C7 Notification/Badge Detection | 0 | 5 | — | NOT STARTED |
| C8 Menu Bar / System Dialog | 0 | 5 | — | NOT STARTED |
| C9 Performance Under Real Weight | 0 | 5 | — | NOT STARTED |
| C10 Actual State Assertion | 0 | 5 | — | NOT STARTED |
| MX Nightmare Mode | 0 | 10 | — | NOT STARTED |

**Bugs found**: 7 (all FIXED)

---

## C1 — Electron Hybrid Control

### C1-T1: Open file in VS Code via native chrome, edit content, verify tab title

**App**: VS Code (Electron)
**CDP Port**: 9229 (via `--user-data-dir=/tmp/vscode-l3-profile --remote-debugging-port=9229`)
**PID**: 23751 (separate instance from main VS Code PID 17491)

#### Setup

1. Created temp workspace: `/tmp/screenhand-l3-test/`
2. Created test files: `test-file.txt`, `another-file.txt`
3. Launched separate VS Code instance with CDP:
   ```bash
   /Applications/Visual\ Studio\ Code.app/Contents/MacOS/Code \
     --user-data-dir=/tmp/vscode-l3-profile \
     --remote-debugging-port=9229 \
     --new-window /tmp/screenhand-l3-test
   ```
4. Verified CDP responds on port 9229 — Electron 39.6.0 / Chrome 142

#### Test Steps & Results

| Step | Method | Action | Result | Status |
|------|--------|--------|--------|--------|
| 1 | AX | `ui_tree(pid=23751)` — read native chrome | Window title, menu bar, buttons visible | PASS |
| 2 | AX | `key("cmd+p", pid=23751)` — open Quick Open | Quick Open triggered but went to wrong VS Code instance (PID 17491) | FAIL — L3-01 |
| 3 | CDP | `browser_tabs(cdpPort=9229)` — list tabs | Returns Walkthrough tab with vscode-file:// URL | PASS |
| 4 | CDP | `browser_js(cdpPort=9229)` — read document.title | Returns `"Walkthrough: Setup VS Code — screenhand-l3-test"` | PASS |
| 5 | CDP | `browser_js` — query explorer DOM for files | Returns `["another-file.txt", "test-file.txt"]` | PASS |
| 6 | CDP | `browser_js` — double-click test-file.txt in explorer DOM | File opens, document.title changes to `"test-file.txt — screenhand-l3-test"` | PASS |
| 7 | AX | `ui_tree(pid=23751)` — verify title after CDP open | AX window title matches: `"test-file.txt — screenhand-l3-test"` | PASS |
| 8 | CDP | `browser_js` — read `.view-lines .view-line` | Returns editor content including previously typed text | PASS |
| 9 | AX | `type_text("HYBRID TEST...", pid=23751)` — type via keyboard | Text appears in CDP-visible editor content | PASS |
| 10 | CDP | `browser_js` — verify AX-typed text in editor | First line shows `"HYBRID TEST: AX keyboard wrote this, CDP will verify it"` | PASS |
| 11 | AX+CDP | Compare window titles | Both report `"test-file.txt — screenhand-l3-test"` | PASS |
| 12 | AX | `key("cmd+a", pid=23751)` — select all before replace | Did NOT select all — focus was on wrong area. Text prepended instead of replaced. | FAIL — L3-02 |

#### Capability Proof

| Hybrid Claim | Proven? | Evidence |
|-------------|---------|----------|
| AX reads Electron native chrome (title, menu, buttons) | YES | `ui_tree` returns full menu bar + window structure |
| CDP connects to Electron app | YES | `browser_tabs` + `browser_js` work on port 9229 |
| CDP reads web content layer (DOM, tabs, editor lines) | YES | Explorer files, tab list, editor `.view-line` all readable |
| CDP can trigger actions in web layer (open file) | YES | DOM double-click on explorer opens file, title changes |
| AX keyboard input reaches CDP-visible editor | YES | `type_text` via AX → content appears in `browser_js` query |
| AX + CDP agree on window state simultaneously | YES | Both return same window title after file open |
| PID targeting works across two Electron instances | PARTIAL | macOS merges window management — keyboard can miss |

#### Verdict

**C1 hybrid is proven.** AX and CDP fuse on the same Electron app. CDP reads what AX writes. Both layers agree on state. This is the killer feature — nobody else can do both native chrome + web content in one session.

**Bugs that need fixing before C1 is reliable:**
- L3-01: PID targeting fails when two VS Code instances exist — need window-scoped focus
- L3-02: Keyboard input needs editor focus guarantee before typing
- L3-03: CDP on Electron requires `--user-data-dir` trick — needs documentation

### C1-T2: Switch Slack channel from sidebar, type draft, verify sidebar + composer state

**App**: Slack (Electron)
**PID**: 29213
**Window**: `[5391] Slack "all-agent4u (Channel) - AGENT4U - Slack"`

#### Test Steps & Results

| Step | Method | Action | Result | Status |
|------|--------|--------|--------|--------|
| 1 | AX | `focus(bundleId: com.tinyspeck.slackmacgap)` — focus Slack | Failed — `app.list` doesn't see Slack PID. Used AppleScript `activate` instead. | FAIL — L3-04 |
| 2 | OCR | `click_text("social", windowId=5391)` — click #social in sidebar | Clicked but landed on #new-channel (scale inaccuracy, items 15px apart) | FAIL — L3-05 |
| 3 | AX | `click(308, 480)` — manual coordinate click on #social | Channel switched to #social successfully | PASS |
| 4 | OCR | `screenshot(windowId=5391)` — verify sidebar state | Header shows "# social", sidebar shows channels, content shows "Have a little chit-chat in #social" | PASS |
| 5 | AX | `type_text("Hello...", pid=29213)` — type draft in composer | Failed — "PID 29213 is not running" because `app.list` doesn't see Slack | FAIL — L3-04 |
| 6 | AS | AppleScript `keystroke` to Slack process — type draft | Text appeared in composer: "HELLO FROM SCREENHAND L3 TEST! THIS IS C1-T2 VERIFYING ELECTRON HYBRID CONTROL." | PASS |
| 7 | OCR | Full-screen OCR — verify all states | Sidebar: `#social` visible. Header: `# social`. Composer: draft text visible. Channel content: "joined #social". | PASS |

#### Capability Proof

| Hybrid Claim | Proven? | Evidence |
|-------------|---------|----------|
| Native sidebar navigation works | YES | `click` on sidebar coordinates switches channel |
| Sidebar state readable after switch | YES | OCR + screenshot confirm `#social` active |
| Composer accepts typed input | YES | AppleScript keystroke lands in composer |
| Draft text verifiable | YES | OCR reads "HELLO FROM SCREENHAND L3 TEST..." in composer area |
| Both sidebar + composer state verified simultaneously | YES | Single OCR pass captures both |

#### Verdict

**C1-T2 PASS (with workarounds).** Sidebar navigation and composer typing both work on Slack. However, two bugs block the clean path:
- L3-04: `app.list` doesn't see Slack — `type_text` and `focus` fail, requiring AppleScript fallback
- L3-05: `click_text` OCR scaling misses tightly-spaced sidebar items — required manual coordinate click

---

## Bugs Found

| ID | Severity | Component | Description | Status |
|----|----------|-----------|-------------|--------|
| L3-01 | HIGH | focus / PID targeting | Two VS Code instances share macOS window management under one process. `focus(bundleId)` and `key(pid)` can target the wrong instance. Keyboard events sent to PID 23751 were intercepted by PID 17491's window. | FIXED — `focus` now accepts `windowId` param; `key` auto-focus uses `window.focus(windowId)` via `resolveWindowId(pid)` instead of `app.focus(bundleId)` |
| L3-02 | MEDIUM | key / type_text | AX `type_text` keystrokes go to Copilot chat panel instead of Monaco editor in Electron. Copilot steals keyboard focus from editor. | FIXED — `type_text` auto-detects Electron CDP, verifies CDP target matches target app name before routing through CDP. Accepts explicit `cdpPort` param. Falls back to AX if no CDP or app mismatch. |
| L3-03 | — | Electron CDP | VS Code requires `--user-data-dir` + `--remote-debugging-port` for CDP. Flag ignored on existing instance — must be on first launch. Only direct binary invocation with separate user-data-dir creates a debuggable process. | FIXED — Added Electron CDP setup docs to README Quick Start section |
| L3-04 | HIGH | app.list / bridge | `app.list` bridge call doesn't return Slack (PID 29213) even though it's running and frontmost. Causes `type_text`, `focus`, `ui_tree` to fail with "PID not running". | FIXED — `apps` augments from frontmost + window list. `focus` checks windows. `type_text`/`ui_tree`/`ui_find`/`ui_press` use `isPidRunning()` with 3 fallbacks. Filtered out XPC system services from window augmentation. |
| L3-05 | HIGH | click_text / OCR / CGWindowListCreateImage shadow | `click_text("social")` finds text correctly but screen Y drifts ~10-15pt upward, clicking `#new-channel` instead. Root cause: `CGWindowListCreateImage(.optionIncludingWindow)` captures asymmetric window shadow (~10px above, ~100px below at 2x). Image exceeds 2x window bounds (2132x1674 vs 1908x1450). Symmetric shadow compensation fails. | FIXED — Added `.boundsIgnoreFraming` to all `CGWindowListCreateImage` calls in Swift bridge. Image now matches window bounds exactly (1908x1450). `click_text` uses simple `wb/shot` ratio. Verified on Slack sidebar. |
| L3-06 | MEDIUM | AppMap / mcp-desktop.ts | `AppMap.recordFeatureCompletion()` exists but is never called from `mcp-desktop.ts`. The POST-CALL intelligence wrapper updates `actionSuccessCount`/`actionFailCount` and records elements/zones, but has zero logic to detect feature completion. Result: `completedFeatures` is always `[]`, mastery level never progresses past "beginner" regardless of actual usage. The entire feature ladder system is non-functional dead code. | FIXED — Added keyword-based feature signal detection in POST-CALL wrapper. After each successful action tool call, tool name + target + window titles are matched against per-feature keyword sets. When a match is found, `appMap.recordFeatureSignal()` is called. Covers Discord (20 features), Safari (9), Finder (7), and generic fallback (5). |
| L3-07 | HIGH | AppMap mastery system | Mastery was a checkbox counter — touching 10 surface features = grandmaster. No depth measurement, no reliability tracking, no gating. Clicking "AutoMod" once counted the same as configuring and validating AutoMod. | FIXED — Replaced with gated weighted mastery system. Per-feature depth tracking (0-4: never/navigated/action/workflow/verified), weights (1-3: consumer/operational/critical), evidence-based confidence, hard tier gates (breadth, workflow breadth, outcome breadth, reliability, healing rate, cross-feature workflows, critical feature floor). Discord ladder expanded from 10 to 20 features. Grandmaster now requires >=80% breadth at depth>=2, >=65% workflows, >=40% verified outcomes, >=95% reliability, >=80% healing, >=8 cross-feature workflows, all critical features at depth>=3. |

---

## Key Learnings

### Electron CDP Setup

VS Code (and likely all Electron apps) require specific launch flags for CDP:

```bash
# This works — separate process with CDP
/Applications/Visual\ Studio\ Code.app/Contents/MacOS/Code \
  --user-data-dir=/tmp/custom-profile \
  --remote-debugging-port=9229 \
  --new-window /path/to/workspace

# This does NOT work — merges into existing process, flag ignored
open -na "Visual Studio Code" --args --remote-debugging-port=9229 /path/to/workspace
```

**Why**: Electron apps reuse the main process for new windows. `--user-data-dir` forces a separate Chromium profile, which means a separate process. The debugging port flag is only read at process startup.

**CDP version info**: VS Code reports as Chrome/142 (Electron 39.6.0), not the system Chrome version.

### AX + CDP Fusion Pattern

The working pattern for Electron hybrid control:

1. **AX** for: window titles, menu bar, native buttons, focus state, keyboard shortcuts (cmd+s, cmd+end, etc.)
2. **CDP** for: DOM queries, editor content, explorer file list, tab list, triggering actions via DOM events
3. **CDP for editor typing**: AX `type_text(pid)` keystrokes get stolen by Copilot chat panel in VS Code. Use `browser_click(.monaco-editor .view-lines)` + `browser_type(.native-edit-context, text, clear: false)` via CDP instead — this works reliably.
4. **AX keyboard shortcuts → CDP verify**: `key(cmd+end, pid)` works after CDP click focuses editor. Read via `browser_js(cdpPort)`.
5. **CDP action → AX verify**: Open file via DOM double-click, check via `ui_tree` — title updates correctly

### Multi-Instance Electron Problem

macOS treats multiple instances of the same Electron app (even with different `--user-data-dir`) as one app for window management. AppleScript `System Events` only sees one process. `focus(bundleId)` raises whichever window macOS considers primary, not necessarily the one you want.

**Fixed**: `focus(bundleId, windowId)` now accepts an optional `windowId` param. `key()` and `type_text()` auto-resolve the window via `resolveWindowId(pid)` and call `window.focus(windowId)` instead of `app.focus(bundleId)`.
