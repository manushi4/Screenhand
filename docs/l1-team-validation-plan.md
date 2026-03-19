# L1 Team Validation Plan

> **Goal**: Prove Layer 1 (Control) works reliably — single-client AND parallel.
> **Gate**: 100% pass rate single-client, >90% pass rate parallel (3 concurrent servers).
> **Team**: Breaker, Ghost, Builder, Outsider, Chief. Scribe documents results.

---

## Phase 1: Builder — Fix Validation (Sequential, Single Client)

**Purpose**: Verify every fix actually works before testing the full L1 suite.

### 1A: PID-Targeted CGEvent Validation

```
TEST: PID targeting delivers keystrokes to correct app even when NOT frontmost
SETUP:
  1. launch(bundleId: "com.apple.TextEdit")
  2. key(combo: "cmd+n") — new document
  3. focus(bundleId: "com.apple.finder") — Finder is now frontmost
EXECUTE:
  4. type_text(text: "PID_TARGET_TEST", pid: <textedit_pid>)
VERIFY:
  5. applescript('tell app "TextEdit" to get text of front document')
     MUST contain "PID_TARGET_TEST"
  6. The text did NOT appear in Finder
WHY: Proves CGEvent.postToPid() routes to TextEdit even though Finder is frontmost
CLEANUP: Close TextEdit document without saving
```

### 1B: Focus Verification Validation

```
TEST: focus() returns honest result when focus fails
SETUP:
  1. launch(bundleId: "com.apple.TextEdit")
  2. launch(bundleId: "com.apple.Notes")
EXECUTE:
  3. focus(bundleId: "com.apple.TextEdit")
VERIFY:
  4. Response text contains "Focused" or "Warning"
  5. applescript('tell app "System Events" to get bundle identifier of first process whose frontmost is true')
     MUST match response claim
WHY: Proves focus tool no longer lies about success
```

### 1C: Executor Focus Re-validation

```
TEST: Executor re-focuses before acting when focus is lost
SETUP:
  1. Start MCP server, create session on TextEdit
  2. Use runtime executor (via click_with_fallback or type_with_fallback)
EXECUTE:
  3. locate element in TextEdit (ui_find)
  4. While locate is running, manually focus Finder (or use applescript)
  5. type_with_fallback should re-focus TextEdit before typing
VERIFY:
  6. Text appears in TextEdit, NOT in Finder
WHY: Proves isFrontmost() check between locate and act works
```

### 1D: Bridge Stability Under Load

```
TEST: Bridge handles 20 concurrent requests without crash
EXECUTE:
  1. Fire 20 rapid calls: 10x apps() + 5x windows() + 5x screenshot()
VERIFY:
  2. All 20 return results (no timeouts, no crashes)
  3. Bridge process is still alive after all complete
  4. No "Bridge process crashed" errors in logs
WHY: Proves rate limiting and write queue serialization work
```

### 1E: Session ID Robustness

```
TEST: Session re-attach works with underscore profiles
EXECUTE:
  1. Create session with profile "my_test_app"
  2. Get sessionId (should be ax_session_my_test_app_{timestamp}_{random})
  3. Clear in-memory sessions (simulate MCP restart)
  4. Call requireSessionResilent(sessionId)
VERIFY:
  5. Session re-created with profile "my_test_app" (not "my_test_app_12345...")
WHY: Proves lazy regex fix for greedy match bug
```

### 1F: menuClick Under Simulated Load

```
TEST: menu_click succeeds when system is under CPU pressure
SETUP:
  1. focus(bundleId: "com.apple.finder")
EXECUTE:
  2. Start a background CPU load (e.g., openssl speed running)
  3. menu_click(bundleId: "com.apple.finder", menuPath: ["File", "New Finder Window"])
VERIFY:
  4. windows() count increased by 1
WHY: Proves polling-based menu wait (500ms) handles slow animations
CLEANUP: Close the window, kill CPU load
```

### 1G: SIGTERM Graceful Shutdown

```
TEST: Bridge sends shutdown notification on SIGTERM
EXECUTE:
  1. Start MCP server, make a bridge call to ensure bridge is running
  2. Get bridge PID (from process list)
  3. Send SIGTERM to bridge PID
VERIFY:
  4. Node.js BridgeClient receives bridge.shutdown notification
  5. Bridge exits with code 0 (not 143)
  6. Subsequent tool call triggers clean bridge restart (not crash recovery)
WHY: Proves SIGTERM handler works
```

---

## Phase 2: Breaker — Full L1 Suite (Sequential, Single Client)

**Purpose**: Run all 31 L1 test cases from testing-plan.md with strict verification.

### Execution Rules

1. Run ALL tests sequentially in one MCP server
2. EVERY mutating test must capture state BEFORE and assert DELTA after
3. "Tool didn't throw" is NOT a pass
4. Record per-tool latency
5. Cleanup after each test

### Test Matrix (from testing-plan.md)

