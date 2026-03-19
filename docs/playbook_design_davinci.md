# DaVinci Resolve — ScreenHand Playbook Design & Codex Task List

> Goal: Build a battle-tested `playbooks/davinci-resolve.json` by systematically exploring every page, panel, tool, shortcut, and workflow in DaVinci Resolve. Start as absolute beginner, end as expert. Each task = one Codex session.

---

## Phase 0: Setup & App Discovery

### Task 0.1 — Launch & First Screenshot
- Launch DaVinci Resolve via ScreenHand (`launch` tool)
- Take screenshot of the startup screen
- Document: app bundle name, window title, process name
- Record how long app takes to launch (important for timeouts)
- Check if a "project manager" window appears first before main UI

### Task 0.2 — Project Manager Exploration
- Screenshot the Project Manager window
- Run `ui_tree` on the Project Manager
- Document all buttons: New Project, Open, Import, Delete, etc.
- Test `click_text` on "Untitled Project" / "New Project"
- Test `key` for Enter to open selected project
- Record selectors for: project list, search bar, folder sidebar, New Project button
- **Deliverable**: selectors.project_manager section

### Task 0.3 — Create First Project
- Click "New Project" or use shortcut
- Name the project "ScreenHand Test"
- Confirm project opens into the main editor
- Screenshot the main editor window
- Run `ui_tree` on the full main window — record element count and depth
- **Deliverable**: flows.create_project

### Task 0.4 — Page Navigation Discovery
- DaVinci Resolve has 7 pages at the bottom: Media, Cut, Edit, Fusion, Color, Fairlight, Deliver
- Click each page tab, screenshot each page
- Run `ui_tree` on each page — compare element coverage
- Test keyboard shortcuts for page switching (Shift+2 through Shift+8)
- Record which pages have best AX tree coverage
- **Deliverable**: selectors.page_tabs, keyboard_shortcuts.page_navigation

---

## Phase 1: Media Page (Import & Organize)

### Task 1.1 — Media Page Layout
- Navigate to Media page (Shift+2)
- Screenshot and run `ui_tree`
- Identify panels: Media Storage (top-left), Viewer (top-right), Media Pool (bottom-left), Metadata (bottom-right)
- Record selectors for each panel boundary
- **Deliverable**: selectors.media_page

### Task 1.2 — Import Media Files
- Test importing media via: File > Import > Media (menu_click)
- Test drag-and-drop from Finder to Media Pool (if possible with `drag`)
- Test right-click > Import Media in Media Pool
- Test importing: video file (.mp4), image (.png/.jpg), audio (.mp3/.wav)
- Record file dialog selectors
- Test `key Cmd+I` for import shortcut
- **Deliverable**: flows.import_media

### Task 1.3 — Media Pool Organization
- Create bins (folders) in Media Pool — right-click > New Bin
- Rename bins
- Move clips between bins via drag
- Test Smart Bins (auto-organizing by metadata)
- Test search/filter in Media Pool
- Record all right-click context menu items
- **Deliverable**: flows.organize_media, selectors.media_pool

### Task 1.4 — Media Browser & Storage
- Navigate the Media Storage browser (top-left panel)
- Browse to a folder on disk
- Understand the difference: Media Storage (disk browser) vs Media Pool (project assets)
- Test favorite locations
- **Deliverable**: selectors.media_storage

### Task 1.5 — Clip Preview & Metadata
- Select a clip in Media Pool
- Preview in the Viewer — test play/pause (Space), scrub, J/K/L playback
- Check Metadata panel — what fields are editable?
- Test marking In/Out points (I and O keys) in the source viewer
- **Deliverable**: flows.preview_clip, keyboard_shortcuts.playback

---

## Phase 2: Edit Page (Core Editing)

### Task 2.1 — Edit Page Layout
- Navigate to Edit page (Shift+4)
- Screenshot and `ui_tree` the full page
- Identify panels: Media Pool (top-left), Source Viewer (top-center), Timeline Viewer (top-right), Timeline (bottom), Inspector (right), Effects Library (left)
- Record panel toggle shortcuts (show/hide each panel)
- **Deliverable**: selectors.edit_page

