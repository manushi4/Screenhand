# ScreenHand L3 Real-App Capability Plan

Purpose: prove ScreenHand is a product for real desktop app testing, not a demo against easy apps.

This L3 plan is capability-first. The apps are only the proving ground.

## Scope

- 10 product-critical capabilities: `C1-C10`
- 5 real-app tasks per capability: `50` core tasks
- 10 mixed “nightmare mode” scenarios that combine multiple capabilities in one run
- All tasks run on real desktop apps, not synthetic toy pages

## Real Apps Under Test

Primary apps:

- VS Code desktop
- Slack desktop
- Discord desktop
- Figma desktop
- Notion desktop
- Spotify desktop

Support apps used for verification or handoff:

- Finder
- Preview
- Terminal
- Chrome

## Global Run Rules

- Use dedicated test accounts and a disposable workspace for Slack, Discord, Notion, Figma, and Spotify.
- Run the desktop app version, not just the browser tab version.
- Every task must record:
  - task success
  - pass or fail reason
  - p50 and p95 latency
  - retry count
  - recovery count
  - evidence bundle: screenshot, AX snapshot, DOM snapshot when available, and final state proof
- A click alone is never a pass. Final app state must be verified.
- Core tasks run `5x` each unless noted.
- Nightmare tasks run `3x` each unless noted.

## L3 Release Bar

- Per core task: `>= 4/5` passes
- Per capability bucket: `>= 90%` aggregate pass rate
- Per nightmare task: `>= 2/3` passes with no silent false success
- Zero unsafe data corruption
- Zero “it clicked, so we assumed it worked” assertions

## How To Execute

This plan assumes a dedicated L3 runner, not ad hoc manual clicking.

### Runner commands

- Single task:
  - `npx tsx tests/l3/run.ts --task C1-T1`
- Full capability bucket:
  - `npx tsx tests/l3/run.ts --capability C1`
- Nightmare scenario:
  - `npx tsx tests/l3/run.ts --task MX-01`
- Full L3 suite:
  - `npx tsx tests/l3/run.ts --all`

### Task spec format

Each task should live as a machine-readable file:

- `tests/l3/tasks/C1/C1-T1.yaml`
- `tests/l3/tasks/C6/C6-T3.yaml`
- `tests/l3/tasks/mixed/MX-04.yaml`

Each task file should define:

- task id
- capability id
- target apps
- prerequisites
- setup steps
- execute steps
- verify steps
- cleanup steps
- repeat count
- timeout budget
- evidence requirements
- healing perturbation, if any

### Result format

Each run should emit:

- `tests/results/l3/<timestamp>/<task-id>/result.json`
- `tests/results/l3/<timestamp>/<task-id>/summary.md`
- `tests/results/l3/<timestamp>/<task-id>/screenshots/*.png`
- `tests/results/l3/<timestamp>/<task-id>/ax.json`
- `tests/results/l3/<timestamp>/<task-id>/dom.json` when relevant
- `tests/results/l3/<timestamp>/<task-id>/world-state.json`
- `tests/results/l3/<timestamp>/<task-id>/timeline.json`

`result.json` should include at least:

- `taskId`
- `capability`
- `apps`
- `runIndex`
- `passed`
- `passReason`
- `failReason`
- `totalMs`
- `toolCalls`
- `p50Ms`
- `p95Ms`
- `retries`
- `recoveries`
- `healed`
- `healingStrategy`
- `falseSuccessDetected`
- `evidencePaths`

### CI contract

CI should consume the JSON outputs and publish:

- per-task pass rate
- per-capability pass rate
- p50 and p95 latency
- retry rate
- recovery rate
- heal rate for `C6`
- silent false success count

Suggested CI commands:

- `npm run validate:l3 -- --tier smoke`
- `npm run validate:l3 -- --capability C6`
- `npm run validate:l3 -- --all`

L3 is only credible if it is runnable, repeatable, and machine-scored.

## C1. Electron Hybrid Control

What it proves: ScreenHand can fuse native AX chrome and embedded web content inside the same Electron app session.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C1-T1 | Open a file in VS Code via native app chrome, then edit content inside the editor and verify the tab title changed | VS Code | AX can drive native shell state while CDP or DOM-level access drives editor content in the same app | 5/5 runs; correct file tab and editor text every time |
| C1-T2 | In Slack, switch channel from sidebar, type a draft, and verify both sidebar state and composer state | Slack | Native sidebar state and web message composer state are both readable and actionable | 5/5 runs; correct channel active and draft text visible |
| C1-T3 | In Discord, switch server and channel, then verify the right message pane loaded | Discord | Native navigation shell plus web content panel work together | 5/5 runs; target server and channel visible with correct message pane |
| C1-T4 | In Notion desktop, move from sidebar page navigation into the block editor and edit content | Notion | Sidebar and editor blocks can be controlled in one coherent flow | 5/5 runs; page title and edited block persist |
| C1-T5 | In Figma desktop, select a file from app chrome, then interact with layer panel and export flow | Figma | Native shell, panel state, and web-based design surface can all participate in one workflow | 4/5 runs; correct file, correct layer, export flow reachable |