| App | Tests | IDs |
|-----|-------|-----|
| Finder | 10 tests | 1.1-1.10 |
| TextEdit | 5 tests | 2.1-2.5 |
| Notes | 5 tests | 3.1-3.5 |
| Safari | 6 tests | 4.1-4.6 |
| System Settings | 5 tests | 5.1-5.5 |

### Per-Test Record Format

```
TEST: L1-{id} — {name}
APP: {bundleId}
BEFORE: {state capture}
CALL: {tool + params}
AFTER: {state capture}
DELTA: {what changed}
VERDICT: PASS / FAIL
FAIL REASON: {if failed — exact error, not "didn't work"}
LATENCY: {ms}
CLEANUP: {what was cleaned up}
```

### Pass Criteria

- 31/31 pass (100%)
- Avg tool latency < 500ms (excluding launch)
- Zero cleanup failures (no save dialogs left open)
- Zero OCR used for verification (AppleScript/AX only)

### NEW Tests to Add (Bug-Specific)

| ID | Test | Verifies Fix For |
|----|------|------------------|
| 1.11 | PID-targeted type_text to non-frontmost app | Bug #1 (CGEvent targeting) |
| 1.12 | focus() returns warning when focus contested | Bug #3 (focus verification) |
| 2.6 | type_text with pid param into TextEdit while Finder frontmost | Bug #1, #2 |
| 4.7 | Safari keyboard nav with pid targeting | Bug #18 |

---

## Phase 3: Breaker — Parallel Contention Testing

**Purpose**: Prove the fixes survive concurrent MCP servers. This is where the 60% pass rate was found. Target: >90%.

### Setup

Spawn 3 MCP server processes simultaneously, each targeting a different app:

```
Server A: Finder workflow    (tests 1.1-1.10)
Server B: TextEdit workflow  (tests 2.1-2.5)
Server C: Safari workflow    (tests 4.1-4.6)
```

### Execution

All 3 servers start within 1 second of each other and run their test suites concurrently.

### What to Measure

| Metric | Before Fixes | Target |
|--------|-------------|--------|
| Pass rate | 60% (12 failures) | >90% |
| Focus race failures | 4 | 0 (PID targeting bypasses focus) |
| CGEvent misroute | 3 | 0 (PID targeted) |
| AX timeout | 2 | ≤1 (rate limiting) |
| Bridge SIGTERM | 4 | 0 (SIGTERM handler + rate limit) |
| menu_click cross-app | 1 | 0 (PID refresh + menu polling) |

### Per-Server Record

```
SERVER: {A/B/C}
APP: {bundleId}
TESTS RUN: {count}
PASSED: {count}
FAILED: {count with reasons}
BRIDGE CRASHES: {count}
FOCUS RACES DETECTED: {count — look for "Warning: focus requested for X but Y is frontmost"}
CGEVENT MISROUTES: {count — text appeared in wrong app}
```

### Parallel-Specific Tests

| ID | Test | Why |
|----|------|-----|
| P.1 | All 3 servers call focus() within 100ms of each other | Stress test focus contention |
| P.2 | Server A types "AAA", Server B types "BBB", Server C types "CCC" — each with pid param | Prove PID targeting under real contention |
| P.3 | Server A does menu_click while Server B does type_text | Cross-tool contention |
| P.4 | All 3 servers call screenshot() simultaneously | Bridge concurrency |
| P.5 | Kill one server mid-test, verify others continue | Isolation check |

---

## Phase 4: Ghost — Security Regression Testing

**Purpose**: Verify security fixes hold and no new vulns were introduced.

### Tests

| ID | Test | Verifies |
|----|------|----------|
| S.1 | Call type_text with password, verify it goes ONLY to pid-targeted app | Vuln #1 (keystroke hijacking) |
| S.2 | Call applescript with 600-char payload, verify full payload in audit log | Vuln #16 (truncation bypass) |
| S.3 | Call browser_js with 600-char code, verify full code in audit log | Vuln #16 |
| S.4 | Generate 2 session IDs, verify they differ (random component) | Vuln #4 (session ID prediction) |
| S.5 | Call ui_find with dead PID, verify clear error (not crash) | Bug #12 (PID validation) |
| S.6 | Call ui_press with stale elementPath, verify expectedTitle rejection | Bug #15 (element staleness) |
| S.7 | Fire 25 concurrent bridge calls, verify 5 are rejected with "overloaded" | Vuln #8 (rate limiting) |
| S.8 | Call launch(bundleId: "com.apple.Terminal"), verify warning in response | Vuln #10 (launch warning) |
| S.9 | Try to re-attach with guessed session ID (without random suffix), verify failure | Vuln #4 |

---

## Phase 5: Outsider — UX Validation

**Purpose**: Verify the fixes don't break the user experience.

### Non-Technical User Tests