### Task 2.2 — Timeline Basics
- Drag a clip from Media Pool to Timeline
- Understand tracks: V1 (video), A1 (audio), how they auto-create
- Test adding multiple clips to timeline
- Test timeline zoom: Cmd+= / Cmd+- or scroll wheel
- Test timeline scroll: horizontal and vertical
- Test playhead movement: click on timeline ruler, arrow keys, Home/End
- **Deliverable**: flows.add_to_timeline, selectors.timeline

### Task 2.3 — Selection & Navigation Tools
- Test tool shortcuts:
  - A = Selection/Arrow tool
  - B = Blade/Razor tool (cut clips)
  - T = Trim tool
  - Shift+T = Dynamic Trim
- Click on clips to select them
- Test multi-select (Shift+click, Cmd+click)
- Test selecting all clips (Cmd+A)
- Record how `ui_find` works on timeline clips
- **Deliverable**: keyboard_shortcuts.edit_tools

### Task 2.4 — Cutting & Trimming
- Use Blade tool (B) to cut a clip at playhead position
- Use Cmd+B to cut at playhead without switching tools
- Test ripple delete (select clip, press Delete)
- Test trim: drag clip edges to shorten/extend
- Test slip and slide editing
- Test split clip and delete gap
- **Deliverable**: flows.cut_clip, flows.trim_clip, flows.ripple_delete

### Task 2.5 — Moving & Rearranging Clips
- Drag clips to reorder on timeline
- Test overwrite vs insert editing modes
- Test copy/paste clips (Cmd+C, Cmd+V)
- Test duplicate (Alt+drag)
- Test moving clips between tracks
- Test snap to playhead / snap to clip edge (N = toggle snapping)
- **Deliverable**: flows.move_clips, flows.insert_edit, flows.overwrite_edit

### Task 2.6 — Inspector Panel
- Select a clip on timeline
- Open Inspector panel (if not visible)
- Explore tabs: Video, Audio, Transition, Effects
- Test Transform controls: Position X/Y, Scale, Rotation, Anchor Point
- Test Crop controls
- Test Opacity slider
- Test `ui_set_value` on Inspector sliders/fields
- Test resetting values (right-click > Reset)
- **Deliverable**: selectors.inspector, flows.transform_clip

### Task 2.7 — Source/Timeline Viewer Controls
- Test viewer toolbar buttons: play, pause, loop, mark in/out
- Test full-screen preview (Cmd+F or P)
- Test viewer zoom and pan
- Test overlay options in viewer
- **Deliverable**: selectors.viewer

---

## Phase 3: Text, Titles & Effects

### Task 3.1 — Adding Titles/Text
- Open Effects Library > Toolbox > Titles
- Find: Text, Text+ (Fusion-based), Lower Third, Scroll
- Drag a title to the timeline
- Edit text content in Inspector
- Test font, size, color, alignment changes
- Test positioning title on screen via Inspector Transform
- **Deliverable**: flows.add_title, selectors.title_inspector

### Task 3.2 — Text+ (Fusion Titles)
- Add a Text+ title (more powerful than basic Text)
- Edit in Inspector: Rich Text tab
- Test character-level styling
- Test text animations if available in Inspector
- This is the main title tool for professional work
- **Deliverable**: flows.text_plus

### Task 3.3 — Video Transitions
- Open Effects Library > Toolbox > Video Transitions
- Drag a transition between two clips on timeline
- Test: Cross Dissolve, Dip to Color, Wipe, Blur Dissolve
- Adjust transition duration by dragging edges
- Adjust transition properties in Inspector
- Test applying default transition: Cmd+T
- **Deliverable**: flows.add_transition, selectors.transitions

### Task 3.4 — Video Effects (OpenFX)
- Open Effects Library > OpenFX
- Browse effect categories: Blur, Color, Light, Stylize, etc.
- Drag an effect onto a clip (e.g., Gaussian Blur)
- Adjust effect parameters in Inspector > Effects tab
- Test enable/disable effect toggle
- Test removing an effect
- Test stacking multiple effects
- **Deliverable**: flows.add_effect, selectors.effects_library

