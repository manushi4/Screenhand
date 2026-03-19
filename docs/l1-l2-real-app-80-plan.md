# ScreenHand Real-User Validation Plan

Goal: replace isolated point checks with **80 real-life app scenarios** that a real user or developer would actually run through ScreenHand.

This is not a code-review checklist. It is a live-app validation catalog for:

- proving user-facing capability in realistic flows
- mixing multiple factors in the same run
- learning where ScreenHand is strong or brittle
- collecting benchmark data that matters to operators

The original 66 capability points are still covered, but now through end-to-end scenarios instead of standalone spot checks.

## What This Suite Measures

For every scenario, record:

- task success or failure
- total wall-clock time
- tool count
- p50 and p95 per-tool latency
- focus drift count
- stale-state incidents
- recovery attempts
- restart survival
- artifact correctness
- cleanup cleanliness

## Run Rules

- Use only real apps: Finder, TextEdit, Notes, Preview, Safari or Chrome, VS Code, Terminal, System Settings.
- Prefer local or synthetic browser pages over public sites unless domain-switch behavior is the thing being tested.
- Use a temp workspace under `/tmp/screenhand-live/`.
- Every scenario must have `setup`, `execute`, `verify`, and `cleanup`.
- Verification priority:
  - filesystem or AppleScript delta
  - AX or world-state delta
  - OCR only when the UI is visual or canvas-like
- Save evidence under `tests/results/real-user-80/`.

## Stress Mix Codes

- `M1` Rapid app switching
- `M2` Non-frontmost targeting
- `M3` Multi-window or multi-tab
- `M4` Long payload or large text
- `M5` Repeat loop
- `M6` Restart mid-run
- `M7` Perception plus observer plus recording overlap
- `M8` Parallel clients or parallel tool pressure
- `M9` Background load or slow UI
- `M10` Hidden or offscreen window
- `M11` Hostile or malformed input
- `M12` Cleanup and leak check

## Scenario Catalog

### 1. Core Desktop Use

| ID | Real user story | Apps | Run | Stress | Repeat | Covers | Pass and benchmark |
|---|---|---|---|---|---|---|---|
| 01 | "Open Finder and show me what is open right now." | Finder | Launch or focus Finder, list apps, list windows, capture front window title, confirm focus state | M3,M12 | 3x | 1,3,4 | Finder is frontmost, at least one window is returned, p95 focus under 1.5s |
| 02 | "Open TextEdit and type a quick note." | TextEdit | Launch TextEdit, create new doc, type a short unique note, use keyboard shortcuts to select all and append a timestamp | M4,M12 | 3x | 4,5,6 | Typed text matches exactly, no stray typing in another app, no save dialog leak |
| 03 | "Use the menu like a normal Mac user." | Finder | Scan menu bar, invoke `File > New Finder Window`, verify window delta, close it again | M3,M9,M12 | 5x | 7 | New window appears then disappears cleanly, menu action p95 under 2s |
| 04 | "Take a screenshot of what I am seeing and let me inspect the file." | Finder, Preview | Take `screenshot` and `screenshot_file`, open the file in Preview, verify dimensions and visible content | M3,M12 | 3x | 2,3 | Screenshot exists on disk, Preview opens it, OCR text is non-empty and relevant |
| 05 | "Read what is on my Finder window." | Finder | Run AX tree and OCR on the same live Finder window, compare visible file labels and sidebar labels | M3,M12 | 3x | 1,2 | AX and OCR agree on the main visible labels, no crash or empty-tree false success |
| 06 | "Keep up while I bounce across apps." | Finder, TextEdit, Notes | Switch frontmost app back and forth while issuing focus and keystroke actions to the intended target | M1,M2,M5,M12 | 10x | 4,5,6,17 | No misrouted keystrokes, focus state stays honest, p95 action under 2s |
| 07 | "Type into TextEdit even when Finder is in front." | Finder, TextEdit | Make Finder frontmost, then PID-target TextEdit and type a unique marker string | M2,M12 | 5x | 4,5,6 | Marker lands only in TextEdit, Finder content is unchanged |
| 08 | "Restart the server and continue where you left off." | TextEdit | Begin an edit flow, restart MCP server mid-session, continue typing and verify prior session state still works | M6,M12 | 3x | 13 | Session resumes without manual repair, no duplicate windows or lost context |
| 09 | "Handle a hidden window without lying to me." | Finder or TextEdit | Move target window behind another or offscreen, call OCR and read helpers, confirm honest empty or partial result | M10,M12 | 5x | 14 | No crash, no fake success, result explicitly reflects hidden state |
| 10 | "Use fallbacks when the first path misses." | Finder, TextEdit | Force AX miss on a visible target, then run fallback tools to click, read, and locate the same target | M2,M3,M12 | 5x | 15,32,33,35,36 | Fallback path completes the action and logs show the original method missed |

