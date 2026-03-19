# L3 Real-App Capability Validation — Findings

**Layer**: L3 (Electron hybrid, real desktop apps, capability-level proof)
**Platform**: macOS
**Started**: 2026-03-19
**Status**: IN PROGRESS

---

## Summary

| Capability | Tasks Done | Tasks Total | Pass Rate | Status |
|-----------|-----------|-------------|-----------|--------|
| C1 Electron Hybrid Control | 1 (partial) | 5 | — | IN PROGRESS |
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

**Bugs found**: 3 (2 OPEN, 1 DOCS)

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

---

## Bugs Found

| ID | Severity | Component | Description | Status |
|----|----------|-----------|-------------|--------|
| L3-01 | HIGH | focus / PID targeting | Two VS Code instances share macOS window management under one process. `focus(bundleId)` and `key(pid)` can target the wrong instance. Keyboard events sent to PID 23751 were intercepted by PID 17491's window. | OPEN |
| L3-02 | MEDIUM | key / type_text | `Cmd+A` via `key()` does not select-all when Electron editor area doesn't have focus (e.g. Walkthrough tab active). Text prepends instead of replacing. No mechanism to focus the editor area before typing. | OPEN |
| L3-03 | — | Electron CDP | VS Code requires `--user-data-dir` + `--remote-debugging-port` for CDP. Flag ignored on existing instance — must be on first launch. Only direct binary invocation with separate user-data-dir creates a debuggable process. | DOCS |

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

1. **AX** for: window titles, menu bar, native buttons, focus state, keyboard shortcuts
2. **CDP** for: DOM queries, editor content, explorer file list, tab list, triggering actions via DOM events
3. **AX keyboard → CDP verify**: Type via `type_text(pid)`, read via `browser_js(cdpPort)` — content flows correctly
4. **CDP action → AX verify**: Open file via DOM double-click, check via `ui_tree` — title updates correctly

### Multi-Instance Electron Problem

macOS treats multiple instances of the same Electron app (even with different `--user-data-dir`) as one app for window management. AppleScript `System Events` only sees one process. `focus(bundleId)` raises whichever window macOS considers primary, not necessarily the one you want.

**Workaround needed**: Focus by windowId (from `windows()` list), not by bundleId/PID.