### Task 3.5 — Generators & Backgrounds
- Effects Library > Toolbox > Generators
- Test: Solid Color, Gradient, 10-Point Color Gradient
- Place generator on timeline as a background
- Adjust generator properties
- **Deliverable**: flows.add_generator

---

## Phase 4: Audio Editing

### Task 4.1 — Audio on Edit Page
- Understand audio tracks in timeline (A1, A2, etc.)
- Test audio clip volume: drag the volume line on audio clip
- Test mute/solo tracks
- Test audio fade handles (drag from clip corners)
- Test unlinking audio from video (right-click > Link Clips)
- **Deliverable**: flows.audio_basic

### Task 4.2 — Audio Transitions & Effects
- Add audio crossfade between clips
- Apply audio effects from Effects Library
- Test EQ, Compressor, De-Esser if available
- **Deliverable**: flows.audio_effects

### Task 4.3 — Fairlight Page Basics
- Navigate to Fairlight page (Shift+7)
- Screenshot and `ui_tree`
- Understand mixer panel, timeline, meters
- Test volume faders on mixer
- Test pan knobs
- Test adding audio tracks
- Test recording voiceover (if mic available)
- **Deliverable**: selectors.fairlight_page, flows.audio_mix

### Task 4.4 — Music & Sound Design
- Import background music track
- Place on a lower audio track
- Adjust volume to sit under dialogue
- Test audio ducking / sidechain if available
- **Deliverable**: flows.add_music

---

## Phase 5: Color Grading (Color Page)

### Task 5.1 — Color Page Layout
- Navigate to Color page (Shift+6)
- Screenshot and `ui_tree`
- Identify panels: Node Editor, Viewer, Gallery, Scopes, Color Wheels, Curves, Qualifiers
- This is DaVinci Resolve's flagship feature — document thoroughly
- **Deliverable**: selectors.color_page

### Task 5.2 — Color Wheels & Lifts/Gamma/Gain
- Find the Color Wheels panel (Lift, Gamma, Gain, Offset)
- Test adjusting each wheel: drag center point, drag outer ring
- Test the master wheel controls
- Test `ui_set_value` on the numeric inputs
- Reset wheels (double-click center)
- **Deliverable**: flows.color_wheels

### Task 5.3 — Node Editor
- Understand the node-based color pipeline
- Default: one Serial Node (01)
- Test adding nodes: Alt+S (serial), Alt+P (parallel), Alt+L (layer)
- Test selecting nodes (click)
- Test bypassing nodes (Cmd+D)
- Test deleting nodes
- Test labeling nodes (right-click > Label)
- **Deliverable**: flows.color_nodes, keyboard_shortcuts.color_nodes

### Task 5.4 — Curves
- Find Curves panel (may need to toggle panel visibility)
- Test Custom Curves (master RGB)
- Test individual R, G, B curves
- Test Hue vs Sat, Hue vs Hue, Hue vs Lum curves
- Add control points by clicking on curve
- **Deliverable**: flows.color_curves

### Task 5.5 — LUTs (Look Up Tables)
- Apply a LUT: right-click on node > LUT
- Browse built-in LUTs
- Import custom LUTs (.cube files)
- Test LUT intensity adjustment
- LUTs are the fastest way to apply a "look" — important for automation
- **Deliverable**: flows.apply_lut

### Task 5.6 — Color Presets & Stills
- Save a color grade as a Still (Gallery)
- Apply a Still from Gallery to another clip
- Test applying grade to all clips (right-click > Apply Grade)
- Test PowerGrades (cross-project reusable grades)
- **Deliverable**: flows.save_grade, flows.apply_grade_to_all

### Task 5.7 — Scopes
- Find the Scopes panel (Waveform, Vectorscope, Histogram, Parade)
- Toggle between scope types
- Understand how to read each scope
- This is for verification — important for automation to confirm color changes
- **Deliverable**: selectors.scopes

### Task 5.8 — Qualifiers & Windows
- Test Qualifier (isolate specific colors for adjustment)
  - HSL Qualifier: pick a color range
- Test Power Windows (apply grade to specific area)
  - Circle, Linear Gradient, Polygon, Curve windows
- These enable targeted color work
- **Deliverable**: flows.qualifier, flows.power_window