### 2. Docs, Notes, and Files

| ID | Real user story | Apps | Run | Stress | Repeat | Covers | Pass and benchmark |
|---|---|---|---|---|---|---|---|
| 11 | "Write a file and reopen it from Finder." | TextEdit, Finder | Create a text document, save to `/tmp/screenhand-live/`, close it, reopen from Finder, verify content and window title | M3,M12 | 3x | 1,3,4,6 | File content matches byte-for-byte, reopen succeeds, no orphan dialogs |
| 12 | "Edit a real document, not just one short line." | TextEdit | Type 2k to 5k chars, use select-all, copy, paste, replace a phrase, save and reopen | M4,M12 | 3x | 5,6 | Final file content is correct and stable after reopen |
| 13 | "Capture a burst of notes during a meeting." | Notes | Create 10 notes with unique titles and bodies, switch among them rapidly, append tags and timestamps | M1,M4,M5,M12 | 1 run | 6,16,19,20 | All 10 notes retain correct titles and bodies, no cross-note corruption |
| 14 | "Find the note I just wrote." | Notes | After note churn, search for one tagged note, open it, verify body text and world-state focus | M1,M12 | 5x | 16,19 | Correct note opens every time, focus and title are accurate |
| 15 | "Manage files the way a normal user does." | Finder | Create folder, rename file, duplicate file, move it into folder, verify deltas after each step | M3,M5,M12 | 1 run | 1,4,7 | Every filesystem delta matches expectation, no stale Finder state |
| 16 | "Preview files quickly before deciding." | Finder, Preview | Batch Quick Look or open-close preview on 10 files, verify title changes and preview stability | M3,M5,M9,M12 | 1 run | 2,3,14 | Preview opens each file without hanging, close returns to Finder cleanly |
| 17 | "Use scrolling, waiting, and selection like a human." | TextEdit, Finder | Scroll content, wait for state changes, select a visible item or menu option via fallback chain | M3,M5,M12 | 5x | 37,38,39 | Selection and wait conditions are accurate; no silent timeout success |
| 18 | "Draft in Notes, polish in TextEdit." | Notes, TextEdit | Capture bullets in Notes, copy the content into TextEdit, format it, save to disk | M1,M3,M12 | 3x | 4,5,6,16 | Content transfer is exact, final file is saved correctly |
| 19 | "Navigate a settings screen like a user checking preferences." | System Settings | Launch or focus System Settings, locate a visible category, inspect AX tree, verify titles and visible controls | M3,M12 | 3x | 1,4 | Category and controls are correctly exposed, no missing-tree false positives |
| 20 | "Finish cleanly." | Finder, TextEdit, Notes | After a mixed document workflow, close windows and verify no unsaved-doc prompts or dirty artifacts remain | M3,M12 | 3x | 3,4,6 | Cleanup completes with zero residual dialogs and zero temp-file drift |

### 3. Browser and Web Assist