## C2. Dynamic Element Discovery

What it proves: ScreenHand can find UI that only appears after interaction.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C2-T1 | Open VS Code Command Palette, search for a command, and execute it | VS Code | Discover a popup that does not exist until keyboard interaction triggers it | 5/5 runs; correct command palette item executed |
| C2-T2 | Open Slack emoji picker or slash-command menu after focusing the composer | Slack | Discover transient UI and select from it reliably | 5/5 runs; chosen emoji or slash command appears in composer |
| C2-T3 | Trigger Notion slash menu and insert a specific block type | Notion | Dynamic block suggestions can be discovered and selected | 5/5 runs; correct block inserted |
| C2-T4 | Right-click a Discord message to open context menu and choose a visible action | Discord | Context menu discovery and action selection work on demand | 5/5 runs; correct context menu action fires |
| C2-T5 | In Figma, select a layer and open the export or quick-actions panel that only appears after selection | Figma | Element discovery depends on prior state and still works | 4/5 runs; action panel appears and intended control is available |

## C3. Cross-App Data Flow

What it proves: ScreenHand can move data across apps and preserve correctness.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C3-T1 | Copy a terminal error from VS Code, search it in Chrome, and paste the chosen fix summary into Notion | VS Code, Chrome, Notion | Data survives app boundaries and the right text lands in the right place | 5/5 runs; exact error snippet and summary preserved |
| C3-T2 | Copy a Figma layer name and send it to a Slack design-review channel | Figma, Slack | Design metadata can move from design tool to comms tool | 5/5 runs; exact layer name appears in the sent message |
| C3-T3 | Copy a Slack thread URL or title into a Notion project page and then reference it in Finder via saved file name | Slack, Notion, Finder | Cross-app copy, save, and verify work across communication, docs, and filesystem | 4/5 runs; URL or title preserved in both destinations |
| C3-T4 | Copy a Notion task title into a VS Code TODO file and post a short completion note in Slack | Notion, VS Code, Slack | One source drives two downstream app updates | 5/5 runs; both targets contain the same canonical task text |
| C3-T5 | Copy the current Spotify track title and artist into a meeting note and send it to a Slack channel | Spotify, Notion or Notes, Slack | Media state can feed into documentation and messaging flows | 4/5 runs; track metadata matches what is actually playing |

## C4. Async State Verification

What it proves: ScreenHand can assert on final state after latency, not just after a click.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C4-T1 | Send a Slack message and verify it actually appears in the channel with the expected content | Slack | “Send clicked” is not enough; final delivery must be verified | 5/5 runs; message bubble appears with exact text |
| C4-T2 | Edit a Notion page, wait for save, reload the page, and verify content persisted | Notion | Asynchronous save state is tracked correctly | 5/5 runs; persisted content survives reload |
| C4-T3 | Start Spotify playback and verify play state plus elapsed time movement | Spotify | Playback state is truly active, not just button-toggled | 4/5 runs; state shows playing and progress advances |
| C4-T4 | Export a Figma frame and verify the file exists in Finder and opens in Preview | Figma, Finder, Preview | Export completion is verified by a real artifact, not UI optimism | 4/5 runs; file exists with correct name and opens |
| C4-T5 | Run a terminal task in VS Code and verify the final success marker in output or Problems state | VS Code | Async completion inside an embedded terminal is verified | 5/5 runs; expected success marker present |

## C5. Non-Frontmost Interaction

What it proves: ScreenHand can target the correct app without fragile app switching.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C5-T1 | Type into VS Code terminal while Slack stays frontmost | VS Code, Slack | PID-targeted input works even when the target app is not visible on top | 5/5 runs; text lands only in VS Code terminal |
| C5-T2 | Keep a Slack draft updated while VS Code remains frontmost | Slack, VS Code | Background text target is stable and isolated | 5/5 runs; draft updates without focus theft |
| C5-T3 | Search Spotify while Notion remains frontmost | Spotify, Notion | Non-frontmost controls still react correctly | 4/5 runs; Spotify search state updates correctly |
| C5-T4 | Append text to a Notion page while Chrome is frontmost | Notion, Chrome | Background editor writes do not spill into foreground app | 4/5 runs; only Notion changes |
| C5-T5 | Rename a selected Figma frame while Finder is frontmost | Figma, Finder | Background control works even in heavier Electron UI | 4/5 runs; exact layer/frame rename persists |

## C6. Self-Healing Under UI Change