---

## Phase 6: Fusion Page (Motion Graphics)

### Task 6.1 — Fusion Page Layout
- Navigate to Fusion page (Shift+5)
- Screenshot and `ui_tree`
- Identify: Node Editor (center), Viewers (top), Toolbar (top), Inspector (right), Spline/Keyframe editors (bottom)
- Fusion is node-based compositing — different paradigm from timeline
- **Deliverable**: selectors.fusion_page

### Task 6.2 — Basic Fusion Nodes
- Understand MediaIn (input from timeline) and MediaOut (output to timeline)
- Add a Text+ node from toolbar
- Connect nodes by dragging from output to input
- Test adding: Background, Merge, Transform
- Test selecting, moving, and connecting nodes
- **Deliverable**: flows.fusion_basic_nodes

### Task 6.3 — Fusion Text Animations
- Create an animated title in Fusion
- Add keyframes for Position, Size, Opacity
- Test the Spline editor for easing curves
- Test animation templates/macros if available
- **Deliverable**: flows.fusion_text_animation

### Task 6.4 — Fusion Shapes & Motion Graphics
- Create shape nodes (Rectangle, Ellipse, Polygon)
- Animate shapes for lower thirds, transitions, intros
- Test Merge node for compositing layers
- Test masks and mattes
- **Deliverable**: flows.fusion_shapes

### Task 6.5 — Fusion Templates & Macros
- Explore built-in Fusion templates
- Test saving a composition as a Macro for reuse
- Test Fusion compositions that can be reused across projects
- **Deliverable**: flows.fusion_templates

---

## Phase 7: Cut Page (Fast Editing)

### Task 7.1 — Cut Page Layout
- Navigate to Cut page (Shift+3)
- Screenshot and `ui_tree`
- Cut page is designed for fast assembly editing
- Identify: dual timeline (overview + detail), source tape, media pool
- Document how it differs from Edit page
- **Deliverable**: selectors.cut_page

### Task 7.2 — Quick Edit Workflow
- Test Source Tape mode (scrub through all media sequentially)
- Test Smart Insert, Append, Close Up
- Test in/out points and quick edits
- Test Sync Bin for multicam
- This page is ideal for fast assembly — good for automation
- **Deliverable**: flows.quick_assembly

---

## Phase 8: Deliver Page (Export)

### Task 8.1 — Deliver Page Layout
- Navigate to Deliver page (Shift+8)
- Screenshot and `ui_tree`
- Identify: Render Settings (left), Viewer (center), Render Queue (right)
- **Deliverable**: selectors.deliver_page

### Task 8.2 — Export Presets
- Test built-in presets: YouTube (1080p/4K), Vimeo, Twitter, H.264, H.265, ProRes
- Click each preset and document the settings it applies
- Test Custom preset creation
- **Deliverable**: flows.select_export_preset

### Task 8.3 — Custom Export Settings
- Test changing: Resolution, Frame Rate, Codec, Quality, Bitrate
- Test changing file format: MP4, MOV, MKV
- Test audio format settings
- Test output filename and destination path
- Test "Use Optimized Media" and "Use Proxy Media" checkboxes
- **Deliverable**: selectors.render_settings

### Task 8.4 — Render Queue & Batch Export
- Click "Add to Render Queue"
- Test adding multiple jobs with different settings (e.g., YouTube + Instagram)
- Click "Render All" to start rendering
- Monitor render progress bar
- Test canceling a render
- This is critical for automation — batch export multiple formats
- **Deliverable**: flows.add_to_render_queue, flows.render_all, flows.batch_export

### Task 8.5 — Quick Export
- Test File > Quick Export (Cmd+Shift+E)
- This bypasses the Deliver page for simple exports
- Document the quick export dialog selectors
- **Deliverable**: flows.quick_export

---

## Phase 9: Advanced Features

### Task 9.1 — Multicam Editing
- Import multiple camera angles of same scene
- Create Multicam Clip (right-click in Media Pool)
- Switch angles on timeline
- Test angle switching shortcuts
- **Deliverable**: flows.multicam