| ID | Real user story | Apps | Run | Stress | Repeat | Covers | Pass and benchmark |
|---|---|---|---|---|---|---|---|
| 21 | "Fill a small web form on a page I opened." | Chrome or Safari | Open `about:blank`, inject a local search form with `browser_js`, fill fields, submit, and capture result JSON | M3,M5,M12 | 25x | 20,21,22,23,24,25,27,28,30 | Submitted values match expected JSON every run, p95 submit under 2s |
| 22 | "Recover from a form validation error." | Chrome or Safari | Inject a two-step form with required fields, intentionally submit invalid input, correct it, and resubmit | M3,M5,M12 | 10x | 22,23,24,25,27,30 | Error state is detected, corrected submission succeeds, no stale modal state |
| 23 | "Open a modal, interact, and close it." | Chrome or Safari | Inject a page with cards and a modal, use DOM query, click, fill, and wait for open and close states | M3,M5,M12 | 10x | 23,24,25,27,39 | Modal state transitions are correctly detected and no clicks are dropped |
| 24 | "Click like a human, not a robot." | Chrome | Inject click instrumentation, run `browser_human_click`, inspect event sequence and coordinates | M5,M12 | 20x | 31 | Event sequence is realistic and consistently reaches the intended element |
| 25 | "Patch a page for anti-detection before interaction." | Chrome | Open a synthetic page, run `browser_stealth`, verify patched navigator values and hidden webdriver flag | M5,M12 | 20x | 29 | Expected environment values are patched and the page remains usable |
| 26 | "Read a long page and wait for lazy content." | Chrome or Safari | Inject an infinite-scroll list, scroll repeatedly, wait for additional content, verify final item count | M3,M5,M12 | 10x | 38,39 | Lazy content loads reliably and item counts match expected thresholds |
| 27 | "Inspect a dense page without blowing up state." | Chrome or Safari | Inject a page with 1k simple controls, run browser inspection and perception, confirm state remains bounded | M4,M5,M12 | 5x | 21,23,24,28 | Page stays responsive, world-model/control counts stay within expected cap |
| 28 | "Use dropdowns, toggles, and checkboxes." | Chrome or Safari | Inject a settings form page and use select, click, type, and DOM reads to set final values | M3,M5,M12 | 10x | 23,24,25,30,37 | Final UI state matches requested config exactly |
| 29 | "Switch domains while I research." | Chrome or Safari | Navigate among `github.com`, `example.com`, and a local page, watch context changes, preflight, and hints | M1,M3,M12 | 5x | 23,36,38 | Reference domain gets hints, unrelated domain stays quiet, no stale domain bleed |
| 30 | "Read a page and summarize it into Notes." | Browser, Notes | Open a page, extract headline and key lines, switch to Notes, create a summary note with source URL | M1,M3,M12 | 5x | 16,19,23,28 | Summary note contains the correct title, key facts, and source URL |

### 4. Knowledge, Memory, and Playbooks

| ID | Real user story | Apps | Run | Stress | Repeat | Covers | Pass and benchmark |
|---|---|---|---|---|---|---|---|
| 31 | "Remember a workflow that worked." | Finder, TextEdit | Complete a successful file workflow, call `memory_save`, then verify it appears in memory stats and snapshot | M12 | 3x | 31 | Strategy is saved and visible immediately with the correct task description |
| 32 | "Recall a similar workflow when I ask again." | Finder, TextEdit | After saving strategies, call `memory_recall` with a specific task phrase and replay the returned flow | M5,M12 | 5x | 31,32 | Recall returns the right strategy cluster and replay succeeds |
| 33 | "Do not hallucinate from vague prompts." | Memory tools with real prior sessions | Query memory with generic phrasing and then with specific phrasing after real sessions exist | M11,M12 | 5x | 33 | Generic prompt yields little or no noisy advice; specific prompt yields relevant recall |
| 34 | "Record a workflow so I can repeat it." | Notes | Start playbook recording, create a note, type content, stop recording, inspect saved steps, rerun equivalent flow | M12 | 3x | 39 | Recorded steps are complete enough to reproduce the user action |
| 35 | "Export what ScreenHand learned from a web session." | Chrome or Safari | Run a synthetic form flow, export playbook, and inspect JSON for selectors, URLs, and inert stored fields | M4,M11,M12 | 3x | 41 | Exported JSON contains useful fields and stores unsafe strings as inert data |
| 36 | "Match the exact site, not a lookalike." | Browser | Run `platform_guide` or preflight on exact host and near-miss host, compare result behavior | M11,M12 | 5x | 43 | Exact host matches; non-matching subdomain or lookalike does not |
| 37 | "Handle long or ugly workflow names safely." | Notes or Browser | Record or export a playbook with a 300-char name and script-tag-like labels | M4,M11,M12 | 3x | 41,42 | Saved identifier is safely shortened, content remains inert, rerun still works |
| 38 | "Reject path-like and null-byte style IDs." | Playbook tools | Attempt playbook operations with `../../../x`, embedded null-like strings, and weird separators | M11,M12 | 5x | 40,59,60,61 | No traversal happens, tool returns safe errors or sanitized IDs |
| 39 | "Handle malicious URLs without derailing context." | Browser | Try `javascript:`, `data:`, and `blob:` URLs in context-sensitive flows and verify graceful handling | M11,M12 | 5x | 37,64 | Unsafe protocols are rejected or neutralized without crashing the session |
| 40 | "Use memory, playbook hints, and context together." | Browser, Notes, Finder | Run a mixed browsing and note-taking flow after memory exists, verify hints appear and stay relevant | M1,M3,M12 | 3x | 31,32,36,38,39 | Hints match the current domain and task, not stale history from another app |