What it proves: the exact same task still completes after the first successful path is invalidated between runs.

For `C6`, “healed” means:

- run 1 succeeds through a primary path
- before run 2, we deliberately perturb the UI or invalidate the learned locator
- the task definition does not change
- ScreenHand finds a new workable route and still completes the same user goal

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C6-T1 | Open a target file in VS Code, then invalidate the previously successful Explorer locator by collapsing Explorer and forcing the same task to heal through Quick Open or Command Palette | VS Code | Stored primary route is no longer usable, but the same goal still succeeds without rewriting the test | 4/5 runs; at least one healed run succeeds and opens the same file |
| C6-T2 | Send the same Slack message twice: first using the normal composer route, then after invalidating the primary send path by changing window density or composer layout and poisoning the saved locator | Slack | Message delivery survives a broken primary locator and uses an alternate path such as Enter-to-send or a different composer anchor | 4/5 runs; second run is marked healed and message appears once in the correct channel |
| C6-T3 | Insert the same Notion to-do block twice: first via slash menu, then invalidate the saved slash-menu locator and rerun unchanged so ScreenHand heals via plus-button or block toolbar | Notion | Dynamic editor actions still complete after the original insertion path is removed | 4/5 runs; second run completes with a different route and the correct block exists |
| C6-T4 | Export the same Figma frame twice: first from the primary export control, then invalidate that control path and rerun unchanged so ScreenHand heals via menu bar export | Figma | Export flow remains stable across UI drift by choosing another valid control surface | 4/5 runs; second run is healed and produces the same artifact outcome |
| C6-T5 | Reach the same Discord channel twice: first via sidebar, then collapse or reorder the navigation and invalidate the prior locator so the identical task heals via quick switcher or search | Discord | Channel navigation survives shell-level layout drift without editing the test spec | 4/5 runs; healed run reaches the same target channel |

## C7. Notification, Badge, and Overlay Detection

What it proves: ScreenHand can see state that browser-only tools miss.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C7-T1 | Receive a Slack message from a test user and detect unread badge or notification state before opening it | Slack | Unread indicators outside main content are observable | 4/5 runs; unread state detected before clear |
| C7-T2 | Receive a Discord mention and verify badge or mention indicator on the server or channel | Discord | Overlay or shell-level notification state is visible | 4/5 runs; mention badge detected correctly |
| C7-T3 | Introduce a syntax error in VS Code and verify the Problems or activity badge changes | VS Code | App chrome status changes are observable and assertable | 5/5 runs; badge or problem count reflects the error |
| C7-T4 | Trigger a Figma export-complete toast or transient status indicator and verify it appears | Figma | Overlay-style transient signals are detectable in a heavy app | 4/5 runs; completion toast or status appears |
| C7-T5 | Verify Spotify’s playback bar or queue overlay reflects the current track after a track change | Spotify | Overlay or chrome-level playback state is assertable | 4/5 runs; overlay matches actual track state |

## C8. Menu Bar and System Dialog Interaction

What it proves: ScreenHand can handle desktop UI outside the web content area.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C8-T1 | Open New Terminal or Command Palette from the VS Code app menu and verify the result | VS Code | Menu bar interaction is stable and verifiable | 5/5 runs; correct UI opens from menu path |
| C8-T2 | Open Slack Preferences from the app menu and verify the settings view | Slack | Native app menu navigation works on Electron apps | 4/5 runs; preferences window or panel opens |
| C8-T3 | Export a Figma frame using menu bar and complete the native save dialog | Figma, Finder | Menu + system dialog flow works end to end | 4/5 runs; file saved to expected location |
| C8-T4 | Use Notion or Discord menu actions to change a view or open a settings surface | Notion or Discord | Desktop menus, not just in-app buttons, are controllable | 4/5 runs; intended settings or view opens |
| C8-T5 | Trigger a native open or save dialog from VS Code or Figma and choose a path in Finder-style UI | VS Code or Figma, Finder | System dialogs are part of the automation surface | 4/5 runs; correct file or folder selected |

## C9. Performance Under Real App Weight

What it proves: ScreenHand stays usable on heavy apps and large UI trees.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C9-T1 | In VS Code with 20+ tabs and a real repo open, search, open, and edit a file | VS Code | Heavy AX trees and tab sets do not break navigation | 4/5 runs; p95 flow under 30s |
| C9-T2 | In a Slack workspace with many channels, switch channels, search, and send a message | Slack | Large sidebars and message history remain workable | 4/5 runs; p95 flow under 30s |
| C9-T3 | In a Discord server with many channels and unread states, jump to a target channel and verify it | Discord | Large navigation trees and overlays remain manageable | 4/5 runs; p95 flow under 30s |
| C9-T4 | In a long Notion page with hundreds of blocks, jump, insert, and verify a target block | Notion | Large dynamic documents remain controllable | 4/5 runs; p95 flow under 40s |
| C9-T5 | In a complex Figma file with many layers and pages, select a frame and export it | Figma | Heavy design files do not collapse discovery and verification | 4/5 runs; p95 flow under 45s |