### Task 9.2 — Speed Changes
- Right-click clip > Change Clip Speed
- Test speed ramp (variable speed)
- Test reverse clip
- Test freeze frame
- Test optical flow for smooth slow motion
- **Deliverable**: flows.speed_change, flows.speed_ramp

### Task 9.3 — Markers
- Add marker on timeline: M key
- Add marker on clip
- Edit marker: name, color, duration, notes
- Navigate between markers: Shift+Up/Down
- Use markers for chapter points or review notes
- **Deliverable**: flows.markers, keyboard_shortcuts.markers

### Task 9.4 — Compound Clips & Nested Timelines
- Select multiple clips > right-click > New Compound Clip
- Test editing inside a compound clip (double-click to enter)
- Test nesting timelines
- **Deliverable**: flows.compound_clip

### Task 9.5 — Adjustment Clips
- Add Adjustment Clip from Effects Library
- Place on track above other clips
- Apply effects to adjustment clip (affects everything below)
- Great for applying same effect across multiple clips
- **Deliverable**: flows.adjustment_clip

### Task 9.6 — Subtitles & Captions
- Timeline > Create Subtitle Track
- Add subtitle entries manually
- Test auto-caption / transcription if available (v19+)
- Edit subtitle text, timing, style
- Export subtitles as SRT/VTT
- **Deliverable**: flows.subtitles

---

## Phase 10: DaVinci Resolve Scripting API

### Task 10.1 — Scripting API Discovery
- DaVinci Resolve has a Python/Lua scripting API
- Find the Scripting API documentation (usually in app bundle or Help menu)
- Test accessing API: Help > Documentation or check `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/`
- Find the Resolve Script module location
- **Deliverable**: Document API access path and available methods

### Task 10.2 — Console/Script Access
- Open Resolve's built-in console: Workspace > Console
- Test running a Lua script in console
- Test running Python script externally that connects to Resolve
- Test: `resolve = dvr_script.scriptapp("Resolve")`
- **Deliverable**: flows.open_console, flows.run_script

### Task 10.3 — API: Project & Timeline Operations
- Script: Create new project
- Script: Create new timeline
- Script: Add media to Media Pool
- Script: Add clips to timeline programmatically
- Script: Get current timeline info (name, duration, track count)
- **Deliverable**: api.project_operations, api.timeline_operations

### Task 10.4 — API: Export & Render
- Script: Set render settings
- Script: Add render job
- Script: Start render
- Script: Check render status/progress
- This is the most important API area for batch automation
- **Deliverable**: api.render_operations

### Task 10.5 — API: Color Grading
- Script: Apply LUT to a clip
- Script: Add/modify nodes
- Script: Read/write grade data
- Script: Copy grade between clips
- **Deliverable**: api.color_operations

### Task 10.6 — ScreenHand + API Integration
- Test running Python API scripts via ScreenHand's `applescript` or `key` (run from Terminal)
- Design hybrid approach: UI automation for visual tasks, API for batch/programmatic tasks
- Document which tasks are better via API vs UI
- **Deliverable**: integration_strategy

---

## Phase 11: Keyboard Shortcuts Complete Map

### Task 11.1 — Global Shortcuts
- Document all global shortcuts that work on every page
- File operations: Cmd+S (save), Cmd+Z (undo), Cmd+Shift+Z (redo)
- Page navigation: Shift+2 through Shift+8
- Playback: Space, J/K/L, arrow keys
- Full screen: Cmd+F
- **Deliverable**: keyboard_shortcuts.global

### Task 11.2 — Edit Page Shortcuts
- All editing shortcuts: A, B, T, N, Cmd+B, Delete, Cmd+T
- Timeline navigation: Home, End, Up/Down arrows
- Clip operations: Cmd+C, Cmd+V, Cmd+X
- Mark In/Out: I, O, Alt+X (clear marks)
- **Deliverable**: keyboard_shortcuts.edit

### Task 11.3 — Color Page Shortcuts
- Node shortcuts: Alt+S, Alt+P, Alt+L, Cmd+D
- Reset: Shift+Home (reset all grades)
- Navigate clips: Arrow keys in color page
- **Deliverable**: keyboard_shortcuts.color