### 5. Developer Tool Story

| ID | Real user story | Apps | Run | Stress | Repeat | Covers | Pass and benchmark |
|---|---|---|---|---|---|---|---|
| 41 | "Open my workspace and orient me." | Finder, VS Code | Open a temp workspace from Finder into VS Code, confirm focused editor or welcome view in world state | M3,M12 | 3x | 1,4,19 | VS Code is frontmost and world state identifies the correct window |
| 42 | "Jump to a file quickly." | VS Code | Use Quick Open or file picker flow, open a known file, verify tab title and visible content | M5,M12 | 10x | 5,6,19 | Correct file opens every time, p95 navigation under 2s |
| 43 | "Search the repo and paste the result into Notes." | VS Code, Notes | Search for a known string in workspace, capture one result, switch to Notes, create summary note | M1,M3,M12 | 5x | 5,6,16,19 | Search result is accurate and the note contains the expected snippet |
| 44 | "Run a basic terminal command for me." | Terminal or VS Code terminal | Open terminal, run `pwd` and `ls`, capture output, and verify expected path and files | M3,M12 | 5x | 3,4,5 | Terminal output matches workspace path and expected files |
| 45 | "Read docs in the browser and summarize them locally." | Browser, TextEdit | Open a docs page, extract title and 3 key bullets, switch to TextEdit, write and save summary | M1,M3,M12 | 5x | 6,23,28,30 | Saved summary contains correct title and bullets and is stored to disk |
| 46 | "Edit a scratch file and verify it from two places." | VS Code, Finder, Terminal | Create or edit a file, save it, read it back from Finder preview or Terminal output | M3,M12 | 5x | 3,4,6 | File content matches in editor and terminal readback |
| 47 | "Handle repeated command palette use without getting lost." | VS Code | Run a command-palette or quick-open loop 20 times with alternating targets | M1,M5,M12 | 1 run | 5,19,20 | Correct command or file opens each time, no stale focus or hidden modal buildup |
| 48 | "Switch among code, docs, and notes like a real dev." | VS Code, Browser, Notes | Alternate among editor, browser docs, and notes while preserving the intended active context | M1,M3,M5,M12 | 1 run | 17,19,20,23 | No context drift and the right app is acted on each step |
| 49 | "Read a long terminal output and capture evidence." | Terminal, Preview | Run a command with multi-screen output, scroll, screenshot, and OCR the visible lines | M4,M5,M12 | 3x | 2,3,38 | OCR text reflects the terminal output and scrolling lands on the requested area |
| 50 | "Do a full dev assist loop." | VS Code, Browser, Terminal, Finder, Notes | Read docs, change a file, verify in terminal, save an output artifact, and summarize work | M1,M3,M4,M12 | 3x | 4,5,6,19,23,31 | Entire loop finishes with correct artifact, summary, and no context mistakes |

### 6. Cross-App Automation and Jobs

| ID | Real user story | Apps | Run | Stress | Repeat | Covers | Pass and benchmark |
|---|---|---|---|---|---|---|---|
| 51 | "Run a simple multi-step job for me." | TextEdit | Create a 3-step job that opens TextEdit, types content, and saves or confirms final state | M12 | 5x | 44 | Job reaches `done` and the app state matches the intended output |
| 52 | "Keep useful outputs from each job step." | TextEdit, Finder | Include screenshot and target outputs in a job, inspect stored step outputs after completion | M3,M12 | 5x | 45,53 | Outputs are preserved with collision-safe keys and can be referenced later |
| 53 | "Use job actions to launch and focus the right app." | TextEdit, Finder | Create a job that alternates `launch` and `focus` actions across two apps and verifies frontmost state | M1,M3,M12 | 5x | 46 | Job focuses the correct app on each step with no false success |
| 54 | "Chain work across apps like an assistant would." | TextEdit, Finder, Notes | Use a job chain to create text, open its file location, and create a note containing the path | M1,M3,M12 | 3x | 47 | Each app step completes and the final note contains the correct referenced path |
| 55 | "Pass data from one step to the next." | TextEdit, Finder | Capture a path or title from one step and inject it into a later step via `{prev.X}` style variables | M3,M12 | 5x | 48 | Later step uses the exact previous output value with no substitution bug |
| 56 | "Retry when one step is bad, then finish honestly." | TextEdit, Finder | Add one intentionally bad step, hit retry limits, and verify final mixed done or failed behavior | M11,M12 | 5x | 50,54 | Retry cap is enforced, job state is honest, and error counts are preserved |
| 57 | "Guard job state transitions." | Job tools | Attempt `failStep` and `skipStep` on non-running jobs, then on running jobs, compare results | M11,M12 | 5x | 49,51,52 | Invalid state changes are rejected and valid ones succeed only in running state |
| 58 | "Do not let two workers grab the same job." | Job tools, worker daemon | Queue multiple jobs, race dequeues, and confirm only one worker acquires each job in priority order | M8,M12 | 5x | 55,56 | No duplicate acquisition, lower priority number dequeues first |
| 59 | "Respect dependencies between jobs." | Job tools | Create valid and invalid dependency chains and confirm creation or rejection behavior | M11,M12 | 5x | 57 | Missing dependency is rejected, valid chain executes in order |
| 60 | "Run a batch end to end with the worker." | Worker daemon, Finder, TextEdit | Queue a set of jobs including one navigate fallback case, run worker daemon, inspect final states | M3,M5,M12 | 3x | 58 | Worker processes batch correctly and fallback navigation succeeds where required |