## C10. Actual State Assertion

What it proves: ScreenHand can test outcomes, not just interactions.

| ID | Product-level task | Real apps | What ScreenHand must prove | Pass bar |
|---|---|---|---|---|
| C10-T1 | Assert the exact Slack message content exists in the intended channel after send | Slack | Final state assertion is precise and app-native | 5/5 runs; exact content and channel verified |
| C10-T2 | Assert Notion content persists after reload and contains the expected block structure | Notion | Persistence and structural state can be verified | 5/5 runs; expected content survives reload |
| C10-T3 | Assert Spotify is actually playing the target track and playback progresses | Spotify | Playback state is a verifiable app state, not a button click | 4/5 runs; correct track and advancing progress |
| C10-T4 | Assert Figma export produced the expected file artifact and that Finder sees it | Figma, Finder, Preview | Artifact-level validation works across app boundaries | 4/5 runs; file name and openability verified |
| C10-T5 | Assert a VS Code file edit exists both in-editor and on disk via Terminal or Finder | VS Code, Terminal, Finder | Editor state and filesystem state agree | 5/5 runs; exact file content matches in both places |

## Nightmare Mode: Mixed Product Scenarios

These are not demo flows. They are the “if this passes, ScreenHand is real” scenarios.

| ID | Nightmare scenario | Real apps | Capabilities stressed | Product-level pass bar |
|---|---|---|---|---|
| MX-01 | Triage a failing build: copy error from VS Code terminal, search in Chrome, summarize fix in Notion, post update in Slack | VS Code, Terminal, Chrome, Notion, Slack | C1, C3, C4, C10 | 3 runs; at least 2 pass; no false success on the final Slack update |
| MX-02 | Design handoff: select a Figma frame, export it, verify artifact in Finder and Preview, send handoff note in Slack, log artifact path in Notion | Figma, Finder, Preview, Slack, Notion | C2, C3, C4, C8, C10 | 3 runs; exported file must exist and the exact path must propagate to Slack and Notion |
| MX-03 | Incident response: detect Slack unread badge, open the thread, copy a referenced file name into VS Code, inspect it, then reply with findings | Slack, VS Code | C1, C3, C7, C10 | 3 runs; unread badge clears only after the correct thread is opened and reply posted |
| MX-04 | Documentation loop: pull a Notion task, implement change in VS Code, verify with Terminal, and send completion proof to Slack | Notion, VS Code, Terminal, Slack | C3, C4, C10 | 3 runs; proof must include the exact task title and a successful terminal verification |
| MX-05 | Background precision: keep Slack frontmost while typing commands into VS Code terminal, then switch to Notion and log the output without app drift | Slack, VS Code, Notion | C5, C3, C10 | 3 runs; all text lands in the intended app only |
| MX-06 | UI drift resilience: repeat the same Slack-to-Notion reporting flow with sidebars collapsed, menus changed, and different window arrangements | Slack, Notion | C6, C4, C10 | 3 runs; at least 2 pass with no script edits between runs |
| MX-07 | Heavy app endurance: with a large repo in VS Code and a large workspace in Slack, switch 20 times, perform real edits, and verify both end states | VS Code, Slack | C1, C5, C9, C10 | 3 runs; p95 under 60s for the full flow |
| MX-08 | Figma export under distraction: while Finder is frontmost and Slack receives messages, finish a Figma export and verify the saved artifact anyway | Figma, Finder, Slack, Preview | C4, C5, C7, C8, C10 | 3 runs; exported artifact and notification state both verified |
| MX-09 | Collaboration chaos: Discord mention arrives, user must jump to the right channel, copy context into Notion, and send a coordinated reply in Slack | Discord, Notion, Slack | C2, C3, C7, C10 | 3 runs; correct channel, correct copied context, correct reply destination |
| MX-10 | Release manager day: read release checklist in Notion, edit versioned file in VS Code, verify with Terminal, export design asset from Figma, post launch note in Slack | Notion, VS Code, Terminal, Figma, Finder, Slack | C1, C3, C4, C8, C9, C10 | 3 runs; every artifact and message must match the intended release version |

## What Success Looks Like

ScreenHand has an L3 product if a developer can say:

- “I can write a real test against Slack, VS Code, Figma, or Notion.”
- “The test verifies actual app state, not just a click.”
- “The flow survives normal UI drift.”
- “The report tells me why it failed.”
- “The same task passes repeatedly at a publishable rate.”

If these tasks pass with published pass rates, ScreenHand is not a desktop demo. It is a real desktop testing product.