| ID | Test | Pass When |
|----|------|-----------|
| U.1 | Call focus() on an app — is the response clear? | User understands if focus worked or not |
| U.2 | Call type_text without pid — does it still work? (backward compat) | Text appears in frontmost app |
| U.3 | Call ui_find with wrong PID — is the error helpful? | Error says "PID not running, call apps()" |
| U.4 | Bridge crashes — does the next tool call recover? | Tool works after auto-restart |
| U.5 | Call launch("com.apple.Terminal") — is the warning clear? | Warning explains risk without blocking |

### Technical User Tests

| ID | Test | Pass When |
|----|------|-----------|
| U.6 | Use pid param on type_text — is it discoverable? | Tool schema shows optional pid with description |
| U.7 | Focus warning message — is it actionable? | Tells you WHAT is frontmost, not just "failed" |
| U.8 | Rate limit error — is it clear what to do? | Says "too many concurrent requests", implies retry |
| U.9 | Session re-attach after restart — transparent? | No error visible, session continues |

---

## Phase 6: Scribe — Document Results

**Purpose**: Capture everything for the record.

### Deliverables

1. **L1 Test Results File** — `tests/results/L1-{timestamp}.json` in the LevelReport schema from testing-plan.md
2. **Parallel Test Results** — `tests/results/L1-parallel-{timestamp}.json`
3. **Update CLAUDE.md** — If tool count changed, if new params were added
4. **Update testing-plan.md** — Add the new bug-specific tests (1.11, 1.12, 2.6, 4.7, P.1-P.5)
5. **Changelog entry** — What was fixed and why

### Results Format

```
L1 VALIDATION REPORT
====================
Date: {timestamp}
Git SHA: {commit}

PHASE 1 (Fix Validation):  {X}/7 passed
PHASE 2 (Full L1 Suite):   {X}/35 passed (31 original + 4 new)
PHASE 3 (Parallel):        {X}% pass rate (target: >90%)
PHASE 4 (Security):        {X}/9 passed
PHASE 5 (UX):              {X}/9 passed

TOOL LATENCY:
  apps:        avg {X}ms / p95 {X}ms
  focus:       avg {X}ms / p95 {X}ms
  key:         avg {X}ms / p95 {X}ms
  type_text:   avg {X}ms / p95 {X}ms
  screenshot:  avg {X}ms / p95 {X}ms
  ui_find:     avg {X}ms / p95 {X}ms
  menu_click:  avg {X}ms / p95 {X}ms

BRIDGE STABILITY:
  Crashes: {count}
  Restarts: {count}
  Rate limit rejections: {count}

SHIP DECISION: {Chief's call}
```

---

## Phase 7: Chief — Final Scorecard

Chief reviews all results and issues final grades + ship decision.

### Decision Matrix

| Condition | Decision |
|-----------|----------|
| Phase 2 = 100% AND Phase 3 > 90% | SHIP L1, proceed to L2 |
| Phase 2 = 100% AND Phase 3 = 80-90% | SHIP L1 with known parallel limitations documented |
| Phase 2 < 100% | DO NOT SHIP — fix failing tests first |
| Phase 3 < 80% | DO NOT SHIP — parallel fixes insufficient |
| Phase 4 any critical fail | DO NOT SHIP — security regression |

---

## Execution Order

```
Phase 1 (Builder)     ──sequential──▸  must pass before proceeding
Phase 2 (Breaker)     ──sequential──▸  must pass 100%
Phase 3 (Breaker)     ──parallel────▸  target >90%
Phase 4 (Ghost)       ──parallel with Phase 3──▸  can run alongside
Phase 5 (Outsider)    ──parallel with Phase 3──▸  can run alongside
Phase 6 (Scribe)      ──after all phases──▸  documents results
Phase 7 (Chief)       ──after Phase 6──▸  final decision
```

**Phases 3, 4, 5 run in parallel** — three agents each testing different aspects simultaneously.

---

## Implementation Notes

### How to Run Parallel Tests (Phase 3)

```bash
# Terminal 1 — Server A (Finder)
SCREENHAND_TEST_APP=finder npm run dev &

# Terminal 2 — Server B (TextEdit)
SCREENHAND_TEST_APP=textedit npm run dev &

# Terminal 3 — Server C (Safari)
SCREENHAND_TEST_APP=safari npm run dev &

# Or use the test harness:
node scripts/test-e2e.cjs --parallel --apps finder,textedit,safari
```

### How to Verify PID Targeting

```bash
# Get TextEdit PID
apps() → find com.apple.TextEdit → pid

# Focus Finder (different app)
focus(bundleId: "com.apple.finder")

# Type with PID targeting (should go to TextEdit despite Finder being frontmost)
type_text(text: "test", pid: <textedit_pid>)

# Verify
applescript('tell app "TextEdit" to get text of front document')
```

### How to Verify Rate Limiting

```bash
# Fire 25 concurrent calls from a script
# 20 should succeed, 5 should get "Bridge overloaded" error
```