### 7. Stress, Parallel, and Soak

| ID | Real user story | Apps | Run | Stress | Repeat | Covers | Pass and benchmark |
|---|---|---|---|---|---|---|---|
| 61 | "Handle a burst of tool calls while I keep working." | Finder, TextEdit, Notes | Fire 20 concurrent live calls across apps and verify bridge health before and after | M8,M12 | 5x | 8 | All calls return or fail honestly, bridge stays alive, no deadlock |
| 62 | "Recover if the bridge dies or restarts under load." | Finder, TextEdit | Trigger active work, force or simulate bridge restart, and verify clean reconnection behavior | M6,M8,M12 | 3x | 9 | Subsequent tool calls succeed after restart without corrupted session state |
| 63 | "Watch my app while I keep editing for 10 minutes." | Notes | Run perception and observer together while editing a note every 5 seconds and polling state | M5,M7,M12 | 10 min | 16,18,19,20,21 | No crash, freshness remains bounded, world state converges after each edit |
| 64 | "Follow me as I jump between five apps." | Finder, TextEdit, Notes, Browser, VS Code | Switch frontmost app 100 times over 5 minutes while perception stays active | M1,M5,M12 | 1 run | 17,19,20 | Focused app and window are correct after each burst, no stuck context |
| 65 | "Get faster or steadier after repetition." | Finder or TextEdit | Repeat the same short workflow 10 times and compare learning status, budgets, and latency spread | M5,M12 | 10x | 24,26 | Timing adapts but remains bounded; run 10 is faster or more stable than run 1 |
| 66 | "Prefer the right sensor for the right app." | TextEdit, Browser | Run similar tasks in a native app and a browser, then inspect sensor ranking and score bounds | M3,M5,M12 | 5x | 25,28 | Native flow favors AX, browser flow favors CDP, scores stay inside `[0,1]` |
| 67 | "Remember a long mixed session without blowing up." | Finder, Notes, Browser, TextEdit | Run 100 mixed actions, record memory and learning, then inspect recall quality and cache behavior | M1,M5,M12 | 1 run | 31,32,34 | Recall remains useful, cache remains bounded, no memory corruption |
| 68 | "Run perception, observer, and recording together." | Notes | Start observer, start perception, start playbook recording, perform edits, stop all three, verify outputs | M5,M7,M12 | 3x | 18,39 | All three systems remain stable and outputs are internally consistent |
| 69 | "Support multiple clients at once." | Finder, TextEdit, Browser | Run 3 MCP clients in parallel, each driving a different app workflow | M1,M8,M12 | 3x | 8,13,17,44 | No cross-client misroutes, no global stall, pass rate stays above 90% |
| 70 | "Survive a 30-minute mixed reality run." | Finder, TextEdit, Notes, Browser, VS Code | Combine perception, jobs, memory writes, screenshots, OCR, browser DOM actions, and app switching | M1,M3,M5,M7,M8,M12 | 30 min | 13,16,24,27,31,35 | No process crash, bounded file growth, >=95% scheduled step success |

### 8. Safety, Recovery, and Hostile Inputs