### Task 11.4 — Custom Keyboard Shortcut Map
- DaVinci Resolve > Keyboard Customization (Cmd+Alt+K)
- Document the customization dialog
- Test remapping a shortcut
- Test saving/loading shortcut presets
- **Deliverable**: flows.customize_shortcuts

---

## Phase 12: Menu Bar Complete Map

### Task 12.1 — File Menu
- Explore every item in File menu via `menu_click`
- Document: New Project, New Timeline, Save, Save As, Import, Export, Project Settings
- Record which items have submenus
- **Deliverable**: selectors.menu_file

### Task 12.2 — Edit Menu
- All items: Undo, Redo, Cut, Copy, Paste, Select All, Preferences
- **Deliverable**: selectors.menu_edit

### Task 12.3 — Workspace Menu
- Layout presets, panel toggles, dual screen
- Reset UI Layout
- **Deliverable**: selectors.menu_workspace

### Task 12.4 — All Remaining Menus
- Clip, Timeline, Mark, View, Playback, Fusion, Color, Fairlight menus
- Document every menu item path
- This is critical — `menu_click` is the most reliable automation method
- **Deliverable**: selectors.menu_complete

---

## Phase 13: Preferences & Project Settings

### Task 13.1 — Preferences Dialog
- Open: DaVinci Resolve > Preferences (Cmd+,)
- Screenshot each tab
- Run `ui_tree` on preferences dialog
- Document: System, User, Media Storage, Hardware tabs
- Record important settings and their selectors
- **Deliverable**: selectors.preferences

### Task 13.2 — Project Settings
- Open: File > Project Settings (Shift+9)
- Document: Master Settings, Timeline Resolution, Frame Rate, Color Management
- These settings are per-project and crucial for correct output
- **Deliverable**: selectors.project_settings, flows.configure_project

---

## Phase 14: Common Marketing Workflows (Automation Playbooks)

### Task 14.1 — Social Media Ad (15-30 sec)
- Create complete workflow: Import clip > Trim to 15s > Add text overlay > Add logo > Add CTA > Export for Instagram/TikTok
- Vertical format (1080x1920)
- Test the full flow end-to-end via ScreenHand
- Record every tool call in sequence
- **Deliverable**: flows.social_ad_vertical

### Task 14.2 — YouTube Video Assembly
- Import multiple clips > Assemble on timeline > Add intro title > Add transitions > Color correct > Add background music > Add end card > Export 1080p
- Horizontal format (1920x1080)
- **Deliverable**: flows.youtube_video

### Task 14.3 — Product Demo / Walkthrough
- Import screen recording + voiceover > Sync > Add zoom-in animations (Transform keyframes) > Add text callouts > Export
- **Deliverable**: flows.product_demo

### Task 14.4 — UGC-Style Content
- Import raw footage > Quick cuts (Cut page) > Subtitles > Trending music > Export vertical
- Fast, raw aesthetic — minimal color grading
- **Deliverable**: flows.ugc_content

### Task 14.5 — Cinematic Ad
- Import footage > Full color grade (Color page, LUT + wheels) > Add cinematic bars (letterbox) > Typography > Sound design > Export 4K
- This tests the full pipeline
- **Deliverable**: flows.cinematic_ad

### Task 14.6 — Batch Export Multi-Format
- From one finished timeline, export:
  - YouTube 1080p (16:9)
  - Instagram Reel (9:16)
  - Instagram Feed (1:1)
  - TikTok (9:16)
  - Twitter/X (16:9, <2min)
  - LinkedIn (16:9)
- Test using Deliver page with multiple render queue entries
- **Deliverable**: flows.batch_export_social

### Task 14.7 — Template Project
- Create a reusable project template with:
  - Pre-built timeline structure (intro, content, outro)
  - Brand colors as saved grades
  - Logo placement
  - Standard text styles
  - Export presets configured
- Save as a template project
- **Deliverable**: flows.create_template, flows.use_template

---

## Phase 15: Detection & State Verification

### Task 15.1 — State Detection Patterns
- Build detection checks:
  - `is_project_open`: How to verify a project is loaded
  - `is_on_page_X`: How to detect which page (Media/Edit/Color/etc.) is active
  - `has_timeline`: How to verify a timeline exists and has clips
  - `is_playing`: How to detect playback state
  - `is_rendering`: How to detect render in progress
  - `has_unsaved_changes`: Window title asterisk or other indicator
- Use `ocr`, `screenshot`, `ui_find` for each detection
- **Deliverable**: detection section of playbook

### Task 15.2 — Error State Detection
- Document common error dialogs and how to detect/dismiss them
- Media offline errors
- Codec not supported errors
- Render failed errors
- Project load errors
- GPU/memory warnings
- **Deliverable**: errors section of playbook

---

## Phase 16: Playbook Assembly & Testing

### Task 16.1 — Compile Playbook JSON
- Assemble all selectors, flows, keyboard_shortcuts, detection, errors into `playbooks/davinci-resolve.json`
- Follow the same JSON structure as `playbooks/figma.json`
- Include `_note` fields explaining why each approach was chosen
- Add success/fail counts from testing
- Set version to 1.0.0

### Task 16.2 — End-to-End Test: Social Ad
- Run the social_ad_vertical flow from start to finish
- Record success/failure of each step
- Fix any broken selectors or flows
- Update playbook with corrections

### Task 16.3 — End-to-End Test: YouTube Video
- Run youtube_video flow from start to finish
- Record results, fix issues

### Task 16.4 — End-to-End Test: Cinematic Ad
- Run cinematic_ad flow from start to finish
- This tests the most complex workflow
- Record results, fix issues

### Task 16.5 — Playbook Stress Test
- Run all flows back-to-back
- Test with different media types (4K, vertical, photos, audio)
- Test recovery from errors
- Document failure modes and workarounds
- Update success/fail counts
- Tag final version

---

## Codex Task Assignment Strategy

### Priority Order (build knowledge bottom-up):
1. **Phase 0** — Must do first (setup, app discovery)
2. **Phase 12** — Menu bar map (unlocks `menu_click` for everything)
3. **Phase 11** — Keyboard shortcuts (unlocks `key` for everything)
4. **Phase 1** — Media import (need media before editing)
5. **Phase 2** — Edit page (core editing)
6. **Phase 8** — Deliver page (need export early for testing)
7. **Phase 3** — Text & effects
8. **Phase 4** — Audio
9. **Phase 5** — Color grading
10. **Phase 7** — Cut page
11. **Phase 6** — Fusion page
12. **Phase 9** — Advanced features
13. **Phase 10** — Scripting API
14. **Phase 13** — Settings
15. **Phase 15** — Detection patterns
16. **Phase 14** — Marketing workflows (needs everything above)
17. **Phase 16** — Assembly & testing

### Codex Session Format (use this prompt template):
```
You are exploring DaVinci Resolve using ScreenHand MCP tools.
Your goal: [Task X.X description]

Rules:
1. Take a screenshot FIRST before any action
2. Run ui_tree to understand the current UI state
3. Try the action using the best ScreenHand tool
4. If it fails, try fallback tools (click_text, ocr, key)
5. Record EXACTLY what worked and what failed
6. Output a JSON snippet for the playbook section

Current app state: [describe where we left off]
Previous findings: [link to playbook-in-progress]
```

### Estimated Codex Sessions: ~50-60 tasks
### Estimated Token Usage: ~2-3M tokens total (vs ~15-20M if done manually)

---

## Output Files

| File | Purpose |
|---|---|
| `playbooks/davinci-resolve.json` | Main playbook (selectors, flows, shortcuts, detection) |
| `docs/davinci_codex.md` | Capabilities summary (like figma_codex.md) |
| `docs/davinci_api.md` | Scripting API reference for ScreenHand integration |

---

## Success Criteria

- [ ] 95%+ of UI elements have working selectors
- [ ] Every page has `ui_tree` coverage documented
- [ ] All 300+ keyboard shortcuts mapped
- [ ] Full menu bar mapped for `menu_click`
- [ ] 7 marketing workflow playbooks working end-to-end
- [ ] Scripting API integrated for batch operations
- [ ] Detection patterns for all common states
- [ ] Error handling for all common failures
- [ ] Playbook JSON compiled and version-tagged
- [ ] Stress tested across different media types