| ID | Real user story | Apps | Run | Stress | Repeat | Covers | Pass and benchmark |
|---|---|---|---|---|---|---|---|
| 71 | "Recover when focus is stolen mid-task." | TextEdit, Finder | Start a task, steal focus to Finder mid-action, inspect recovery state, apply one recovery, verify resume | M1,M2,M12 | 5x | 29 | Recovery bookkeeping is correct and resumed task hits the intended app |
| 72 | "Do not choke on oversized state files." | Memory, Learning, Recovery services | Inflate temp copies of memory or learning files beyond guard thresholds, then call live status tools | M11,M12 | 3x | 27,30,35,63 | Tools fail safely or skip oversized reads without crashing the server |
| 73 | "Do not leak sensitive URL params into outputs." | Browser, Notes | Navigate to pages with token-like query strings, inspect world state, summaries, and exports for redaction | M11,M12 | 5x | 23,65 | Sensitive params are redacted in every surfaced artifact |
| 74 | "Do not leak credential-looking strings." | Notes, Browser, Finder | Enter bearer-token, email:password, and API-key-like strings into visible UI, then inspect OCR, AX, and memory outputs | M4,M11,M12 | 5x | 66 | Credential patterns are redacted or sanitized consistently |
| 75 | "Redact personal-looking labels everywhere." | Finder | Create or show filenames and menu labels with a personal name marker, then inspect OCR, AX tree, and menu output | M3,M11,M12 | 5x | 10,11,12 | PII is redacted consistently across OCR, AX, and menu surfaces |
| 76 | "Allow only safe URL protocols." | Browser | Attempt `javascript:`, `data:`, `blob:`, `http:`, `https:`, `about:`, and `chrome:` flows where supported | M11,M12 | 5x | 64 | Unsafe protocols are blocked or neutralized; allowed protocols continue normally |
| 77 | "Tolerate malformed reference data." | Browser, guide tools | Corrupt a temp reference file or point to a malformed doc, then run guide or preflight behavior | M11,M12 | 3x | 62 | Bad reference data is skipped gracefully with a clear error or warning |
| 78 | "Stay honest on hidden visual targets." | Finder, Observer | Watch a window with observer, hide or occlude it, run ROI OCR and screenshot flows, compare outputs | M10,M12 | 5x | 14,18 | No crash and no invented OCR hits when the target is not visible |
| 79 | "Keep state across repeated restarts while jobs are running." | TextEdit, Finder, job tools | Start perception and a job, restart MCP multiple times, then verify resumed state, pending job status, and app target | M6,M12 | 3x | 13,44 | Session and job continuity remain intact across repeated restarts |
| 80 | "Handle a hostile real developer day." | VS Code, Terminal, Browser, Finder, Notes | Mix docs lookup, file edits, terminal output, app switching, one bad URL, one focus theft, and final summary save | M1,M3,M4,M6,M11,M12 | 3x | 9,17,23,29,31,44,64,66 | Entire workflow finishes safely, with honest errors and a correct final artifact |

## Coverage Intent

This suite covers the original points by forcing them to survive realistic use:

- L1 runtime control: scenarios 01-20
- L2 perception, world model, learning, memory, context: scenarios 21-40 and 61-80
- Job system and multi-step automation: scenarios 51-60 and 79-80
- Security and hardening in live contexts: scenarios 38-39 and 71-80

## Suggested Run Tiers

### Tier A: Daily smoke

- 01, 02, 03, 05, 11, 21, 31, 41, 51, 71

### Tier B: Release candidate

- 06, 08, 13, 16, 24, 29, 34, 45, 54, 58, 63, 64, 65, 73, 75

### Tier C: Ship gate

- 62, 68, 69, 70, 72, 76, 79, 80

## Failure Classes

- `Hard fail`: crash, deadlock, wrong-app action, silent false success, data corruption, unsafe leak
- `Soft fail`: slow beyond benchmark, required manual nudge, stale state corrected later, cleanup issue
- `Needs product decision`: ambiguous UX, safe but confusing error, behavior that is technically correct but operator-hostile

## What To Learn From This

At the end of a full run, answer:

- Which user journeys are truly reliable?
- Which stress combinations break otherwise-good tools?
- Which tools only work in isolation but fail in mixed reality?
- Which flows improve after learning?
- Which failures are recoverable and which are fundamental?

That is the point of this plan: not "does tool X return something", but "can a real user trust ScreenHand through a full day of actual app work."
