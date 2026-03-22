#!/usr/bin/env npx tsx
// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.
//
// ScreenHand is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, version 3.
//
// ScreenHand is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with ScreenHand. If not, see <https://www.gnu.org/licenses/>.

/**
 * ScreenHand — MCP Server for Desktop Automation
 * Controls any macOS/Windows app + Chrome browser via CDP.
 *
 * Setup — add to ~/.claude/settings.json or project .mcp.json:
 * {
 *   "mcpServers": {
 *     "screenhand": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/screenhand/mcp-desktop.ts"]
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import fs from "node:fs";
import { BridgeClient } from "./src/native/bridge-client.js";
import { writeFileAtomicSync, readJsonWithRecovery } from "./src/util/atomic-write.js";
import { sanitizeUrl, redactSensitiveLabel, redactUsername, redactPII } from "./src/util/sanitize.js";
import { MemoryService } from "./src/memory/service.js";
import type { ActionEntry, ErrorPattern } from "./src/memory/types.js";
import { backgroundResearch } from "./src/memory/research.js";
import { SessionSupervisor, LeaseManager } from "./src/supervisor/supervisor.js";
import type { RecoveryAction } from "./src/supervisor/types.js";
import { JobManager } from "./src/jobs/manager.js";
import { JobRunner } from "./src/jobs/runner.js";
import { getWorkerLiveStatus, getWorkerDaemonPid, WORKER_PID_FILE, WORKER_LOG_FILE } from "./src/jobs/worker.js";
import type { JobState } from "./src/jobs/types.js";
import { JOB_STATES } from "./src/jobs/types.js";
import { PlaybookEngine } from "./src/playbook/engine.js";
import { PlaybookStore } from "./src/playbook/store.js";
import { ContextTracker } from "./src/context-tracker.js";
import { McpPlaybookRecorder } from "./src/playbook/mcp-recorder.js";
import { WorldModel } from "./src/state/index.js";
import { PerceptionManager } from "./src/perception/index.js";
import { Planner, PlanExecutor, GoalStore, ToolRegistry } from "./src/planner/index.js";
import { RecoveryEngine } from "./src/recovery/index.js";
import { LearningEngine, LocatorPolicy } from "./src/learning/index.js";
import type { ExecutionPause } from "./src/planner/index.js";
import { discoverWebElements, testWebElement, compileReference, saveExploreResult, discoverNativeElements } from "./src/platform/explorer.js";
import { buildDocUrls, crawlPage, compileLearnResult, saveLearnResult } from "./src/platform/learner.js";
import { AccessibilityAdapter } from "./src/runtime/accessibility-adapter.js";
import { AutomationRuntimeService } from "./src/runtime/service.js";
import { LocatorCache } from "./src/runtime/locator-cache.js";
import { TimelineLogger } from "./src/logging/timeline-logger.js";
import { readObserverState, getObserverDaemonPid, submitObserverCommand, getObserverCommand } from "./src/observer/state.js";
import { OBSERVER_DIR, OBSERVER_PID_FILE, OBSERVER_LOG_FILE } from "./src/observer/types.js";
import { spawn } from "node:child_process";
import os from "node:os";
import { MenuScanner } from "./src/ingestion/menu-scanner.js";
import { DocParser } from "./src/ingestion/doc-parser.js";
import { TutorialExtractor } from "./src/ingestion/tutorial-extractor.js";
import type { TranscriptSegment } from "./src/ingestion/tutorial-extractor.js";
import { CoverageAuditor } from "./src/ingestion/coverage-auditor.js";
import { ReferenceMerger } from "./src/ingestion/reference-merger.js";
import { PlaybookPublisher } from "./src/community/publisher.js";
import { PlaybookFetcher } from "./src/community/fetcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Audit logging for dangerous tools ──
const AUDIT_LOG_PATH = path.resolve(__dirname, ".audit-log.jsonl");

function auditLog(tool: string, params: Record<string, unknown>) {
  const entry = {
    timestamp: new Date().toISOString(),
    tool,
    params,
    pid: process.pid,
  };
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Non-critical — don't crash if log write fails
  }
}
const bridgePath = process.platform === "win32"
  ? path.resolve(__dirname, "native/windows-bridge/bin/Release/net8.0-windows/windows-bridge.exe")
  : path.resolve(__dirname, "native/macos-bridge/.build/release/macos-bridge");
const bridge = new BridgeClient(bridgePath);
let bridgeReady = false;

// Focus mutex — only one focus() call runs at a time since only one app can be frontmost.
// Prevents N concurrent focus calls from generating N*5 bridge calls that overwhelm the bridge.
let focusLock: Promise<void> = Promise.resolve();

async function ensureBridge() {
  if (!bridgeReady) {
    await bridge.start();
    bridgeReady = true;
    perceptionManager.createSources(bridge);
  }
}

/** Window titles that indicate auxiliary/utility windows — deprioritize these */
const AUXILIARY_WINDOW_TITLES = new Set([
  "Privacy Report", "Downloads", "Extensions", "Bookmarks",
  "History", "Preferences", "Settings", "Web Inspector",
]);

/**
 * L3-04 fix: Check if a PID is running — checks app.list first, then falls back to
 * app.frontmost and window list. Some Electron apps (Slack, Discord) don't appear in
 * NSWorkspace.runningApplications but are visible via CGWindowList and frontmost checks.
 */
async function isPidRunning(pid: number): Promise<boolean> {
  try {
    const apps = await bridge.call<any[]>("app.list", {});
    if (apps?.some((a: any) => a.pid === pid)) return true;
  } catch { /* ignore */ }
  // Fallback 1: check frontmost
  try {
    const front = await bridge.call<{ pid: number }>("app.frontmost", {});
    if (front.pid === pid) return true;
  } catch { /* ignore */ }
  // Fallback 2: check window list
  try {
    const wins = await bridge.call<any[]>("app.windows");
    if (wins?.some((w: any) => (w.pid || w.ownerPid) === pid)) return true;
  } catch { /* ignore */ }
  return false;
}

/** Resolve the native windowId for a given PID via the AX bridge. */
async function resolveWindowId(pid: number): Promise<number | undefined> {
  // Prefer AX-enriched window.list — returns focused/isMain fields from AX API
  try {
    const wins = await bridge.call<any[]>("window.list", {});
    const matching = wins?.filter((w: any) => w.pid === pid);
    if (matching && matching.length > 0) {
      // Filter out auxiliary windows (Privacy Report, Downloads, etc.)
      const contentWindows = matching.filter(
        (w: any) => !AUXILIARY_WINDOW_TITLES.has(w.title) && w.subrole !== "AXFloatingWindow",
      );
      const candidates = contentWindows.length > 0 ? contentWindows : matching;

      // Prefer focused > isMain > first content window
      const focused = candidates.find((w: any) => w.focused);
      if (focused?.windowId != null) return focused.windowId;
      const main = candidates.find((w: any) => w.isMain);
      if (main?.windowId != null) return main.windowId;
      const win = candidates[0];
      if (win?.windowId != null) return win.windowId;
    }
  } catch { /* fall through */ }
  try {
    // Fallback to CG-based app.windows (no focused/isMain, may crash on GPU-heavy windows)
    const wins = await bridge.call<any[]>("app.windows");
    const matching = wins?.filter((w: any) => w.pid === pid);
    if (matching && matching.length > 0) {
      // Still filter auxiliary windows even in fallback path
      const content = matching.filter((w: any) => !AUXILIARY_WINDOW_TITLES.has(w.title));
      const win = content.length > 0 ? content[0] : matching[0];
      if (win?.windowId != null) return win.windowId;
    }
  } catch { /* ignore */ }
  return undefined;
}

/** Check if the focused app is a browser — used to enable safeCLI capture mode */
function isBrowserApp(): boolean {
  const bundleId = worldModel.getState().focusedApp?.bundleId ?? "";
  return /^com\.(apple\.Safari|google\.Chrome|microsoft\.edgemac)$|^org\.mozilla\.firefox$/.test(bundleId);
}

/**
 * Install async Safari browser enricher on the perception coordinator.
 * Non-blocking — uses async exec instead of execSync.
 * Only installs if bundleId is Safari; clears enricher otherwise.
 */
function installSafariEnricher(bundleId: string): void {
  const coord = perceptionManager.getCoordinator();
  if (!coord) return;

  if (bundleId !== "com.apple.Safari") {
    coord.setBrowserEnricher(null);
    return;
  }

  coord.setBrowserEnricher(async () => {
    const script = `tell application "Safari"
  set t to current tab of front window
  set tabInfo to name of t & "|" & URL of t
  set tabList to ""
  set tabIdx to 1
  repeat with w in windows
    repeat with tb in tabs of w
      set isActive to (tb = current tab of w) as string
      set tabList to tabList & tabIdx & "|" & name of tb & "|" & URL of tb & "|" & isActive & "\\n"
      set tabIdx to tabIdx + 1
    end repeat
  end repeat
  return tabInfo & "\\n---\\n" & tabList
end tell`;
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const result = (stdout ?? "").trim();
    if (result) {
      const [currentLine, , ...tabLines] = result.split("\n");
      const [title, url] = (currentLine ?? "").split("|");
      const tabs = tabLines
        .filter((l: string) => l.includes("|"))
        .map((l: string) => {
          const [idx, tTitle, tUrl, active] = l.split("|");
          return { index: parseInt(idx ?? "0", 10), title: tTitle ?? "", url: tUrl ?? "", isActive: active === "true" };
        });
      if (url) worldModel.ingestSafariBrowserState(url, title ?? "", tabs.length > 0 ? tabs : undefined);
    }
  });
}

// CDP connection cache
let cdpPort: number | null = null;
let CDP: any = null;

async function ensureCDP(overridePort?: number): Promise<{ CDP: any; port: number }> {
  if (!CDP) CDP = (await import("chrome-remote-interface")).default;
  // Validate port range (defense in depth — Zod validates at MCP boundary, this catches internal callers)
  if (overridePort && (overridePort < 9222 || overridePort > 9999)) {
    throw new Error(`Invalid CDP port ${overridePort} — must be 9222-9999`);
  }
  // If caller specified a port, use it directly (e.g. 9333 for Electron apps)
  if (overridePort) {
    try { await CDP.Version({ port: overridePort }); return { CDP, port: overridePort }; } catch {
      throw new Error(`CDP not available on port ${overridePort}. Ensure the app is running with --remote-debugging-port=${overridePort}`);
    }
  }
  if (cdpPort) {
    try { await CDP.Version({ port: cdpPort }); return { CDP, port: cdpPort }; } catch {}
  }
  // Try common ports (9222-9224 = Chrome, 9333 = Codex desktop)
  for (const p of [9222, 9223, 9224, 9333]) {
    try { await CDP.Version({ port: p }); cdpPort = p; return { CDP, port: p }; } catch {}
  }
  throw new Error("Chrome not running with --remote-debugging-port. Launch with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug");
}

const server = new McpServer({ name: "screenhand", version: "3.0.0" }, {
  instructions: `ScreenHand gives you native desktop control on macOS/Windows. 111 tools. Never click blind — always follow: KNOW → SEE → NAVIGATE → ACT → VERIFY → STOP.

## The Golden Sequence (follow this order)

### 1. KNOW (before touching anything)
platform_guide("figma")          → get selectors, flows, known errors for this app/site
memory_recall("figma export")    → check if you've done this before — reuse past strategies
scan_menu_bar()                  → discover all menu items in the current app

If platform_guide() has no data: platform_explore("bundleId") to auto-discover the app, or platform_learn("domain") for websites.

### 2. SEE (understand current state)
apps()                           → what's running?
perception_start()               → turn on continuous monitoring (3-rate: 100ms/300ms/1000ms)
world_state()                    → current app, windows, controls, dialogs
screenshot()                     → visual confirmation if needed

perception_start() keeps world_state() continuously updated. Use it for complex multi-step workflows.

### 3. NAVIGATE (get to the right place)
focus("com.figma.Desktop")       → bring app to front
ui_tree()                        → see all clickable elements with roles and labels
ui_find("Export")                → check if a specific target exists before clicking

### 4. ACT (do the thing)
click_with_fallback("Export")    → click element (auto-tries AX → CDP → OCR → coordinates)
type_with_fallback("filename")   → type text with auto-fallback
key("cmd+shift+e")               → keyboard shortcuts
drag(fromX, fromY, toX, toY)     → drag and drop
scroll(direction)                → scroll up/down/left/right

Always prefer *_with_fallback tools over bare click/type — they auto-recover when one method fails.

### 5. VERIFY (confirm it worked)
world_state()                    → did UI change as expected?
world_state_diff()               → what exactly changed since last check?
screenshot()                     → visual proof

### 6. STOP (clean up)
perception_stop()                → stop monitoring (save resources)
memory_save("figma_export", ...) → save successful strategy for next time

## For Web/Browser (Chrome, Electron apps)
browser_navigate("https://...")  → go to URL
browser_stealth()                → activate FIRST if site has bot detection
browser_dom()                    → read page structure (CSS selectors)
browser_click("#submit")         → click element by CSS selector
browser_type("input", "text")    → type into form field
browser_fill_form({...})         → fill multiple fields at once (human-like timing)
browser_js("return ...")         → run JavaScript for complex extraction/actions
browser_wait("selector")         → wait for element to appear
browser_human_click(x, y)        → human-like click with randomized timing

All browser tools work in the background (~10ms) — no need to focus Chrome.

## For Complex Multi-Step Tasks (let ScreenHand plan it)
plan_goal("Export video as H.264")  → describe WHAT you want — ScreenHand generates steps from playbooks, strategies, and references
plan_execute(goalId)                → auto-run deterministic steps, pauses at LLM steps for your judgment
plan_step_resolve(goalId, tool, params) → you provide the tool+params for LLM steps
plan_status(goalId)                 → check progress
plan_cancel(goalId)                 → abort if needed

On success, the strategy is auto-saved to memory for future reuse.

## For Repeatable Workflows (automate once, run forever)
playbook_record()                → start recording your actions
... do the work ...
export_playbook()                → save as reusable playbook
job_create("daily post", steps)  → make it a persistent job
worker_start()                   → background daemon runs jobs autonomously

Jobs survive MCP client restarts. worker_start() runs independently.

## For Multi-Agent Coordination
session_claim()                  → claim exclusive access to an app window (lease-based)
session_heartbeat()              → keep your lease alive (call periodically)
session_release()                → release when done
supervisor_start()               → daemon that detects stalled agents and auto-recovers

## Self-Healing (automatic — no action needed)
When any tool fails, ScreenHand automatically tries alternative strategies (AX → CDP → OCR → coordinates). Learning is also automatic — every tool call teaches which selectors work, optimal timing, and recovery rankings per app. Check with:
- learning_status()              → see learned preferences per app
- recovery_status()              → see active cooldowns and cached strategies
- recovery_configure()           → tune recovery budget (max time, max retries)

## Tool Speed Priority
1. **ui_tree + ui_press** — native Accessibility API, ~50ms (fastest, most reliable)
2. **browser_* tools** — Chrome DevTools Protocol, ~10ms (background, no focus needed)
3. ***_with_fallback** — auto-tries multiple methods (~100-500ms)
4. **screenshot + ocr** — visual capture, ~600ms (only for canvas apps)
5. **applescript** — macOS scripting (Finder, Mail, Safari, etc.)

## Key Rule
Never click blind. Always: KNOW → SEE → NAVIGATE → ACT → VERIFY.
`,
});

// ═══════════════════════════════════════════════
// LEARNING MEMORY — cached, auto-recall, non-blocking
// ═══════════════════════════════════════════════

const memory = new MemoryService(__dirname);
memory.init(); // One-time disk read at startup

// Supervisor — manages session leases and stall detection
const supervisor = new SessionSupervisor();

// Job manager — persistent multi-step automation jobs
const JOB_DIR = path.join(os.homedir(), ".screenhand", "jobs");
const jobManager = new JobManager({ jobDir: JOB_DIR, memory, supervisor });
jobManager.init();

// Direct lease manager that shares the filesystem lock dir with the daemon
const LOCK_DIR = path.join(os.homedir(), ".screenhand", "locks");
const leaseManager = new LeaseManager(LOCK_DIR);

// ── Context tracker — connects tool execution to playbook knowledge ──
// References dir holds curated platform knowledge (selectors, flows, errors)
// Playbooks dir holds only executable step sequences for job_create
// Resolution order: local dev paths → npm dist paths → ~/.screenhand/ user paths
function resolveDataDir(name: string): string {
  // 1. Local dev path (when running from source)
  const local = path.resolve(__dirname, name);
  if (fs.existsSync(local) && fs.readdirSync(local).some(f => f.endsWith(".json"))) {
    return local;
  }
  // 2. npm dist path (when installed via npx/npm)
  const dist = path.resolve(__dirname, `dist-${name}`);
  if (fs.existsSync(dist) && fs.readdirSync(dist).some(f => f.endsWith(".json"))) {
    return dist;
  }
  // 3. User home path (always available for user-generated content)
  const userDir = path.join(os.homedir(), ".screenhand", name);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}
const referencesDir = resolveDataDir("references");
const _playbookStoreForContext = new PlaybookStore(referencesDir);
_playbookStoreForContext.load();
const playbooksDir = resolveDataDir("playbooks");
const contextTracker = new ContextTracker(_playbookStoreForContext, playbooksDir);
const worldModel = new WorldModel();
const perceptionManager = new PerceptionManager(worldModel);
const learningEngine = new LearningEngine();
learningEngine.init();
import { AppMap } from "./src/state/app-map.js";
// Seed app maps: check npm dist path first, then local dev path
const seedAppMapsDir = (() => {
  const dist = path.resolve(__dirname, "dist-app-maps");
  if (fs.existsSync(dist)) return dist;
  const local = path.resolve(__dirname, "seed-app-maps");
  if (fs.existsSync(local)) return local;
  return undefined;
})();
const appMap = new AppMap(seedAppMapsDir ? { seedDir: seedAppMapsDir } : undefined);
appMap.init();
// Cross-feature workflow tracking: per-app buffer of distinct features hit by action tools
const crossFeatureBuffer = new Map<string, { features: string[]; lastRecordedAt: number }>();
// Visibility tracking throttle: run conditional UI check every 10th tool call
let visibilityCheckCounter = 0;
// Previous tool name for ready-signal recording (what action preceded a wait)
let lastSuccessfulToolName = "unknown";
// Last known bundleId — survives focusedApp being nulled by app_deactivated events
let lastKnownBundleId: string | null = null;
contextTracker.setAppMap(appMap);
perceptionManager.setAppMap(appMap);
// Wire F10: connect ContextTracker to PerceptionCoordinator for per-app perception config
perceptionManager.setContextTracker(contextTracker);
// Wire #11: connect TopologyPolicy to AppMap for unified edge scoring
appMap.setTopologyPolicy(learningEngine.topology);
// Wire #14: seed TimingModel from AppMap's stored timing profiles (cold-start bootstrap)
learningEngine.seedTimingFromAppMap(appMap);
// Wire F5-F7: Cold-start bootstrap — seed all learning policies from AppMap data
learningEngine.seedLocatorsFromAppMap(appMap);
learningEngine.seedSensorsFromReadySignals(appMap);
learningEngine.seedPatternsFromAppMap(appMap);
learningEngine.seedRecoveryFromContracts(appMap);
const _executablePlaybookStore = new PlaybookStore(playbooksDir);
try { _executablePlaybookStore.load(); } catch { /* dir may not exist */ }
const planner = new Planner(_executablePlaybookStore, memory, contextTracker, worldModel, learningEngine);
const goalStore = new GoalStore(path.join(os.homedir(), ".screenhand", "planner"));
goalStore.init();
const toolRegistry = new ToolRegistry();
const recoveryEngine = new RecoveryEngine(worldModel, toolRegistry.toExecutor(), memory);
recoveryEngine.setLearningEngine(learningEngine);
recoveryEngine.setAppMap(appMap);
planner.setToolRegistry(toolRegistry);
planner.setAppMap(appMap);
perceptionManager.setLearningEngine(learningEngine);
const mcpRecorder = new McpPlaybookRecorder(playbooksDir);
const referenceMerger = new ReferenceMerger(referencesDir);
const communityPublisher = new PlaybookPublisher();
const communityFetcher = new PlaybookFetcher();

// Tools excluded from the intelligence wrapper (memory/context hints).
// Memory, supervisor, job, and daemon lifecycle tools skip the wrapper to avoid recursion
// and because they don't benefit from playbook hints.
// NOTE: platform knowledge tools (platform_guide, playbook_preflight, export_playbook)
// are NOT excluded — they benefit from context-aware hints.
const MEMORY_TOOLS = new Set([
  "memory_snapshot", "memory_recall", "memory_save", "memory_record_error",
  "memory_record_learning", "memory_query_patterns", "memory_errors",
  "memory_stats", "memory_clear",
  "session_claim", "session_heartbeat", "session_release",
  "supervisor_status", "supervisor_start", "supervisor_stop", "supervisor_pause", "supervisor_resume",
  "supervisor_install", "supervisor_uninstall",
  "recovery_queue_add", "recovery_queue_list",
  "job_create", "job_status", "job_list", "job_transition",
  "job_step_done", "job_step_fail", "job_resume", "job_dequeue", "job_remove",
  "job_run", "job_run_all",
  "worker_start", "worker_stop", "worker_status",
  "job_create_chain",
  "observer_start", "observer_stop", "observer_status", "observer_ocr_roi",
  "orchestrator_start", "orchestrator_stop", "orchestrator_submit", "orchestrator_status",
  "world_state", "world_state_diff", "perception_status", "perception_start", "perception_stop",
  "learning_status", "learning_reset",
  "plan_goal", "plan_execute", "plan_step", "plan_step_resolve", "plan_status", "plan_list", "plan_cancel",
  "recovery_status", "recovery_configure",
  "community_publish", "community_fetch",
]);

// Track the strategy we're currently following (for feedback loop)
let activeStrategyFingerprint: string | null = null;

// Adaptive budget for the current tool call — set by intelligence wrapper, read by fallback tools
import type { AdaptiveBudget } from "./src/learning/types.js";
let currentAdaptiveBudget: AdaptiveBudget | null = null;

// Intercept all tool registrations to auto-log + auto-recall
const _rawOriginalTool = server.tool.bind(server);
type ToolArgs = Parameters<typeof server.tool>;

// Wrap originalTool to also register handlers in the tool registry
const originalTool = ((...args: any[]) => {
  const handlerIdx = args.findIndex((a: any) => typeof a === "function");
  if (handlerIdx !== -1) {
    const name = args[0] as string;
    const handler = args[handlerIdx] as Function;
    // Wrap handler to ensure world model session rebinding (same as server.tool wrapper)
    const wrappedHandler = async (params: any, extra: any) => {
      const sessionId = memory.getSessionId();
      if (sessionId && worldModel.getState().sessionId !== sessionId) {
        worldModel.init(sessionId);
      }
      return handler(params, extra);
    };
    args[handlerIdx] = wrappedHandler;
    toolRegistry.register(name, (params: Record<string, unknown>) => handler(params, {}));
  }
  return (_rawOriginalTool as any)(...args);
}) as typeof _rawOriginalTool;

function extractText(result: any): string {
  if (!result?.content) return "";
  const full = result.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  if (full.length > 500) return full.slice(0, 500) + " [TRUNCATED]";
  return full;
}

(server as any).tool = (...args: ToolArgs) => {
  const handlerIdx = args.findIndex((a) => typeof a === "function");
  if (handlerIdx === -1) return (originalTool as any)(...args);

  const originalHandler = args[handlerIdx] as Function;
  const toolName = args[0] as string;

  // Register the original (unwrapped) handler for internal tool dispatch
  toolRegistry.register(toolName, (params: Record<string, unknown>) => originalHandler(params, {}));

  const wrappedHandler = async (params: any, extra: any) => {
    // Skip intercepting memory tools to avoid recursion
    if (MEMORY_TOOLS.has(toolName)) {
      return originalHandler(params, extra);
    }

    const sessionId = memory.getSessionId();
    const safeParams = typeof params === "object" && params !== null ? params : {};
    const start = Date.now();

    // ── PRE-CALL: lazy-init world model on first session ──
    if (sessionId && worldModel.getState().sessionId !== sessionId) {
      worldModel.init(sessionId);
    }

    // ── PRE-CALL: notify perception to stay active (idle gating) ──
    perceptionManager.notifyToolCall();

    // ── PRE-CALL: check for known error warnings (~0ms, in-memory) ──
    const knownError = memory.quickErrorCheck(toolName);

    // Wire F11: Block execution for tools that fail repeatedly with known resolution (L2→L1)
    // Exclude playbook-seeded errors (id starts with pb_err_) — those are generic platform warnings,
    // not errors observed in this session. Only block on real runtime failures.
    // Also exclude errors injected via memory_record_error API (empty params) — only runtime errors
    // from the intelligence wrapper (which always have populated params) should trigger blocks.
    const isRuntimeError = knownError && typeof knownError.params === "object" && knownError.params !== null && Object.keys(knownError.params).length > 0;
    if (knownError && knownError.occurrences >= 5 && knownError.resolution && !knownError.id.startsWith("pb_err_") && isRuntimeError) {
      return {
        content: [{
          type: "text" as const,
          text: `⛔ Blocked: "${toolName}" has failed ${knownError.occurrences}x with: "${knownError.error}". Known fix: ${knownError.resolution}. Apply the fix first, then retry.`,
        }],
      };
    }

    // ── PRE-CALL: auto-start perception if not running ──
    if (!perceptionManager.isRunning && bridgeReady) {
      const focusApp = worldModel.getState().focusedApp;
      if (focusApp?.bundleId && focusApp?.pid) {
        perceptionManager.tryAutoStart(focusApp, bridge).catch(() => {});
        installSafariEnricher(focusApp.bundleId);
      }
    }

    // ── PRE-CALL: update context tracker (fires playbook lookup only on domain change) ──
    contextTracker.updateContext(toolName, safeParams);
    const playbookHints = contextTracker.getHints(toolName, safeParams);

    // ── PRE-CALL: compute adaptive budget from learning engine ──
    const budgetBundleId = worldModel.getState().focusedApp?.bundleId;
    if (budgetBundleId) {
      const budget = learningEngine.getAdaptiveBudget(budgetBundleId);
      if (budget.locateMs !== 800 || budget.actMs !== 200 || budget.verifyMs !== 2000) {
        currentAdaptiveBudget = budget;
      } else {
        currentAdaptiveBudget = null;
      }
    } else {
      currentAdaptiveBudget = null;
    }

    // Capture pre-call focused app for focus drift detection
    const preBundleId = worldModel.getState().focusedApp?.bundleId ?? null;

    // Update last known bundleId from world model, tool params, or context tracker
    const paramBundleId = safeParams.bundleId ?? safeParams.pid;
    if (preBundleId) {
      lastKnownBundleId = preBundleId;
    } else if (typeof paramBundleId === "string" && paramBundleId) {
      lastKnownBundleId = paramBundleId;
    }

    // Snapshot the bundleId for this tool's POST-CALL, so concurrent PRE-CALL
    // overwrites of lastKnownBundleId don't contaminate this tool's context
    const postCallBundleId = preBundleId ?? lastKnownBundleId;

    // Capture pre-call window title for navigation edge tracking
    const preWindowTitle = worldModel.getFocusedWindow()?.title.value ?? null;

    // Action tools = actually doing something. Navigation = just clicking around.
    const ACTION_TOOLS = new Set([
      "type_text", "key", "drag", "scroll", "menu_click", "applescript",
      "ui_set_value", "ui_press",
      "browser_type", "browser_click", "browser_fill_form", "browser_human_click",
      "browser_js", "browser_navigate",
      "type_with_fallback", "select_with_fallback", "scroll_with_fallback",
    ]);

    try {
      const result = await originalHandler(params, extra);
      const durationMs = Date.now() - start;

      // ── POST-CALL: log action (async, non-blocking) ──
      const entry: ActionEntry = {
        id: "a_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        sessionId,
        tool: toolName,
        params: safeParams,
        durationMs,
        success: true,
        result: extractText(result),
        error: null,
      };
      memory.recordEvent(entry);  // non-blocking write + session tracking

      // ── POST-CALL: record success for playbook learning (in-memory only) ──
      contextTracker.recordOutcome(toolName, safeParams, true, null);

      // ── POST-CALL: Safari context gap + page context update ──
      const postFocusApp = worldModel.getState().focusedApp;
      const postBundleIdForCtx = postFocusApp?.bundleId ?? postCallBundleId;
      if (postBundleIdForCtx) {
        lastKnownBundleId = postBundleIdForCtx;
        // Try focused window first, then search all windows for matching bundleId
        let winTitle: string | null = null;
        const focWin = worldModel.getFocusedWindow();
        if (focWin?.title.value) {
          winTitle = focWin.title.value;
        } else if (postFocusApp?.pid) {
          // Focused window lost — search state for any window from this app
          for (const [, win] of worldModel.getState().windows) {
            if (win.pid === postFocusApp.pid && win.title.value) {
              winTitle = win.title.value;
              break;
            }
          }
        }
        if (winTitle) {
          contextTracker.updateContextFromWindowTitle(postBundleIdForCtx, winTitle);
          contextTracker.updatePageContext(winTitle);
        } else {
          // Don't null out page context if we just can't find the window —
          // keep the last known page context to avoid losing it on transient events
        }
      }

      // ── POST-CALL: record page transitions for navigation graph ──
      const pageTransition = contextTracker.consumePageTransition();
      if (pageTransition && postBundleIdForCtx) {
        try {
          appMap.recordPageTransition(
            postBundleIdForCtx,
            pageTransition.from,
            pageTransition.to,
            toolName,
          );
        } catch { /* non-critical — don't break tool execution for nav tracking */ }
      }

      // ── POST-CALL: detect focus drift ──
      const postBundleId = worldModel.getState().focusedApp?.bundleId ?? null;
      if (preBundleId && postBundleId && preBundleId !== postBundleId) {
        const driftWarning = `⚠ Focus changed: ${preBundleId} → ${postBundleId}. Use \`focus\` to return.`;
        if (result?.content && Array.isArray(result.content)) {
          result.content.unshift({ type: "text", text: driftWarning });
        }
      }

      // ── POST-CALL: feed learning engine (timing + locator outcomes) ──
      const learnBundleId = worldModel.getState().focusedApp?.bundleId ?? postCallBundleId ?? "unknown";
      learningEngine.recordToolTiming({ tool: toolName, bundleId: learnBundleId, durationMs, success: true });

      // Record locator outcome if the tool used a target/selector
      const locatorTarget = safeParams.target ?? safeParams.selector ?? safeParams.locator
        ?? (toolName === "click_text" ? safeParams.text : undefined);
      if (typeof locatorTarget === "string" && locatorTarget) {
        const method = toolName.startsWith("browser_") ? "cdp" as const
          : toolName.includes("ocr") ? "ocr" as const
          : "ax" as const;
        learningEngine.recordLocatorOutcome({
          bundleId: learnBundleId,
          actionKey: toolName,
          locator: locatorTarget,
          method,
          success: true,
        });

        // Auto-record verified pattern to patterns.jsonl via learning engine
        learningEngine.recordPattern({
          bundleId: learnBundleId,
          tool: toolName,
          locator: locatorTarget,
          method,
          success: true,
        });
      }

      // ── POST-CALL: update app mastery map from successful action ──
      // Check if the result signals an error (e.g. click_text "not found" returns isError: true)
      const resultIsError = !!(result as any)?.isError;
      const isActionTool = ACTION_TOOLS.has(toolName);

      if (resultIsError && learnBundleId !== "unknown") {
        // Redirect to failure mastery recording + count as edge case handled
        try {
          const failedLocatorSoft = safeParams.target ?? safeParams.selector ?? safeParams.locator
            ?? (toolName === "click_text" ? safeParams.text : undefined);
          if (typeof failedLocatorSoft === "string" && failedLocatorSoft) {
            appMap.recordElementOutcome(learnBundleId, "auto", failedLocatorSoft, false, contextTracker.currentPageContext ?? undefined);
          }
          if (isActionTool) {
            appMap.recordActionOutcome(learnBundleId, false);
          }
          // Track as edge case: encountering an error is an unexpected state
          const edgeMapData = appMap.getLoaded(learnBundleId);
          if (edgeMapData) {
            edgeMapData.edgeCasesHandled = (edgeMapData.edgeCasesHandled ?? 0) + 1;
            appMap.save(edgeMapData, true);
          }
          const failMapDataSoft = appMap.getLoaded(learnBundleId);
          if (failMapDataSoft?.featureLadder) {
            const failSignalSoft = [toolName, typeof failedLocatorSoft === "string" ? failedLocatorSoft : ""].join(" ").toLowerCase();
            const failGenSignalsSoft = appMap.getGeneratedSignals(learnBundleId) ?? {};
            for (const feature of failMapDataSoft.featureLadder) {
              const fm = failMapDataSoft.featureMastery?.[feature.id];
              if (!fm || fm.depth === 0) continue;
              const featureInSignal = failSignalSoft.includes(feature.id.replace(/_/g, " "));
              const keywords = failGenSignalsSoft[feature.id];
              const keywordMatch = keywords?.some((kw) => failSignalSoft.includes(kw));
              if (featureInSignal || keywordMatch) {
                appMap.recordFeatureSignal(learnBundleId, feature.id, fm.depth as 1 | 2 | 3 | 4, false);
              }
            }
          }
        } catch { /* non-fatal */ }
      }

      if (!resultIsError && learnBundleId !== "unknown") {
        try {
          if (!appMap.load(learnBundleId)) {
            const focApp = worldModel.getState().focusedApp;
            appMap.createEmpty(learnBundleId, focApp?.appName ?? learnBundleId);
          }

          // Record element outcome for tools with a locator target
          if (typeof locatorTarget === "string" && locatorTarget) {
            appMap.recordElementOutcome(learnBundleId, "auto", locatorTarget, true, contextTracker.currentPageContext ?? undefined);

            // Write relative position from click coordinates
            const resultText = extractText(result);
            const screenMatch = resultText.match(/at screen \((\d+),\s*(\d+)\)/);
            const windowMatch = resultText.match(/\[window: \((\d+),\s*(\d+)\) (\d+)[x×](\d+)\]/);
            if (screenMatch && windowMatch) {
              const sx = parseInt(screenMatch[1]!, 10);
              const sy = parseInt(screenMatch[2]!, 10);
              const wx = parseInt(windowMatch[1]!, 10);
              const wy = parseInt(windowMatch[2]!, 10);
              const ww = parseInt(windowMatch[3]!, 10);
              const wh = parseInt(windowMatch[4]!, 10);
              if (ww > 0 && wh > 0) {
                const relX = Math.max(0, Math.min(1, (sx - wx) / ww));
                const relY = Math.max(0, Math.min(1, (sy - wy) / wh));
                appMap.updateElementPosition(learnBundleId, "auto_discovered", locatorTarget, relX, relY);
              }
            }
          }

          // Record action outcome (only for tools that DO something, not navigation)
          if (isActionTool) {
            appMap.recordActionOutcome(learnBundleId, true);
          }

          // ── Record input/output contract for element interaction tools ──
          {
            const CONTRACT_TOOLS = new Set(["click", "click_text", "type_text", "key", "menu_click"]);
            if (CONTRACT_TOOLS.has(toolName) && typeof locatorTarget === "string" && locatorTarget) {
              // Use "auto" to search all zones — page-specific zones may not exist yet
              appMap.recordContract(
                learnBundleId,
                "auto",
                locatorTarget,
                toolName,
                ["action succeeded"],
              );
            }
          }

          // ── Track shortcut usage (keyboard combos with modifier keys) ──
          if (toolName === "key" && typeof safeParams.combo === "string") {
            const combo = safeParams.combo.toLowerCase();
            if (combo.includes("cmd+") || combo.includes("ctrl+") || combo.includes("alt+") || combo.includes("shift+")) {
              const mapDataShortcut = appMap.getLoaded(learnBundleId);
              if (mapDataShortcut) {
                mapDataShortcut.shortcutsUsed = (mapDataShortcut.shortcutsUsed ?? 0) + 1;
                appMap.save(mapDataShortcut, true);
              }
            }
          }

          // ── Track edge case handling (escape = dialog/popup dismissal) ──
          if (toolName === "key" && safeParams.combo === "escape") {
            const mapDataEdge = appMap.getLoaded(learnBundleId);
            if (mapDataEdge) {
              mapDataEdge.edgeCasesHandled = (mapDataEdge.edgeCasesHandled ?? 0) + 1;
              appMap.save(mapDataEdge, true);
            }
          }

          // ── Auto-detect feature depth from tool usage signals ──
          // Depth: 1=navigated (screenshot/focus), 2=basic action (click/type),
          //        3=multi-step workflow (action tools in sequence), 4=verified outcome
          {
            const mapData = appMap.getLoaded(learnBundleId);
            if (mapData?.featureLadder) {
              const signalText = [
                toolName,
                typeof locatorTarget === "string" ? locatorTarget : "",
                typeof safeParams.text === "string" ? safeParams.text : "",
                preWindowTitle ?? "",
                worldModel.getFocusedWindow()?.title.value ?? "",
              ].join(" ").toLowerCase();

              // Determine depth from tool type and history:
              // depth 1 = navigated (screenshot/focus/ocr)
              // depth 2 = basic action (click/type/key on the feature)
              // depth 3 = multi-step workflow (already at depth 2, hit again with different action tool)
              // depth 4 = verified outcome (at depth 3, then verified via screenshot/ocr)
              const NAV_TOOLS = new Set(["screenshot", "screenshot_file", "focus", "ocr", "ui_tree", "ui_find", "windows", "apps", "browser_tabs", "browser_page_info", "browser_dom"]);
              const VERIFY_TOOLS = new Set(["screenshot", "screenshot_file", "ocr", "ui_tree", "ui_find", "browser_dom", "browser_page_info"]);
              const isNavTool = NAV_TOOLS.has(toolName);
              const isVerifyTool = VERIFY_TOOLS.has(toolName);

              // Keyword map: featureId → keywords that signal the feature was used
              // Hardcoded signals for apps with BUILTIN_LADDERS
              const BUILTIN_FEATURE_SIGNALS: Record<string, string[]> = {
                // Discord
                browse_channels: ["channel", "server", "sidebar", "lounge", "information"],
                send_message: ["message", "type_text", "browser_type", "chatter", "chat"],
                direct_messages: ["direct message", "dm", "group chat", "friends"],
                voice_video: ["voice", "stage", "listen", "audio", "video", "call", "screen share", "activity"],
                threads_forums: ["thread", "forum", "post", "topic", "discussion"],
                roles_permissions: ["role", "permission", "override", "hidden channel"],
                notification_control: ["notification", "mention", "mute", "suppress"],
                events_stage: ["event", "stage", "trivia", "interested", "schedule"],
                onboarding_funnel: ["onboarding", "welcome", "get started", "rules screening", "starter", "channels & roles", "customize", "browse channels", "choose your channels"],
                moderation_system: ["moderation", "automod", "ban", "modmail", "audit", "report", "rules", "safety", "raid"],
                bot_ecosystem: ["bot", "automod", "integration", "app directory", "slash command", "verification", "add app", "add to server", "mee6", "webhook"],
                server_architecture: ["category", "channel taxonomy", "channels & roles", "server guide", "server settings"],
                community_growth: ["announcement", "event", "reward", "retention", "engagement"],
                analytics_health: ["analytics", "insights", "server insights", "activity", "member count"],
                monetization_membership: ["premium", "boost", "subscription", "tier", "monetiz"],
                crisis_handling: ["raid", "spam", "harassment", "lockdown", "ban wave"],
                cross_platform: ["github", "notion", "twitch", "stripe", "zapier", "webhook"],
                staff_system: ["moderator", "staff", "escalation", "internal", "mod channel"],
                brand_culture: ["community", "identity", "ritual", "culture", "recognition"],
                governance_policy: ["rules", "policy", "enforcement", "appeal", "governance"],
                // Safari
                browse_navigate: ["navigate", "browser_navigate", "browser_open", "url"],
                tabs_windows: ["tab", "browser_tabs", "window"],
                bookmarks: ["bookmark", "reading list"],
                history_search: ["history", "search"],
                tab_groups: ["tab group", "profile"],
                extensions: ["extension"],
                dev_tools: ["inspector", "developer", "console", "browser_js"],
                privacy_settings: ["privacy", "cookie", "blocker"],
                web_apps: ["add to dock", "web app"],
                // Finder
                browse_files: ["finder", "file", "folder", "browse"],
                copy_move: ["copy", "move", "rename", "delete", "trash"],
                search: ["search", "spotlight"],
                views_sort: ["view", "sort", "column", "icon", "list"],
                tags_favorites: ["tag", "favorite", "sidebar"],
                quick_actions: ["quick look", "quick action", "service"],
                automator_scripts: ["automator", "terminal", "script", "applescript"],
                // Generic (fallback for apps with generic ladders)
                basic_navigation: ["navigate", "open", "browse", "launch"],
                core_action: ["type_text", "click", "press", "key"],
                settings: ["settings", "preferences", "config"],
                advanced_features: ["advanced", "power", "shortcut", "automation"],
              };

              // Auto-generate ladder from reference if no builtin exists
              if (!appMap.hasGeneratedLadder(learnBundleId)) {
                const ref = _playbookStoreForContext.matchByBundleId(learnBundleId);
                if (ref?.selectors && Object.keys(ref.selectors).length >= 2) {
                  const generated = appMap.generateLadderFromRef(learnBundleId, ref);
                  if (generated) {
                    // Reload mapData with new ladder
                    const refreshed = appMap.getLoaded(learnBundleId);
                    if (refreshed) {
                      Object.assign(mapData, refreshed);
                    }
                  }
                }
              }

              // Merge auto-generated signals with builtins (generated takes priority)
              const generatedSignals = appMap.getGeneratedSignals(learnBundleId);
              const mergedSignals: Record<string, string[]> = { ...BUILTIN_FEATURE_SIGNALS };
              if (generatedSignals) {
                for (const [fid, kws] of Object.entries(generatedSignals)) {
                  mergedSignals[fid] = kws;
                }
              }

              const hitFeatures: string[] = [];
              for (const feature of mapData.featureLadder) {
                const keywords = mergedSignals[feature.id];
                if (!keywords) continue;
                if (keywords.some((kw) => signalText.includes(kw))) {
                  // Compute depth based on current state + tool type
                  const existing = mapData.featureMastery?.[feature.id];
                  const currentDepth = existing?.depth ?? 0;
                  let signalDepth: 1 | 2 | 3 | 4;

                  if (isVerifyTool && currentDepth >= 3) {
                    // Verifying after a workflow = verified outcome (depth 4)
                    signalDepth = 4;
                  } else if (!isNavTool && currentDepth >= 2 && (existing?.repeatCount ?? 0) >= 3) {
                    // Repeated action tool on a feature we've already actioned = workflow (depth 3)
                    signalDepth = 3;
                  } else if (isNavTool) {
                    signalDepth = 1;
                  } else {
                    signalDepth = 2;
                  }

                  appMap.recordFeatureSignal(learnBundleId, feature.id, signalDepth, true);
                  // Healing detection: success after prior failure = recovery
                  if (existing && existing.failCount > (existing.healingCount ?? 0)) {
                    appMap.recordHealing(learnBundleId, feature.id);
                  }
                  if (!isNavTool) hitFeatures.push(feature.id);
                }
              }

              // Cross-feature workflow detection: track distinct features hit by action tools.
              // When 3+ distinct features are hit in a rolling window, record a cross-feature workflow.
              if (!crossFeatureBuffer.has(learnBundleId)) {
                crossFeatureBuffer.set(learnBundleId, { features: [], lastRecordedAt: 0 });
              }
              const cfBuf = crossFeatureBuffer.get(learnBundleId)!;
              for (const fid of hitFeatures) {
                if (!cfBuf.features.includes(fid)) cfBuf.features.push(fid);
              }
              // Trim to last 10 features
              if (cfBuf.features.length > 10) cfBuf.features = cfBuf.features.slice(-10);
              // Record a cross-feature workflow every 3 distinct features (throttled)
              if (cfBuf.features.length >= 3 && Date.now() - cfBuf.lastRecordedAt > 30_000) {
                appMap.recordCrossFeatureWorkflow(learnBundleId);
                cfBuf.lastRecordedAt = Date.now();
                cfBuf.features = []; // Reset for next workflow
              }
            }
          }

          // Record navigation edge when window title changes (screen transition)
          const postWindowTitle = worldModel.getFocusedWindow()?.title.value ?? null;
          if (preWindowTitle && postWindowTitle && preWindowTitle !== postWindowTitle) {
            const appName = worldModel.getState().focusedApp?.appName ?? "";
            const titleSuffix = appName ? new RegExp(` - ${appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : null;
            const fromNode = titleSuffix ? preWindowTitle.replace(titleSuffix, "") : preWindowTitle;
            const toNode = titleSuffix ? postWindowTitle.replace(titleSuffix, "") : postWindowTitle;
            if (fromNode !== toNode) {
              appMap.addNavNode(learnBundleId, fromNode, { type: "window", description: fromNode });
              appMap.addNavNode(learnBundleId, toNode, { type: "window", description: toNode });
              const locatorSlug = locatorTarget ? String(locatorTarget).slice(0, 80) : null;
              const edgeAction = locatorSlug ? `${toolName}:${locatorSlug}` : toolName;
              // Wire #11: record topology FIRST so AppMap can read the updated Bayesian score
              learningEngine.recordTopologyOutcome({
                bundleId: learnBundleId,
                fromNode,
                action: edgeAction,
                toNode,
                success: true,
              });
              appMap.recordEdgeOutcome(learnBundleId, fromNode, edgeAction, toNode, true);
            }
          }

          // ── State machine: detect state changes from tool results ──
          // Two detection paths:
          // 1. Keyword matching on result text (original regex patterns)
          // 2. Structural detection: key combos that open/close UI elements
          {
            const stateResultText = extractText(result).toLowerCase();
            const stateTrigger = locatorTarget ?? toolName;

            // --- Structural state detection from tool + combo patterns ---
            // Keyboard shortcuts that toggle UI state (works even when result text has no keywords)
            if (toolName === "key" && typeof safeParams.combo === "string") {
              const combo = safeParams.combo.toLowerCase();
              // Cmd+K / Ctrl+K / Cmd+P = search/command palette (dialog open)
              if (combo === "cmd+k" || combo === "ctrl+k" || combo === "cmd+p" || combo === "ctrl+p") {
                const prevState = appMap.getCurrentState(learnBundleId);
                const from = prevState["modal_state"] ?? "closed";
                appMap.recordStateChange(learnBundleId, "modal_state", from, "open", combo);
              }
              // Escape = dismiss dialog/modal
              if (combo === "escape") {
                const prevState = appMap.getCurrentState(learnBundleId);
                if (prevState["modal_state"] === "open") {
                  appMap.recordStateChange(learnBundleId, "modal_state", "open", "closed", combo);
                }
              }
              // Cmd+\ or Cmd+Shift+S = sidebar toggle (common pattern)
              if (combo === "cmd+\\" || combo === "ctrl+\\" || combo === "cmd+shift+s") {
                const prevState = appMap.getCurrentState(learnBundleId);
                const currentSidebar = prevState["sidebar_state"] ?? "expanded";
                const newSidebar = currentSidebar === "expanded" ? "collapsed" : "expanded";
                appMap.recordStateChange(learnBundleId, "sidebar_state", currentSidebar, newSidebar, combo);
              }
            }

            // --- Keyword matching on result text (original patterns) ---

            // Modal/dialog state
            // V4: Require noun+verb proximity to prevent false injection from element labels.
            if (/\b(modal|dialog|popup|alert|sheet|search|command palette)\s+\w*\s*\b(opened|appeared|shown|displayed|presented)\b/.test(stateResultText) ||
                /\b(opened|appeared|shown|displayed|presented)\s+\w*\s*\b(modal|dialog|popup|alert|sheet)\b/.test(stateResultText) ||
                /\b(modal|dialog|popup|alert|sheet)\s+(is|was|has been)\s+(opened|shown|displayed|presented)\b/.test(stateResultText)) {
              const prevState = appMap.getCurrentState(learnBundleId);
              const from = prevState["modal_state"] ?? "closed";
              appMap.recordStateChange(learnBundleId, "modal_state", from, "open", stateTrigger);
            } else if (/\b(modal|dialog|popup|alert|sheet)\s+\w*\s*\b(closed|dismissed|hidden|disappeared)\b/.test(stateResultText) ||
                /\b(closed|dismissed|hidden|disappeared)\s+\w*\s*\b(modal|dialog|popup|alert|sheet)\b/.test(stateResultText) ||
                /\b(modal|dialog|popup|alert|sheet)\s+(is|was|has been)\s+(closed|dismissed|hidden)\b/.test(stateResultText)) {
              const prevState = appMap.getCurrentState(learnBundleId);
              const from = prevState["modal_state"] ?? "open";
              appMap.recordStateChange(learnBundleId, "modal_state", from, "closed", stateTrigger);
            }

            // Sidebar/panel state
            if (/\b(sidebar|panel)\s+\w*\s*\b(collapsed|hidden|closed|minimized)\b/.test(stateResultText) ||
                /\b(collapsed|hidden|closed|minimized)\s+\w*\s*\b(sidebar|panel)\b/.test(stateResultText) ||
                /\b(sidebar|panel)\s+(is|was|has been)\s+(collapsed|hidden|closed|minimized)\b/.test(stateResultText)) {
              const prevState = appMap.getCurrentState(learnBundleId);
              const from = prevState["sidebar_state"] ?? "expanded";
              appMap.recordStateChange(learnBundleId, "sidebar_state", from, "collapsed", stateTrigger);
            } else if (/\b(sidebar|panel)\s+\w*\s*\b(expanded|shown|opened|visible|maximized)\b/.test(stateResultText) ||
                /\b(expanded|shown|opened|visible|maximized)\s+\w*\s*\b(sidebar|panel)\b/.test(stateResultText) ||
                /\b(sidebar|panel)\s+(is|was|has been)\s+(expanded|shown|opened|visible|maximized)\b/.test(stateResultText)) {
              const prevState = appMap.getCurrentState(learnBundleId);
              const from = prevState["sidebar_state"] ?? "collapsed";
              appMap.recordStateChange(learnBundleId, "sidebar_state", from, "expanded", stateTrigger);
            }

            // View mode state (e.g., board/list/table/grid/timeline)
            const viewModeMatch = stateResultText.match(/\b(board|list|table|grid|timeline|calendar|gallery|kanban)\s*view\b/);
            if (!viewModeMatch) {
              const altViewMatch = stateResultText.match(/(?:switched\s+to|view:\s*)\s*(board|list|table|grid|timeline|calendar|gallery|kanban)\b/);
              if (altViewMatch) {
                const newView = altViewMatch[1]!;
                const prevState = appMap.getCurrentState(learnBundleId);
                const from = prevState["view_mode"] ?? "unknown";
                if (from !== newView) {
                  appMap.recordStateChange(learnBundleId, "view_mode", from, newView, stateTrigger);
                }
              }
            } else {
              const newView = viewModeMatch[1]!;
              const prevState = appMap.getCurrentState(learnBundleId);
              const from = prevState["view_mode"] ?? "unknown";
              if (from !== newView) {
                appMap.recordStateChange(learnBundleId, "view_mode", from, newView, stateTrigger);
              }
            }
          }

          // ── Hierarchy extraction from UI inspection tools ──
          // Extract parent/child containment from any tool that reveals structure
          {
            const HIERARCHY_TOOLS = new Set(["ui_tree", "ui_find", "screenshot", "ocr"]);
            if (HIERARCHY_TOOLS.has(toolName)) {
              try {
                const treeText = extractText(result);
                if (treeText) {
                  const lines = treeText.split("\n");
                  const hierarchyZone = contextTracker.currentPageContext
                    ? `page::${contextTracker.currentPageContext}` : "auto_discovered";

                  if (toolName === "ui_tree" || toolName === "ui_find") {
                    // Parse indented AX tree: depth 0 = root, depth 1 = top containers, depth 2 = children
                    // Format: "  ".repeat(depth) + role "title" ...
                    const containers: Array<{ label: string; depth: number; children: string[] }> = [];
                    for (const line of lines) {
                      const stripped = line.replace(/\s+$/, "");
                      const indent = stripped.length - stripped.trimStart().length;
                      const depth = Math.floor(indent / 2);
                      const titleMatch = stripped.match(/"([^"]+)"/);
                      if (!titleMatch) continue;
                      const label = titleMatch[1]!;
                      if (!label || label.length > 200) continue;

                      if (depth <= 1) {
                        containers.push({ label, depth, children: [] });
                      } else if (depth === 2 && containers.length > 0) {
                        const parent = containers[containers.length - 1];
                        if (parent && parent.children.length < 50) {
                          parent.children.push(label);
                        }
                      }
                    }
                    for (const container of containers) {
                      if (container.children.length > 0) {
                        appMap.recordHierarchy(learnBundleId, hierarchyZone, container.label, container.children, "ax_tree");
                      }
                    }
                  } else {
                    // screenshot/ocr: extract spatial grouping from OCR lines
                    // OCR text is top-to-bottom — consecutive lines within the same
                    // vertical region (heading followed by items) form parent/child
                    const ocrLabels: string[] = [];
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (trimmed && trimmed.length >= 2 && trimmed.length <= 100) {
                        ocrLabels.push(trimmed);
                      }
                    }
                    // Heuristic: detect section headings from OCR text.
                    // A heading is a short label (1-2 words, <=20 chars) followed by 2+ lines,
                    // or a title-case label followed by bullet-prefixed items.
                    // Catches "Recents", "Private", "Tasks Tracker" in Notion, etc.
                    let currentParent: string | null = null;
                    let currentChildren: string[] = [];

                    const flushGroup = () => {
                      if (currentParent && currentChildren.length > 0) {
                        appMap.recordHierarchy(learnBundleId, hierarchyZone, currentParent, currentChildren.slice(0, 50), "ocr_spatial");
                      }
                      currentParent = null;
                      currentChildren = [];
                    };

                    for (let i = 0; i < ocrLabels.length; i++) {
                      const label = ocrLabels[i]!;
                      const isAllCaps = /^[A-Z][A-Z\s]{2,}$/.test(label);
                      const hasColon = label.endsWith(":");
                      // Short single/double-word section name (e.g. "Recents", "Private", "New database")
                      const isShortSection = /^[A-Z][a-z]+(\s+[a-z]+)?$/.test(label) && label.length <= 20;
                      // Title-case heading: 1-4 words
                      const isTitleCase = /^[A-Z][a-zA-Z]+(\s+[A-Za-z]+){0,3}$/.test(label) && label.length <= 30;
                      const hasFollowingContent = i + 2 < ocrLabels.length;
                      // Bullet/icon items (strong signal)
                      const nextHasBullet = (idx: number) => {
                        const next = ocrLabels[idx];
                        return next != null && /^[•\*\+\-\u2022\u25CF※®=¿]/.test(next);
                      };
                      const followedByBullets = hasFollowingContent && nextHasBullet(i + 1);

                      const isHeading = isAllCaps || hasColon || (isShortSection && hasFollowingContent) || (isTitleCase && followedByBullets);
                      if (isHeading) {
                        flushGroup();
                        currentParent = label.replace(/:$/, "");
                      } else if (currentParent) {
                        currentChildren.push(label);
                      }
                    }
                    flushGroup();
                  }
                }
              } catch { /* hierarchy extraction non-fatal */ }
            }
          }

          // ── Conditional UI visibility tracking (throttled) ──
          // Every 3rd inspection-like tool call, compare discovered elements against
          // known map elements to detect which appear/disappear by page context.
          {
            const VISIBILITY_TOOLS = new Set([
              "ui_tree", "ocr", "ui_find", "screenshot", "click_text",
              "windows", "browser_dom", "browser_page_info",
            ]);
            if (VISIBILITY_TOOLS.has(toolName)) {
              visibilityCheckCounter++;
            }
            if (visibilityCheckCounter % 3 === 0 && VISIBILITY_TOOLS.has(toolName)) {
              try {
                const visMapData = appMap.getLoaded(learnBundleId);
                const visPageCtx = contextTracker.currentPageContext ?? "";
                if (visMapData && visPageCtx) {
                  // Collect element labels from the result text
                  const visResultText = extractText(result);
                  const discoveredLabels = new Set<string>();

                  // Extract quoted labels (from ui_tree/ui_find format)
                  const labelMatches = visResultText.matchAll(/"([^"]{1,100})"/g);
                  for (const m of labelMatches) {
                    if (m[1]) discoveredLabels.add(m[1]);
                  }

                  // Also extract unquoted OCR/screenshot text lines as potential labels
                  for (const line of visResultText.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed && trimmed.length >= 2 && trimmed.length <= 80 && !/^[\[\(]/.test(trimmed)) {
                      discoveredLabels.add(trimmed);
                    }
                  }

                  // For known elements in the map, record whether they were seen or absent
                  const knownElements = new Set<string>();
                  for (const zone of Object.values(visMapData.zones)) {
                    for (const el of zone.elements) {
                      knownElements.add(el.label);
                    }
                  }

                  for (const label of knownElements) {
                    const seen = discoveredLabels.has(label);
                    appMap.recordElementVisibility(learnBundleId, label, visPageCtx, seen);
                  }
                }
              } catch { /* visibility tracking non-fatal */ }
            }
          }

          // ── Timing recording: track tool response times per element ──
          {
            const TIMING_TOOLS = new Set([
              "click", "click_text", "type_text", "key", "menu_click",
              "browser_click", "browser_type",
            ]);
            if (TIMING_TOOLS.has(toolName)) {
              const timingLabel = locatorTarget ?? toolName;
              appMap.recordTiming(
                learnBundleId,
                toolName + "::" + timingLabel,
                "element_response",
                durationMs,
              );
            }

            // Ready-signal recording
            // 1. Explicit wait tools
            if (toolName === "browser_wait" || toolName === "wait_for_state") {
              appMap.recordReadySignal(
                learnBundleId,
                lastSuccessfulToolName,
                "wait_completed",
                durationMs,
              );
            }
            // 2. Any interaction tool that took notably long (>1.5s) = implicit wait
            // This captures slow page loads, animation waits, network-bound actions
            if (durationMs > 1500 && TIMING_TOOLS.has(toolName)) {
              appMap.recordReadySignal(
                learnBundleId,
                toolName,
                "slow_response",
                durationMs,
              );
            }
            // 3. Screenshot/OCR after a navigation click = page-ready signal
            if ((toolName === "screenshot" || toolName === "ocr") && lastSuccessfulToolName === "click_text") {
              appMap.recordReadySignal(
                learnBundleId,
                "click_text",
                "page_ready",
                durationMs,
              );
            }
          }

          // Refresh mastery level after updates
          appMap.refreshMastery(learnBundleId);
        } catch { /* app map update non-fatal */ }
      }

      // Track last successful tool name for ready-signal context
      lastSuccessfulToolName = toolName;

      // ── POST-CALL: capture for playbook recording if active ──
      if (mcpRecorder.isRecording) {
        const fullResultText = Array.isArray(result?.content) ? result.content.map((c: any) => c.text ?? "").join(" ") : "";
        const resultText = fullResultText.length > 500 ? fullResultText.substring(0, 500) + " [TRUNCATED]" : fullResultText;
        mcpRecorder.captureToolCall(toolName, safeParams, true, resultText, durationMs);
      }

      // ── POST-CALL: auto-recall hints (~0ms, in-memory) ──
      const hints: string[] = [];

      // Playbook-aware hints (errors, selectors, job suggestions)
      for (const h of playbookHints) {
        hints.push(h);
      }

      // World model summary (window/control state)
      const wmSummary = worldModel.toSummary();
      if (wmSummary && worldModel.getState().windows.size > 0) {
        hints.push(`World: ${wmSummary.split("\n")[0]}`);
      }

      // Perception freshness
      if (perceptionManager.isRunning) {
        hints.push(perceptionManager.getFreshnessSummary());
      }

      // Learning engine recommendations
      const patternRec = learningEngine.recommendPattern(learnBundleId, toolName);
      if (patternRec) {
        const rate = ((patternRec.successCount / Math.max(1, patternRec.successCount + patternRec.failCount)) * 100).toFixed(0);
        hints.push(`Pattern: "${patternRec.locator}" (${patternRec.method}, ${rate}% over ${patternRec.successCount + patternRec.failCount} uses)`);
      }
      const learnLocator = learningEngine.recommendLocator(learnBundleId, toolName);
      if (learnLocator) {
        hints.push(`Learning: best locator for ${toolName} → "${learnLocator.locator}" (${learnLocator.method}, ${learnLocator.score.toFixed(2)} score, ${learnLocator.successCount}/${learnLocator.successCount + learnLocator.failCount} success)`);
      }
      const adaptiveBudget = learningEngine.getAdaptiveBudget(learnBundleId);
      if (adaptiveBudget.locateMs !== 800 || adaptiveBudget.actMs !== 200 || adaptiveBudget.verifyMs !== 2000) {
        hints.push(`Learning: adaptive budgets → locate=${adaptiveBudget.locateMs}ms, act=${adaptiveBudget.actMs}ms, verify=${adaptiveBudget.verifyMs}ms`);
      }

      // Warn about known errors for this tool (from memory)
      if (knownError) {
        hints.push(`⚡ Memory: "${toolName}" has failed before: "${knownError.error}" (${knownError.occurrences}x). Fix: ${knownError.resolution}`);
      }

      // Suggest next step if we're mid-strategy
      const recentTools = memory.getRecentToolNames();
      const strategyHint = memory.quickStrategyHint(recentTools, worldModel.getState().focusedApp?.bundleId);
      if (strategyHint) {
        activeStrategyFingerprint = strategyHint.fingerprint;
        const nextParams = Object.keys(strategyHint.nextStep.params).length > 0
          ? `(${JSON.stringify(strategyHint.nextStep.params)})`
          : "";
        hints.push(`💡 Memory: This matches strategy "${strategyHint.strategy.task}" (${strategyHint.strategy.successCount} wins, ${strategyHint.strategy.failCount ?? 0} fails). Next step: ${strategyHint.nextStep.tool}${nextParams}`);

        // If this was the last step of the strategy, record success
        if (recentTools.length === strategyHint.strategy.steps.length - 1) {
          // Next call will be the final step — but this call completing means we're on track
        }
      } else if (activeStrategyFingerprint && recentTools.length > 0) {
        // We were following a strategy but the sequence diverged — record success
        // (the agent completed the strategy or went its own way after it)
        memory.recordStrategyOutcome(activeStrategyFingerprint, true);
        activeStrategyFingerprint = null;
      }

      // Attach hints in BOTH content (visible) and _meta (for programmatic access)
      if (hints.length > 0) {
        const hintText = hints.join("\n");
        const resultContent = Array.isArray(result?.content) ? result.content : [];
        return {
          ...result,
          content: [
            ...resultContent,
            { type: "text" as const, text: `\n---\n${hintText}` },
          ],
          _meta: { ...(result?._meta ?? {}), memoryHints: hints },
        };
      }

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errorMsg = err?.message ?? String(err);

      // Log failed action (non-blocking)
      const entry: ActionEntry = {
        id: "a_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        sessionId,
        tool: toolName,
        params: safeParams,
        durationMs,
        success: false,
        result: null,
        error: errorMsg,
      };
      memory.recordEvent(entry);  // non-blocking write + session tracking

      // ── Record failure for playbook learning (in-memory only) ──
      contextTracker.recordOutcome(toolName, safeParams, false, errorMsg);

      // ── Feed learning engine (failure timing + locator) ──
      const learnBundleIdErr = worldModel.getState().focusedApp?.bundleId ?? postCallBundleId ?? "unknown";
      learningEngine.recordToolTiming({ tool: toolName, bundleId: learnBundleIdErr, durationMs, success: false });

      const failedLocator = safeParams.target ?? safeParams.selector ?? safeParams.locator
        ?? (toolName === "click_text" ? safeParams.text : undefined);
      if (typeof failedLocator === "string" && failedLocator) {
        const method = toolName.startsWith("browser_") ? "cdp" as const
          : toolName.includes("ocr") ? "ocr" as const
          : "ax" as const;
        learningEngine.recordLocatorOutcome({
          bundleId: learnBundleIdErr,
          actionKey: toolName,
          locator: failedLocator,
          method,
          success: false,
        });

        // Record failed pattern to patterns.jsonl
        learningEngine.recordPattern({
          bundleId: learnBundleIdErr,
          tool: toolName,
          locator: failedLocator,
          method,
          success: false,
        });
      }

      // ── POST-CALL: record failure in app mastery map ──
      if (learnBundleIdErr !== "unknown") {
        try {
          if (typeof failedLocator === "string" && failedLocator) {
            appMap.recordElementOutcome(learnBundleIdErr, "auto", failedLocator, false, contextTracker.currentPageContext ?? undefined);
          }
          // Record action failure
          const isFailedAction = ACTION_TOOLS.has(toolName);
          if (isFailedAction) {
            appMap.recordActionOutcome(learnBundleIdErr, false);
          }
          // Record feature signal failure (affects confidence and reliability)
          const failMapData = appMap.getLoaded(learnBundleIdErr);
          if (failMapData?.featureLadder) {
            const failSignal = [toolName, typeof failedLocator === "string" ? failedLocator : ""].join(" ").toLowerCase();
            const failGeneratedSignals = appMap.getGeneratedSignals(learnBundleIdErr) ?? {};
            for (const feature of failMapData.featureLadder) {
              const fm = failMapData.featureMastery?.[feature.id];
              if (!fm || fm.depth === 0) continue; // Only track failures on features we've seen
              // Check feature ID match OR keyword match (same as success path)
              const featureInSignal = failSignal.includes(feature.id.replace(/_/g, " "));
              const keywords = failGeneratedSignals[feature.id];
              const keywordMatch = keywords?.some((kw) => failSignal.includes(kw));
              if (featureInSignal || keywordMatch) {
                appMap.recordFeatureSignal(learnBundleIdErr, feature.id, fm.depth as 1 | 2 | 3 | 4, false);
              }
            }
          }
        } catch { /* app map update non-fatal */ }
      }

      // ── Capture failure for playbook recording ──
      if (mcpRecorder.isRecording) {
        mcpRecorder.captureToolCall(toolName, safeParams, false, errorMsg, durationMs);
      }

      // Record strategy failure if we were following one
      if (activeStrategyFingerprint) {
        memory.recordStrategyOutcome(activeStrategyFingerprint, false);
        activeStrategyFingerprint = null;
      }

      // Record error pattern (updates cache + async write)
      const errorPattern: ErrorPattern = {
        id: "err_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        tool: toolName,
        params: safeParams,
        error: errorMsg,
        resolution: null,
        occurrences: 1,
        lastSeen: new Date().toISOString(),
      };
      memory.appendError(errorPattern);

      // Background research: search for a fix if no resolution exists
      const existingErrors = memory.readErrors();
      const hasResolution = existingErrors.some(
        (e) => e.tool === toolName && e.error === errorMsg && e.resolution
      );
      if (!hasResolution) {
        backgroundResearch(memory as any, toolName, safeParams, errorMsg);
      }

      throw err;
    } finally {
      currentAdaptiveBudget = null;
    }
  };

  const newArgs = [...args];
  newArgs[handlerIdx] = wrappedHandler;
  return (originalTool as any)(...newArgs);
};

// ═══════════════════════════════════════════════
// APPS — discover and manage running applications
// ═══════════════════════════════════════════════

server.tool("apps", "List all running applications with bundle IDs and PIDs", {}, async () => {
  await ensureBridge();
  const apps = await bridge.call<any[]>("app.list");
  // L3-04 fix: Some Electron apps (Slack, Discord) don't appear in NSWorkspace.runningApplications
  // despite being visible with windows. Augment with frontmost app if missing from list.
  try {
    const front = await bridge.call<{ pid: number; name: string; bundleId: string }>("app.frontmost", {});
    if (front.pid && !apps.some((a: any) => a.pid === front.pid)) {
      apps.push({ ...front, isActive: true });
    }
  } catch { /* ignore */ }
  // Also augment from window list — any app with visible windows should appear.
  // Filter out XPC services and system helpers that own tiny overlay windows.
  try {
    const wins = await bridge.call<any[]>("app.windows");
    const appPids = new Set(apps.map((a: any) => a.pid));
    const seenWinPids = new Set<number>();
    for (const w of wins) {
      const wPid = w.pid || w.ownerPid;
      const bid = w.bundleId || "";
      // Skip XPC services, system helpers, and loginwindow — not real user apps
      if (!wPid || appPids.has(wPid) || seenWinPids.has(wPid)) continue;
      if (bid.includes(".xpc.") || bid === "com.apple.loginwindow" || bid === "unknown" || bid === "") continue;
      // Only include if the window has meaningful size (>50x50)
      const b = w.bounds || {};
      if ((b.width || 0) < 50 || (b.height || 0) < 50) continue;
      seenWinPids.add(wPid);
      apps.push({
        bundleId: bid,
        name: w.appName || "Unknown",
        pid: wPid,
        isActive: false,
      });
    }
  } catch { /* ignore */ }
  const lines = apps.map((a: any) =>
    `${a.name} (${a.bundleId}) pid=${a.pid}${a.isActive ? " ← active" : ""}`
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("windows", "List all visible windows with IDs, positions, and sizes", {}, async () => {
  await ensureBridge();
  const wins = await bridge.call<any[]>("app.windows");
  // Filter to meaningful windows: must have a title or reasonable size (>50x50)
  const meaningful = wins.filter((w: any) => {
    const b = w.bounds || {};
    const hasTitle = w.title && w.title.length > 0;
    const hasSize = (b.width || 0) > 50 && (b.height || 0) > 50;
    return hasTitle || hasSize;
  });
  const lines = meaningful.map((w: any) => {
    const b = w.bounds || {};
    const onScreen = w.isOnScreen === false ? " [minimized]" : "";
    return `[${w.windowId}] ${w.appName} "${w.title}" (${Math.round(b.x||0)},${Math.round(b.y||0)}) ${Math.round(b.width||0)}x${Math.round(b.height||0)}${onScreen}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("focus", "Focus/activate an application (or a specific window by windowId)", {
  bundleId: z.string().regex(/^[a-zA-Z0-9._-]+$/, "Invalid bundleId format").describe("App bundle ID, e.g. com.apple.Safari"),
  windowId: z.number().optional().describe("Specific window ID from windows() — raises that exact window. Use when multiple instances of the same app exist."),
}, async ({ bundleId, windowId }) => {
  await ensureBridge();
  // Serialize focus calls — only one can run at a time since only one app can be frontmost.
  // Without this, N concurrent focus() calls generate N*5 bridge calls that crash the bridge.
  let resolve: () => void;
  const prev = focusLock;
  focusLock = new Promise<void>(r => { resolve = r; });
  await prev;
  try {
    // Step 0: Verify the app is actually running — fail fast with error content
    const runningApps = await bridge.call<any[]>("app.list", {});
    let targetApp = runningApps?.find((a: any) => a.bundleId === bundleId);
    if (!targetApp) {
      // L3-04 fix: Some Electron apps (Slack, Discord) don't appear in app.list.
      // Check if they have visible windows before rejecting.
      try {
        const wins = await bridge.call<any[]>("app.windows");
        const appWin = wins?.find((w: any) => w.bundleId === bundleId);
        if (appWin) {
          targetApp = { bundleId, name: appWin.appName, pid: appWin.pid || appWin.ownerPid };
        }
      } catch { /* ignore */ }
      if (!targetApp) {
        return { content: [{ type: "text" as const, text: `Error: ${bundleId} is not running. Use launch("${bundleId}") first.` }], isError: true };
      }
    }
    // Step 1: Focus — use window.focus(windowId) when provided (L3-01 fix: precise window targeting)
    // This solves multi-instance Electron apps where bundleId-based focus raises the wrong window.
    let bridgeFocusError: string | undefined;
    try {
      if (windowId != null) {
        await bridge.call("window.focus", { windowId });
      } else {
        await bridge.call("app.focus", { bundleId });
      }
    } catch (e: any) {
      bridgeFocusError = e?.message ?? String(e);
    }
    // Step 2: Verify IMMEDIATELY — 150ms settle for macOS window server async transition.
    // 50ms was too short on cold start; 150ms handles even first-launch activation delays.
    await new Promise(r => setTimeout(r, 150));
    let focusMsg = "Focused " + bundleId;
    try {
      const front = await bridge.call<{ bundleId: string; name: string; pid: number }>("app.frontmost", {});
      if (front.bundleId !== bundleId) {
        // MCP-level retry: AppleScript activation as final fallback
        try {
          await bridge.call("as.run", { script: `tell application id "${bundleId}" to activate` });
          await new Promise(r => setTimeout(r, 200));
          const front2 = await bridge.call<{ bundleId: string; name: string; pid: number }>("app.frontmost", {});
          if (front2.bundleId === bundleId) {
            focusMsg = "Focused " + bundleId;
          } else {
            focusMsg = `Warning: focus requested for ${bundleId} but ${front2.bundleId} (${front2.name}) is frontmost. Try again or use launch() first.`;
          }
        } catch {
          focusMsg = `Warning: focus requested for ${bundleId} but ${front.bundleId} (${front.name}) is frontmost. Try again or use launch() first.`;
        }
      }
    } catch {
      if (bridgeFocusError) {
        focusMsg = `Warning: ${bridgeFocusError}. Call apps() to check if ${bundleId} is running.`;
      }
    }
    // Step 3: World model + perception (best-effort, after verification)
    try {
      const apps = await bridge.call<any[]>("app.list", {});
      const app = apps?.find((a: any) => a.bundleId === bundleId);
      if (app) {
        let windowId: number | undefined;
        try { windowId = await resolveWindowId(app.pid); } catch { /* best-effort */ }
        if (windowId != null) {
          try { await bridge.call("window.focus", { windowId }); } catch { /* best-effort */ }
        }
        const ctx = { bundleId, appName: app.name ?? bundleId, pid: app.pid, windowTitle: "", ...(windowId != null ? { windowId } : {}) };
        worldModel.updateFocusedApp(ctx);
        lastKnownBundleId = bundleId;
        try {
          await perceptionManager.ensureStarted(ctx);
          installSafariEnricher(bundleId);
        } catch { /* best-effort */ }
      }
    } catch { /* app.list failed — world model update is best-effort */ }
    return { content: [{ type: "text", text: focusMsg }] };
  } finally {
    resolve!();
  }
});

server.tool("launch", "Launch an application. Chrome/Chromium browsers are launched with CDP enabled (port 9222) for browser_* tools.", {
  bundleId: z.string().regex(/^[a-zA-Z0-9._-]+$/, "Invalid bundleId format").describe("App bundle ID"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port for Chrome/Chromium (default: 9222). Ignored for non-browser apps."),
}, async ({ bundleId, cdpPort }) => {
  await ensureBridge();
  const riskyBundleIds: Record<string, string> = {
    "com.apple.Terminal": "Terminal",
    "com.apple.ScriptEditor2": "Script Editor",
    "com.googlecode.iterm2": "iTerm",
    "com.apple.ActivityMonitor": "Activity Monitor",
  };
  // Chrome/Chromium: launch with CDP enabled so browser_* tools work immediately
  const chromeBundleIds: Record<string, string> = {
    "com.google.Chrome": "Google Chrome",
    "com.google.Chrome.canary": "Google Chrome Canary",
    "com.brave.Browser": "Brave Browser",
    "com.microsoft.edgemac": "Microsoft Edge",
    "org.chromium.Chromium": "Chromium",
  };
  const chromeAppName = chromeBundleIds[bundleId];
  let r: any;
  if (chromeAppName) {
    const port = cdpPort ?? 9222;
    try {
      // Spawn Chrome binary directly with --remote-debugging-port.
      // Must use a dedicated user-data-dir because Chrome ignores the CDP flag
      // when the default profile is already locked by a previous instance.
      const { spawn } = await import("child_process");
      const os = await import("os");
      const chromeBinary = `/Applications/${chromeAppName}.app/Contents/MacOS/${chromeAppName}`;
      const cdpProfile = `${os.tmpdir()}/screenhand-cdp-${port}`;
      const proc = spawn(chromeBinary, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${cdpProfile}`,
      ], { detached: true, stdio: "ignore" });
      proc.unref();
      // Wait for Chrome to start, then get its PID
      await new Promise(res => setTimeout(res, 1500));
      const apps = await bridge.call<any[]>("app.list", {});
      const chromeApp = apps?.find((a: any) => a.bundleId === bundleId);
      r = { pid: chromeApp?.pid ?? 0, appName: chromeApp?.name ?? bundleId };
    } catch {
      // Fallback to normal launch if CDP launch fails
      r = await bridge.call<any>("app.launch", { bundleId });
    }
  } else {
    r = await bridge.call<any>("app.launch", { bundleId });
  }
  const riskyName = riskyBundleIds[bundleId];
  // Auto-start perception for the launched app
  try {
    const windowId = await resolveWindowId(r.pid);
    await perceptionManager.ensureStarted({ bundleId, appName: r.appName ?? bundleId, pid: r.pid, windowTitle: "", ...(windowId != null ? { windowId } : {}) });
    installSafariEnricher(bundleId);
  } catch { /* perception start is best-effort */ }
  let msg = `Launched ${r.appName} pid=${r.pid}`;
  if (chromeAppName) {
    const port = cdpPort ?? 9222;
    msg += `\nCDP enabled on port ${port} — browser_* tools ready`;
  }
  if (riskyName) {
    msg += `\nWarning: launching ${riskyName} \u2014 this app can execute arbitrary commands`;
  }
  return { content: [{ type: "text", text: msg }] };
});

// ═══════════════════════════════════════════════
// INSPECT — see what's on screen (debugging/design)
// ═══════════════════════════════════════════════

server.tool("screenshot", "Take a screenshot and OCR it. Returns all visible text. NOTE: For finding/clicking UI elements, ui_tree + ui_press is 10x faster.", {
  windowId: z.number().optional().describe("Window ID. Omit for full screen."),
}, async ({ windowId }) => {
  await ensureBridge();
  let shot: any;
  if (windowId) {
    shot = await bridge.call<any>("cg.captureWindow", { windowId, safeCLI: isBrowserApp() });
  } else {
    shot = await bridge.call<any>("cg.captureScreen");
  }
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shot.path });

  // Feed OCR regions into world model
  try {
    if (windowId && Array.isArray(ocr.regions) && ocr.regions.length > 0) {
      worldModel.ingestOCRRegions(
        windowId,
        ocr.regions.map((r: any) => ({
          text: r.text,
          bounds: {
            x: r.bounds.x,
            y: r.bounds.y,
            width: r.bounds.width,
            height: r.bounds.height,
          },
        })),
      );
    }
  } catch { /* world model update is best-effort */ }

  return { content: [{ type: "text", text: `Screenshot: ${shot.width}x${shot.height} (${shot.path})\n\n${ocr.text}` }] };
});

server.tool("screenshot_file", "Take a screenshot and return the file path (for viewing the actual image)", {
  windowId: z.number().optional().describe("Window ID. Omit for full screen."),
}, async ({ windowId }) => {
  await ensureBridge();
  let shot: any;
  if (windowId) {
    shot = await bridge.call<any>("cg.captureWindow", { windowId, safeCLI: isBrowserApp() });
  } else {
    shot = await bridge.call<any>("cg.captureScreen");
  }
  return { content: [{ type: "text", text: shot.path }] };
});

server.tool("ocr", "OCR a window with element positions. SLOW — prefer ui_tree for structured element discovery. Use OCR only for reading visual/canvas content.", {
  windowId: z.number().optional().describe("Window ID. Omit for full screen."),
}, async ({ windowId }) => {
  await ensureBridge();
  let shot: any;
  if (windowId) {
    shot = await bridge.call<any>("cg.captureWindow", { windowId, safeCLI: isBrowserApp() });
  } else {
    shot = await bridge.call<any>("cg.captureScreen");
  }
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shot.path });

  let winBounds: any = null;
  if (windowId) {
    const wins = await bridge.call<any[]>("app.windows");
    const win = wins.find((w: any) => w.windowId === windowId);
    winBounds = win?.bounds;
  }

  const regions = ocr.regions.map((r: any) => {
    let text = redactSensitiveLabel(r.text);
    text = redactUsername(text);
    // Redact URLs in OCR text
    text = text.replace(/https?:\/\/[^\s"'`]+/g, (url: string) => sanitizeUrl(url));
    return `"${text}" (${Math.round(r.bounds.x)},${Math.round(r.bounds.y)}) ${Math.round(r.bounds.width)}x${Math.round(r.bounds.height)}`;
  });

  // Feed OCR regions into world model
  try {
    if (windowId && Array.isArray(ocr.regions) && ocr.regions.length > 0) {
      worldModel.ingestOCRRegions(
        windowId,
        ocr.regions.map((r: any) => ({
          text: r.text,
          bounds: {
            x: r.bounds.x,
            y: r.bounds.y,
            width: r.bounds.width,
            height: r.bounds.height,
          },
        })),
      );
    }
  } catch { /* world model update is best-effort */ }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        image: { width: shot.width, height: shot.height, path: shot.path },
        window: winBounds,
        elementCount: regions.length,
        elements: regions,
      }, null, 2),
    }],
  };
});

// ═══════════════════════════════════════════════
// ACCESSIBILITY — structured UI inspection (instant, no OCR)
// ═══════════════════════════════════════════════

server.tool("ui_tree", "PREFERRED: Get the full UI element tree of an app via Accessibility. ~50ms, no screenshot/OCR. Use this FIRST to find elements — returns titles, roles, and bounds. Then use ui_press/ui_find to interact.", {
  pid: z.number().describe("Process ID of the app"),
  maxDepth: z.number().optional().describe("Max depth (default 4). Use 2 for overview, 6+ for deep inspection."),
}, async ({ pid, maxDepth }) => {
  await ensureBridge();
  // Check if PID is running before querying AX tree (L3-04: uses fallback checks)
  if (!(await isPidRunning(pid))) {
    return { content: [{ type: "text", text: `PID ${pid} is not running. Call apps() to get current PIDs.` }] };
  }
  const tree = await bridge.call<any>("ax.getElementTree", { pid, maxDepth: maxDepth || 4 });

  // Feed AX tree into world model for state tracking
  try {
    const wins = await bridge.call<any[]>("window.list", {});
    const win = wins?.find((w: any) => w.pid === pid);
    if (win) {
      worldModel.ingestAXTree(win.windowId, tree, {
        bundleId: win.bundleId ?? "",
        appName: win.bundleId ?? "",
        pid,
        windowTitle: win.title ?? "",
        windowId: win.windowId,
      });
    }
  } catch { /* ignore — world model update is best-effort */ }

  function format(node: any, depth: number): string {
    let line = "  ".repeat(depth) + (node.role || "?");
    if (node.title) line += ` "${node.title}"`;
    if (node.value) line += ` =${String(node.value).slice(0, 200)}`;
    if (node.bounds) line += ` (${Math.round(node.bounds.x)},${Math.round(node.bounds.y)} ${Math.round(node.bounds.width)}x${Math.round(node.bounds.height)})`;
    let result = line;
    if (node.children) {
      for (const c of node.children) result += "\n" + format(c, depth + 1);
    }
    return result;
  }

  return { content: [{ type: "text", text: redactUsername(format(tree, 0)) }] };
});

server.tool("ui_find", "Find a specific UI element by text, title, or value. Falls back to value search if title match fails (e.g. finds Safari URL bar by URL).", {
  pid: z.number().describe("Process ID"),
  title: z.string().describe("Text to search for — matches title first, then value (partial match)"),
  role: z.string().optional().describe("AX role filter, e.g. AXButton, AXMenuItem, AXTextField"),
  exact: z.boolean().optional().default(false).describe("Exact title match (default: partial)"),
}, async ({ pid, title, role, exact }) => {
  await ensureBridge();
  if (!(await isPidRunning(pid))) {
    return { content: [{ type: "text", text: `PID ${pid} is not running. Call apps() to get current PIDs.` }] };
  }
  let r: any;
  try {
    r = await bridge.call<any>("ax.findElement", { pid, title, exact, ...(role ? { role } : {}) });
  } catch {
    // Title search failed — retry searching by value (e.g. AXTextField with URL as value)
    r = await bridge.call<any>("ax.findElement", { pid, value: title, exact, ...(role ? { role } : {}) });
  }

  // Feed found element into world model as a minimal AX subtree
  try {
    if (r && r.role) {
      const wins = await bridge.call<any[]>("window.list", {});
      const win = wins?.find((w: any) => w.pid === pid);
      if (win) {
        const subtree: any = {
          role: r.role,
          title: r.title ?? null,
          value: r.value ?? null,
          enabled: r.enabled ?? true,
          focused: r.focused ?? false,
          children: r.children ?? [],
        };
        if (r.bounds) {
          subtree.position = { x: r.bounds.x, y: r.bounds.y };
          subtree.size = { width: r.bounds.width, height: r.bounds.height };
        }
        worldModel.ingestAXTree(win.windowId, subtree, {
          bundleId: win.bundleId ?? "",
          appName: win.bundleId ?? "",
          pid,
          windowTitle: win.title ?? "",
          windowId: win.windowId,
        });
      }
    }
  } catch { /* world model update is best-effort */ }

  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

server.tool("ui_press", "PREFERRED: Find and press/click a UI element by its title via Accessibility. Faster and more reliable than click_text — no screenshot needed.", {
  pid: z.number().describe("Process ID"),
  title: z.string().describe("Element title to find and press"),
  role: z.string().optional().describe("AX role filter, e.g. AXButton, AXMenuItem, AXTextField"),
  exact: z.boolean().optional().default(false).describe("Exact title match (default: partial)"),
}, async ({ pid, title, role, exact }) => {
  await ensureBridge();
  if (!(await isPidRunning(pid))) {
    return { content: [{ type: "text", text: `PID ${pid} is not running. Call apps() to get current PIDs.` }] };
  }
  let el: any;
  try {
    el = await bridge.call<any>("ax.findElement", { pid, title, exact, ...(role ? { role } : {}) });
  } catch {
    try {
      // Fallback: search by value (buttons/controls may have value instead of title)
      el = await bridge.call<any>("ax.findElement", { pid, value: title, exact, ...(role ? { role } : {}) });
    } catch {
      // Check if a system dialog is blocking — different process owns the frontmost window
      try {
        const front = await bridge.call<{ pid: number; name: string; bundleId: string }>("app.frontmost", {});
        if (front.pid !== pid) {
          return { content: [{ type: "text" as const, text: `Element "${title}" not found in PID ${pid}. A system dialog from "${front.name}" (${front.bundleId}, PID ${front.pid}) may be blocking. Dismiss it first, or use click(x, y) to interact with the dialog directly.` }], isError: true };
        }
      } catch { /* ignore frontmost check failure */ }
      throw new Error(`Element "${title}" not found (searched title, value, and description)`);
    }
  }
  await bridge.call("ax.performAction", { pid, elementPath: el.elementPath, action: "AXPress" });
  return { content: [{ type: "text", text: `Pressed "${el.title || el.description || el.value}" (${el.role})` }] };
});

server.tool("ui_set_value", "Set the value of a UI element (text field, slider, etc.). Searches by title first, falls back to value match.", {
  pid: z.number().describe("Process ID"),
  title: z.string().describe("Element title to find"),
  value: z.string().describe("Value to set"),
}, async ({ pid, title, value }) => {
  await ensureBridge();
  let el: any;
  try {
    el = await bridge.call<any>("ax.findElement", { pid, title, exact: false });
  } catch {
    // Fallback: search by value (combo boxes, text fields often have no title)
    el = await bridge.call<any>("ax.findElement", { pid, value: title, exact: false });
  }
  await bridge.call("ax.setElementValue", { pid, elementPath: el.elementPath, value });
  return { content: [{ type: "text", text: `Set "${el.title || el.value}" = "${value}"` }] };
});

server.tool("menu_click", "Click a menu item in an app's menu bar", {
  pid: z.number().describe("Process ID"),
  menuPath: z.string().describe("Menu path separated by /. e.g. 'File/New', 'View/Show Sidebar'"),
}, async ({ pid, menuPath }) => {
  await ensureBridge();
  await bridge.call("ax.menuClick", { pid, menuPath: menuPath.split("/") });
  return { content: [{ type: "text", text: "Menu: " + menuPath }] };
});

// ═══════════════════════════════════════════════
// INPUT — interact with the screen
// ═══════════════════════════════════════════════

server.tool("click", "Click at screen coordinates", {
  x: z.number().describe("Screen X"),
  y: z.number().describe("Screen Y"),
  button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button (default: left)"),
  clickCount: z.number().optional().default(1).describe("Click count: 1=single, 2=double (word select), 3=triple (line select)"),
  modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])).optional().describe("Hold modifier keys during click (e.g. ['cmd'] for cmd+click, ['shift'] for shift+click)"),
  pid: z.number().optional().describe("Target process ID for PID-targeted event delivery"),
}, async ({ x, y, button, clickCount, modifiers, pid }) => {
  await ensureBridge();
  await bridge.call("cg.mouseMove", { x, y, targetPid: pid });
  await new Promise(r => setTimeout(r, 50));
  await bridge.call("cg.mouseClick", { x, y, button: button || "left", clickCount: clickCount || 1, modifiers: modifiers || [], targetPid: pid });
  const extras: string[] = [];
  if (modifiers?.length) extras.push(modifiers.join("+"));
  if (button && button !== "left") extras.push(button);
  if (clickCount && clickCount > 1) extras.push(clickCount === 2 ? "double" : `${clickCount}x`);
  return { content: [{ type: "text", text: `Clicked (${x}, ${y})${extras.length ? ` [${extras.join(", ")}]` : ""}` }] };
});

server.tool("click_text", "SLOW fallback: Find text on screen via OCR and click it. Use ui_press instead when possible — it's 10x faster. Only use this for canvas/image content where Accessibility doesn't work.", {
  windowId: z.number().describe("Window ID"),
  text: z.string().describe("Text to find and click"),
  offset_y: z.number().optional().describe("Y offset from text center (e.g. -25 for icon above label)"),
  prefer: z.enum(["first", "largest", "topmost", "leftmost"]).optional().default("first").describe("Match preference when multiple OCR hits: largest (headers), topmost, leftmost (sidebar), first (OCR order)"),
}, async ({ windowId, text, offset_y, prefer }) => {
  await ensureBridge();
  const wins = await bridge.call<any[]>("app.windows");
  const win = wins.find((w: any) => w.windowId === windowId);
  if (!win) return { content: [{ type: "text", text: "Window not found" }] };
  const wb = win.bounds;

  const shot = await bridge.call<any>("cg.captureWindow", { windowId, safeCLI: isBrowserApp() });
  const ocr = await bridge.call<any>("vision.ocr", { imagePath: shot.path });
  const allMatches = ocr.regions.filter((r: any) => r.text.toLowerCase().includes(text.toLowerCase()));
  if (allMatches.length === 0) {
    return { content: [{ type: "text", text: `"${text}" not found. Available: ${ocr.regions.map((r:any) => r.text).slice(0, 20).join(", ")}` }], isError: true };
  }

  // Sort by preference strategy
  if (prefer === "largest") {
    allMatches.sort((a: any, b: any) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height));
  } else if (prefer === "topmost") {
    allMatches.sort((a: any, b: any) => a.bounds.y - b.bounds.y);
  } else if (prefer === "leftmost") {
    allMatches.sort((a: any, b: any) => a.bounds.x - b.bounds.x);
  }
  const match = allMatches[0]!;

  // Convert OCR pixel coordinates to screen coordinates.
  // shot.width/height are in pixels; wb.width/height are in screen points.
  // The scale factor handles both Retina (2x) and non-Retina (1x) displays.
  //
  // L3-05 fix: Window captures now use boundsIgnoreFraming to exclude shadow,
  // so image dimensions match window bounds × backing scale (2x on Retina).
  // Simple ratio mapping: OCR pixels → screen points.
  const scaleX = shot.width > 0 ? wb.width / shot.width : 1;
  const scaleY = shot.height > 0 ? wb.height / shot.height : 1;
  const centerPixelX = match.bounds.x + match.bounds.width / 2;
  const centerPixelY = match.bounds.y + match.bounds.height / 2;
  let sx = Math.round(wb.x + centerPixelX * scaleX);
  let sy = Math.round(wb.y + centerPixelY * scaleY + (offset_y || 0));
  // Clamp to window bounds — OCR boxes can extend slightly beyond the window
  sx = Math.max(wb.x + 2, Math.min(sx, wb.x + wb.width - 2));
  sy = Math.max(wb.y + 2, Math.min(sy, wb.y + wb.height - 2));

  await bridge.call("cg.mouseMove", { x: sx, y: sy });
  await new Promise(r => setTimeout(r, 80)); // 80ms dwell — longer than 50ms helps dense UIs register hover
  await bridge.call("cg.mouseClick", { x: sx, y: sy });

  let response = `Clicked "${match.text}" at screen (${Math.round(sx)}, ${Math.round(sy)}) ` +
    `[OCR pixel: (${Math.round(match.bounds.x)}, ${Math.round(match.bounds.y)}) ${match.bounds.width}×${match.bounds.height}] ` +
    `[window: (${wb.x}, ${wb.y}) ${wb.width}×${wb.height}] ` +
    `[scale: ${scaleX.toFixed(3)}×${scaleY.toFixed(3)}]`;
  if (allMatches.length > 1) {
    response += ` [${allMatches.length} matches, used prefer="${prefer}"]`;
    response += `\n⚠ ${allMatches.length} matches found. Use prefer param or offset_y to disambiguate.`;
  }
  return { content: [{ type: "text", text: response }] };
});

server.tool("type_text", "Type text using the keyboard. Auto-detects Electron apps and routes through CDP for reliable editor input.", {
  text: z.string().describe("Text to type"),
  pid: z.number().optional().describe("Target process ID for PID-targeted event delivery"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port for Electron apps (e.g. 9229). When set, types via CDP instead of AX — fixes Copilot/panel focus theft."),
}, async ({ text, pid, cdpPort: portOverride }) => {
  await ensureBridge();
  // Auto-resolve frontmost PID when none provided — global HID posting
  // fails silently in NSTextView apps (TextEdit, etc.), but PID-targeted
  // delivery works reliably in all apps.
  let targetPid = pid;
  if (!targetPid) {
    try {
      const front = await bridge.call<{ pid: number; name: string; bundleId: string }>("app.frontmost", {});
      targetPid = front.pid;
    } catch {
      // Fallback to global posting if frontmost detection fails
    }
  }
  // Verify the target process exists and has windows
  if (targetPid) {
    try {
      const apps = await bridge.call<any[]>("app.list", {});
      let app = apps?.find((a: any) => a.pid === targetPid);
      if (!app) {
        // L3-04 fix: Some Electron apps (Slack, Discord) don't appear in NSWorkspace.runningApplications
        // despite being frontmost. Check app.frontmost as fallback before rejecting.
        try {
          const front = await bridge.call<{ pid: number; name: string; bundleId: string }>("app.frontmost", {});
          if (front.pid === targetPid) {
            app = front;
          }
        } catch { /* ignore */ }
        if (!app) {
          return { content: [{ type: "text", text: `PID ${targetPid} is not running. Call apps() to get current PIDs.` }] };
        }
      }
      const wins = await bridge.call<any[]>("window.list", { pid: targetPid });
      if (!wins || wins.length === 0) {
        return { content: [{ type: "text", text: `Warning: PID ${targetPid} (${app.name}) has no windows. Keystrokes may be lost. Open a document first.` }] };
      }
    } catch {
      // Best-effort check — proceed with typing if validation fails
    }
  }
  // L3-02 fix: Raise the specific window before typing to ensure keystrokes land correctly.
  // Without this, Electron apps with multiple instances can lose keystrokes to the wrong window,
  // or text can go to a non-editor area (e.g. Walkthrough tab instead of editor).
  if (targetPid) {
    try {
      const winId = await resolveWindowId(targetPid);
      if (winId != null) {
        await bridge.call("window.focus", { windowId: winId });
      }
    } catch { /* best-effort — proceed with typing */ }
  }

  // L3-02 fix: Electron CDP typing — routes through CDP Input.dispatchKeyEvent
  // when cdpPort is specified or auto-detected. Solves Copilot chat / panel focus
  // theft where AX keystrokes go to chat input instead of Monaco editor.
  let electronCdpPort = portOverride;
  if (!electronCdpPort && targetPid) {
    // Auto-detect: probe Electron-common CDP ports, but ONLY use if the CDP target
    // belongs to the same app we're targeting. Without this check, typing to Slack
    // could get routed through VS Code's CDP port 9229.
    try {
      // Look up target app name for matching
      let targetAppName = "";
      try {
        const apps = await bridge.call<any[]>("app.list", {});
        const app = apps?.find((a: any) => a.pid === targetPid);
        targetAppName = (app?.name || "").toLowerCase();
        if (!targetAppName) {
          const front = await bridge.call<{ pid: number; name: string }>("app.frontmost", {});
          if (front.pid === targetPid) targetAppName = (front.name || "").toLowerCase();
        }
      } catch { /* ignore */ }

      for (const p of [9229, 9333]) {
        try {
          if (!CDP) CDP = (await import("chrome-remote-interface")).default;
          const version = await CDP.Version({ port: p });
          // Verify the CDP target matches the target app — check if the browser name
          // or any page title contains the app name (e.g. "Code" in VS Code page titles)
          const browserName = (version?.Browser || "").toLowerCase();
          if (targetAppName && !browserName.includes(targetAppName)) {
            // Double-check against page titles
            try {
              const targets = await CDP.List({ port: p });
              const titleMatch = targets?.some((t: any) =>
                (t.title || "").toLowerCase().includes(targetAppName)
              );
              if (!titleMatch) continue; // CDP doesn't belong to target app — skip
            } catch { continue; }
          }
          electronCdpPort = p;
          break;
        } catch { /* not available on this port */ }
      }
    } catch { /* auto-detect is best-effort */ }
  }

  if (electronCdpPort) {
    // CDP path: click editor to ensure focus, then type via key events
    try {
      const { client } = await getCDPClient(undefined, electronCdpPort);
      // Click the editor area to grab focus from Copilot/panels
      await client.Runtime.evaluate({
        expression: `(() => {
          const editor = document.querySelector('.monaco-editor .view-lines');
          if (editor) { editor.click(); return true; }
          // Generic fallback: focus the first contenteditable or active editor context
          const editable = document.querySelector('[contenteditable="true"]') || document.querySelector('.native-edit-context');
          if (editable) { editable.focus(); return true; }
          return false;
        })()`,
        returnByValue: true,
      });
      await randomDelay(30, 60);
      // Type character by character via CDP Input.dispatchKeyEvent
      for (const char of text) {
        await client.Input.dispatchKeyEvent({ type: "keyDown", text: char, key: char, unmodifiedText: char });
        await client.Input.dispatchKeyEvent({ type: "keyUp", text: char, key: char, unmodifiedText: char });
        await randomDelay(10, 30);
      }
      await client.close();
      const msg = `Typed via CDP (port ${electronCdpPort}): "${text}"`;
      return { content: [{ type: "text", text: msg }] };
    } catch (cdpErr: any) {
      // CDP failed — fall through to AX typing
    }
  }

  // AX path: standard cg.typeText via native bridge
  // L2-66 fix: Auto-chunk long text to prevent bridge timeout.
  // cg.typeText simulates individual keystrokes, so >500 chars can be slow.
  const CHUNK_SIZE = 500;
  if (text.length > CHUNK_SIZE) {
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      const chunk = text.slice(i, i + CHUNK_SIZE);
      await bridge.call("cg.typeText", { text: chunk, targetPid });
    }
  } else {
    await bridge.call("cg.typeText", { text, targetPid });
  }
  const msg = targetPid ? `Typed to PID ${targetPid}: "${text}"` : "Typed: " + text;
  return { content: [{ type: "text", text: msg }] };
});

server.tool("key", "Press a key combination", {
  combo: z.string().describe("Key combo: 'cmd+c', 'enter', 'cmd+shift+n', 'space'. Use + to separate."),
  holdMs: z.number().optional().describe("Hold the key for this many ms (for accent picker, long-press menus). Default: tap."),
  pid: z.number().optional().describe("Target process ID for PID-targeted event delivery"),
}, async ({ combo, holdMs, pid }) => {
  await ensureBridge();
  // Auto-resolve frontmost PID when none provided — ensures keystrokes
  // reach the correct app (same pattern as type_text auto-PID).
  let targetPid = pid;
  if (!targetPid) {
    try {
      const front = await bridge.call<{ pid: number }>("app.frontmost", {});
      targetPid = front.pid;
    } catch { /* fallback to global posting */ }
  }
  const keys = combo.split("+");
  const hasModifier = keys.some(k => ["cmd", "ctrl", "alt", "shift"].includes(k.toLowerCase()));
  // macOS only processes modifier shortcuts (cmd+c, cmd+n, etc.) for the frontmost app.
  // When pid is targeted with modifiers, raise the specific window first.
  // L3-01 fix: use window.focus(windowId) instead of app.focus(bundleId) to avoid
  // targeting the wrong instance when multiple Electron apps share the same bundleId.
  if (targetPid && hasModifier) {
    try {
      const winId = await resolveWindowId(targetPid);
      if (winId != null) {
        await bridge.call("window.focus", { windowId: winId });
      } else {
        // Fallback to bundleId-based focus if no window found
        const apps = await bridge.call("app.list", {}) as Array<{ pid: number; bundleId: string }>;
        const target = apps.find(a => a.pid === targetPid);
        if (target) {
          await bridge.call("app.focus", { bundleId: target.bundleId });
        }
      }
    } catch { /* focus is best-effort */ }
  }
  // Press-and-hold mode for accent picker / long-press menus
  if (holdMs && !hasModifier && keys.length === 1) {
    await bridge.call("cg.keyPressAndHold", { key: keys[0], durationMs: holdMs, targetPid });
    return { content: [{ type: "text", text: `Key held: ${combo} (${holdMs}ms)` + (targetPid ? ` (PID ${targetPid})` : "") }] };
  }
  await bridge.call("cg.keyCombo", { keys, targetPid });
  return { content: [{ type: "text", text: `Key: ${combo}` + (targetPid ? ` (PID ${targetPid})` : "") }] };
});

server.tool("drag", "Drag from one point to another", {
  fromX: z.number(), fromY: z.number(),
  toX: z.number(), toY: z.number(),
  modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])).optional().describe("Hold modifier keys during drag (e.g. ['alt'] for option+drag copy in Finder)"),
  pid: z.number().optional().describe("Target process ID for PID-targeted event delivery"),
}, async ({ fromX, fromY, toX, toY, modifiers, pid }) => {
  await ensureBridge();
  await bridge.call("cg.mouseDrag", { fromX, fromY, toX, toY, modifiers: modifiers || [], targetPid: pid });
  const modStr = modifiers?.length ? ` [${modifiers.join("+")}]` : "";
  return { content: [{ type: "text", text: `Dragged (${fromX},${fromY}) → (${toX},${toY})${modStr}` }] };
});

server.tool("scroll", "Scroll at a position", {
  x: z.number(), y: z.number(),
  deltaX: z.number().optional().describe("Horizontal scroll (default 0)"),
  deltaY: z.number().describe("Vertical scroll (negative = down)"),
  pid: z.number().optional().describe("Target process ID for PID-targeted event delivery"),
}, async ({ x, y, deltaX, deltaY, pid }) => {
  await ensureBridge();
  await bridge.call("cg.scroll", { x, y, deltaX: deltaX || 0, deltaY, targetPid: pid });
  return { content: [{ type: "text", text: "Scrolled" }] };
});

// ── CDP helper: get client for a tab ──
async function getCDPClient(tabId?: string, overridePort?: number): Promise<{ client: any; targetId: string; CDP: any; port: number }> {
  const { CDP: cdp, port } = await ensureCDP(overridePort);
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  // Activate CDP source in perception when a browser connection is established
  try { perceptionManager.activateCDP(client); } catch { /* best-effort */ }
  return { client, targetId: targetId!, CDP: cdp, port };
}

// ── Random delay helper ──
function randomDelay(min: number, max: number): Promise<void> {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// ═══════════════════════════════════════════════
// BROWSER — control Chrome pages via CDP (10ms, not OCR)
// ═══════════════════════════════════════════════

server.tool("browser_tabs", "List all open Chrome/Electron tabs. Use cdpPort to connect to a specific app (e.g. 9333 for Codex Desktop).", {
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps). Omit to auto-detect."),
}, async ({ cdpPort: portOverride }) => {
  const { CDP: cdp, port } = await ensureCDP(portOverride);
  const targets = await cdp.List({ port });
  const pages = targets.filter((t: any) => t.type === "page");
  const lines = pages.map((t: any) => `[${t.id}] ${t.title} — ${t.url}`);
  return { content: [{ type: "text", text: lines.join("\n") || "No tabs open" }] };
});

server.tool("browser_open", "Open a URL in Chrome/Electron (creates new tab)", {
  url: z.string().describe("URL to open"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ url, cdpPort: portOverride }) => {
  // L2-71 fix: Block dangerous URL protocols
  const BLOCKED_PROTOCOLS = ["javascript:", "data:", "blob:", "vbscript:"];
  const urlLower = url.trim().toLowerCase();
  for (const proto of BLOCKED_PROTOCOLS) {
    if (urlLower.startsWith(proto)) {
      throw new Error(`Blocked: "${proto}" URLs are not allowed in browser_open for security reasons.`);
    }
  }
  // Capture bundleId BEFORE CDP call to prevent focus-change race
  const browserBundleId = worldModel.getState().focusedApp?.bundleId ?? "com.google.Chrome";
  const { CDP: cdp, port } = await ensureCDP(portOverride);
  const target = await cdp.New({ port, url });

  // Feed new tab into world model
  try {
    worldModel.ingestCDPSnapshot(browserBundleId, url, target.title ?? url);
  } catch { /* world model update is best-effort */ }

  return { content: [{ type: "text", text: `Opened: ${target.id} — ${url}` }] };
});

server.tool("browser_navigate", "Navigate the active Chrome/Electron tab to a URL", {
  url: z.string().describe("URL to navigate to"),
  tabId: z.string().optional().describe("Tab ID (from browser_tabs). Omit for most recent tab."),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ url, tabId, cdpPort: portOverride }) => {
  // L2-71 fix: Block dangerous URL protocols that could execute arbitrary code
  const BLOCKED_PROTOCOLS = ["javascript:", "data:", "blob:", "vbscript:"];
  const urlLower = url.trim().toLowerCase();
  for (const proto of BLOCKED_PROTOCOLS) {
    if (urlLower.startsWith(proto)) {
      throw new Error(`Blocked: "${proto}" URLs are not allowed in browser_navigate for security reasons. Use browser_js for JavaScript execution.`);
    }
  }
  // Capture bundleId BEFORE CDP call to prevent focus-change race
  const browserBundleId = worldModel.getState().focusedApp?.bundleId ?? "com.google.Chrome";
  const { CDP: cdp, port } = await ensureCDP(portOverride);
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Page.enable();
  await client.Page.navigate({ url });
  // Wait for load
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await client.Runtime.evaluate({ expression: "document.readyState", returnByValue: true });
    if (r.result.value === "complete" || r.result.value === "interactive") break;
    await new Promise(r => setTimeout(r, 200));
  }
  const titleResult = await client.Runtime.evaluate({ expression: "document.title", returnByValue: true });
  const pageTitle = titleResult.result.value ?? "";
  await client.close();

  // Feed navigation result into world model
  try {
    worldModel.ingestCDPSnapshot(browserBundleId, url, pageTitle);
  } catch { /* world model update is best-effort */ }

  return { content: [{ type: "text", text: `Navigated to: ${pageTitle}` }] };
});

server.tool("browser_js", "Execute JavaScript in a Chrome/Electron tab. Returns the result. WARNING: This runs arbitrary JS in the browser context — avoid on sensitive pages (banking, email). All executions are audit-logged.", {
  code: z.string().describe("JavaScript to execute. Must be an expression that returns a value. Use (() => { ... })() for multi-line."),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ code, tabId, cdpPort: portOverride }) => {
  auditLog("browser_js", { code, tabId });
  const { CDP: cdp, port } = await ensureCDP(portOverride);
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Runtime.enable();
  const result = await client.Runtime.evaluate({
    expression: code,
    awaitPromise: true,
    returnByValue: true,
  });
  await client.close();

  if (result.exceptionDetails) {
    return { content: [{ type: "text", text: `JS Error: ${result.exceptionDetails.text}\n${result.exceptionDetails.exception?.description || ""}` }] };
  }

  const val = result.result.value;
  let text = typeof val === "object" ? JSON.stringify(val, null, 2) : String(val ?? "undefined");
  // Redact sensitive URLs and tokens in JS output
  text = text.replace(/https?:\/\/[^\s"'`]+/g, (url) => sanitizeUrl(url));
  text = redactSensitiveLabel(text);
  return { content: [{ type: "text", text }] };
});

server.tool("browser_dom", "Query the DOM of a Chrome/Electron page. Returns matching elements' text, attributes, and structure.", {
  selector: z.string().describe("CSS selector, e.g. 'button', '.nav a', '#main h2'"),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
  limit: z.number().optional().describe("Max results (default 20)"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ selector, tabId, limit, cdpPort: portOverride }) => {
  // Capture bundleId before any async CDP calls to avoid race condition
  const browserBundleId = worldModel.getState().focusedApp?.bundleId ?? "com.google.Chrome";
  const { CDP: cdp, port } = await ensureCDP(portOverride);
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Runtime.enable();
  const maxResults = limit || 20;
  const result = await client.Runtime.evaluate({
    expression: `(() => {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(0, ${maxResults});
      return els.map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        class: el.className?.toString()?.slice(0, 100) || undefined,
        text: el.textContent?.trim()?.slice(0, 200),
        href: el.href || undefined,
        src: el.src || undefined,
        value: el.value || undefined,
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      }));
    })()`,
    returnByValue: true,
  });

  // Feed page info into world model while client is still open
  try {
    const pageInfo = await client.Runtime.evaluate({
      expression: `({ url: location.href, title: document.title })`,
      returnByValue: true,
    });
    const info = pageInfo.result.value;
    if (info?.url) {
      worldModel.ingestCDPSnapshot(browserBundleId, info.url, info.title ?? "");
    }
  } catch { /* world model update is best-effort */ }

  await client.close();

  return { content: [{ type: "text", text: JSON.stringify(result.result.value, null, 2) }] };
});

server.tool("browser_click", "Click an element in Chrome/Electron by CSS selector. Uses CDP Input.dispatchMouseEvent for realistic mouse events.", {
  selector: z.string().describe("CSS selector of element to click"),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ selector, tabId, cdpPort: portOverride }) => {
  const { client } = await getCDPClient(tabId, portOverride);
  await client.Runtime.enable();

  const result = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Element not found: ${selector.replace(/"/g, '\\"')}" };
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent?.trim()?.slice(0, 100) };
    })()`,
    returnByValue: true,
  });

  const val = result.result.value;
  if (!val?.ok) {
    await client.close();
    return { content: [{ type: "text", text: val?.reason || "Element not found" }] };
  }

  const { x, y } = val;
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await randomDelay(30, 60);
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await randomDelay(30, 80);
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  await client.close();
  return { content: [{ type: "text", text: `Clicked: "${val.text}" at (${Math.round(x)}, ${Math.round(y)})` }] };
});

server.tool("browser_type", "Type into an input field in Chrome/Electron. Uses CDP Input.dispatchKeyEvent for real keyboard events (works with React/Angular).", {
  selector: z.string().describe("CSS selector of the input"),
  text: z.string().describe("Text to type"),
  clear: z.boolean().optional().describe("Clear field first (default true)"),
  tabId: z.string().optional().describe("Tab ID"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ selector, text, clear, tabId, cdpPort: portOverride }) => {
  const { client } = await getCDPClient(tabId, portOverride);
  await client.Runtime.enable();

  // Focus the element
  const focusResult = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Input not found" };
      el.scrollIntoView({ block: "center" });
      el.focus();
      return { ok: true };
    })()`,
    returnByValue: true,
  });

  if (!focusResult.result.value?.ok) {
    await client.close();
    return { content: [{ type: "text", text: focusResult.result.value?.reason || "Input not found" }] };
  }

  // Clear if needed: select all + delete
  const shouldClear = clear !== false;
  if (shouldClear) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Backspace", code: "Backspace" });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Backspace", code: "Backspace" });
    await randomDelay(30, 80);
  }

  // Type character by character with random delays
  for (const char of text) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", text: char, key: char, unmodifiedText: char });
    await client.Input.dispatchKeyEvent({ type: "keyUp", text: char, key: char, unmodifiedText: char });
    await randomDelay(30, 80);
  }

  await client.close();
  return { content: [{ type: "text", text: `Typed "${text}"` }] };
});

server.tool("browser_wait", "Wait for a condition on a Chrome/Electron page", {
  condition: z.string().describe("JS expression that returns truthy when ready. e.g. 'document.querySelector(\".loaded\")'"),
  timeoutMs: z.number().optional().describe("Timeout in ms (default 10000)"),
  tabId: z.string().optional().describe("Tab ID"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ condition, timeoutMs, tabId, cdpPort: portOverride }) => {
  const { CDP: cdp, port } = await ensureCDP(portOverride);
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Runtime.enable();
  const deadline = Date.now() + (timeoutMs || 10000);
  let met = false;
  while (Date.now() < deadline) {
    const r = await client.Runtime.evaluate({ expression: `!!(${condition})`, returnByValue: true });
    if (r.result.value) { met = true; break; }
    await new Promise(r => setTimeout(r, 300));
  }
  await client.close();
  return { content: [{ type: "text", text: met ? "Condition met" : "Timeout — condition not met" }] };
});

server.tool("browser_page_info", "Get current page title, URL, and text content summary", {
  tabId: z.string().optional().describe("Tab ID"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ tabId, cdpPort: portOverride }) => {
  // Capture bundleId BEFORE CDP call to prevent focus-change race
  const browserBundleId = worldModel.getState().focusedApp?.bundleId ?? "com.google.Chrome";
  const { CDP: cdp, port } = await ensureCDP(portOverride);
  let targetId = tabId;
  if (!targetId) {
    const targets = await cdp.List({ port });
    const page = targets.find((t: any) => t.type === "page");
    if (!page) throw new Error("No tabs open");
    targetId = page.id;
  }
  const client = await cdp({ port, target: targetId });
  await client.Runtime.enable();
  const result = await client.Runtime.evaluate({
    expression: `(() => ({
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.slice(0, 2000) || "",
    }))()`,
    returnByValue: true,
  });
  await client.close();

  // Feed page info into world model
  try {
    const info = result.result.value;
    if (info?.url) {
      worldModel.ingestCDPSnapshot(browserBundleId, info.url, info.title ?? "");
    }
  } catch { /* world model update is best-effort */ }

  return { content: [{ type: "text", text: JSON.stringify(result.result.value, null, 2) }] };
});

// ═══════════════════════════════════════════════
// BROWSER STEALTH — anti-detection patches
// ═══════════════════════════════════════════════

const STEALTH_SCRIPT = `
// Hide navigator.webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// Delete ChromeDriver leak variables
for (const key of Object.keys(window)) {
  if (key.match(/^cdc_/)) delete (window)[key];
}

// Realistic plugins array
Object.defineProperty(navigator, 'plugins', {
  get: () => [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  ],
});

// Realistic languages
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

// Patch chrome.runtime to look realistic (not headless)
if (!window.chrome) (window as any).chrome = {};
if (!window.chrome.runtime) (window as any).chrome.runtime = { connect: () => {}, sendMessage: () => {} };

// Patch Permissions.query for notifications
const origQuery = window.Permissions?.prototype?.query;
if (origQuery) {
  window.Permissions.prototype.query = function(params: any) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
    }
    return origQuery.call(this, params);
  };
}
`;

server.tool("browser_stealth", "Inject anti-detection patches into Chrome/Electron page. Call once after navigating to a protected site. Hides webdriver flag, patches plugins/languages/permissions.", {
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ tabId, cdpPort: portOverride }) => {
  const { client } = await getCDPClient(tabId, portOverride);
  await client.Page.enable();
  await client.Page.addScriptToEvaluateOnNewDocument({ source: STEALTH_SCRIPT });
  // Also evaluate immediately on current page
  await client.Runtime.enable();
  await client.Runtime.evaluate({ expression: STEALTH_SCRIPT, returnByValue: true });
  await client.close();
  return { content: [{ type: "text", text: "Stealth patches injected: webdriver hidden, plugins/languages/permissions patched." }] };
});

// ═══════════════════════════════════════════════
// BROWSER HUMAN-LIKE INPUT — anti-detection tools
// ═══════════════════════════════════════════════

server.tool("browser_fill_form", "Fill a form field with human-like typing (anti-detection). Uses real keyboard events via CDP Input domain.", {
  selector: z.string().describe("CSS selector of the input"),
  text: z.string().describe("Text to type"),
  clear: z.boolean().optional().describe("Clear field first (default true)"),
  delayMs: z.number().optional().describe("Avg delay between keystrokes in ms (default 50)"),
  tabId: z.string().optional().describe("Tab ID"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ selector, text, clear, delayMs, tabId, cdpPort: portOverride }) => {
  const { client } = await getCDPClient(tabId, portOverride);
  await client.Runtime.enable();

  // Focus the element
  const focusResult = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Element not found: ${selector.replace(/"/g, '\\"')}" };
      el.scrollIntoView({ block: "center" });
      el.focus();
      return { ok: true };
    })()`,
    returnByValue: true,
  });
  if (!focusResult.result.value?.ok) {
    await client.close();
    return { content: [{ type: "text", text: focusResult.result.value?.reason || "Element not found" }] };
  }

  // Clear if needed
  const shouldClear = clear !== false;
  if (shouldClear) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Backspace", code: "Backspace" });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Backspace", code: "Backspace" });
    await randomDelay(30, 80);
  }

  // Type character by character with random delays
  const avgDelay = delayMs ?? 50;
  const minDelay = Math.max(10, avgDelay - 20);
  const maxDelay = avgDelay + 30;

  for (const char of text) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", text: char, key: char, unmodifiedText: char });
    await client.Input.dispatchKeyEvent({ type: "keyUp", text: char, key: char, unmodifiedText: char });
    await randomDelay(minDelay, maxDelay);
  }

  await client.close();
  return { content: [{ type: "text", text: `Typed "${text}" (${text.length} chars, human-like)` }] };
});

// browser_human_click — alias for browser_click (both already use realistic mouse events)
server.tool("browser_human_click", "Alias for browser_click — both use realistic mouseMoved → mousePressed → mouseReleased events. Prefer browser_click directly.", {
  selector: z.string().describe("CSS selector of element to click"),
  tabId: z.string().optional().describe("Tab ID. Omit for most recent tab."),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port override (e.g. 9333 for Electron apps)"),
}, async ({ selector, tabId, cdpPort: portOverride }) => {
  const { client } = await getCDPClient(tabId, portOverride);
  await client.Runtime.enable();

  const result = await client.Runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "Element not found: ${selector.replace(/"/g, '\\"')}" };
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent?.trim()?.slice(0, 100) };
    })()`,
    returnByValue: true,
  });

  const val = result.result.value;
  if (!val?.ok) {
    await client.close();
    return { content: [{ type: "text", text: val?.reason || "Element not found" }] };
  }

  const { x, y } = val;
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await randomDelay(30, 60);
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await randomDelay(30, 80);
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  await client.close();
  return { content: [{ type: "text", text: `Clicked: "${val.text}" at (${Math.round(x)}, ${Math.round(y)})` }] };
});

// ═══════════════════════════════════════════════
// PLATFORM PLAYBOOKS — lazy-loaded site knowledge
// ═══════════════════════════════════════════════

const coverageAuditor = new CoverageAuditor(referencesDir, playbooksDir, learningEngine, goalStore);

server.tool("platform_guide", "Get automation guide for a platform (selectors, URLs, flows, error solutions). Reads from references/ (curated knowledge). Zero cost — only loads when called.", {
  platform: z.string().describe("Platform name, e.g. 'figma', 'x-twitter', 'devpost'"),
  section: z.enum(["all", "urls", "flows", "selectors", "errors", "detection"]).optional().describe("Section to return (default: all). Use 'errors' for just error+solution pairs."),
}, async ({ platform, section }) => {
  const safePlatName = platform.toLowerCase().replace(/[^a-z0-9_\-]/g, "_").slice(0, 100);
  const filePath = path.resolve(referencesDir, `${safePlatName}.json`);
  if (!filePath.startsWith(path.resolve(referencesDir))) {
    return { content: [{ type: "text", text: `Error: invalid platform name "${platform}"` }] };
  }
  if (!fs.existsSync(filePath)) {
    const available = fs.existsSync(referencesDir)
      ? fs.readdirSync(referencesDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""))
      : [];
    return { content: [{ type: "text", text: `No playbook for "${platform}". Available: ${available.join(", ") || "none"}` }] };
  }

  // L2-73 fix: Gracefully handle malformed reference JSON
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (parseErr) {
    return { content: [{ type: "text", text: `Warning: reference file for "${platform}" is malformed and was skipped. Error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}` }] };
  }
  const s = section || "all";

  if (s === "errors") {
    const errors = data.errors || [];
    const text = errors.map((e: any, i: number) =>
      `${i + 1}. [${e.severity}] ${e.error}\n   Context: ${e.context}\n   Solution: ${e.solution}`
    ).join("\n\n");
    return { content: [{ type: "text", text: text || "No errors documented." }] };
  }

  if (s === "urls") {
    return { content: [{ type: "text", text: JSON.stringify(data.urls, null, 2) }] };
  }

  if (s === "detection") {
    return { content: [{ type: "text", text: JSON.stringify(data.detection, null, 2) }] };
  }

  if (s === "flows") {
    const flows = data.flows || {};
    const text = Object.entries(flows).map(([name, flow]: [string, any]) => {
      const steps = (flow.steps || []).map((s: string, i: number) => `  ${i + 1}. ${s}`).join("\n");
      const tips = (flow.tips || []).map((t: string) => `  TIP: ${t}`).join("\n");
      return `### ${name}\n${steps}${tips ? "\n" + tips : ""}`;
    }).join("\n\n");
    return { content: [{ type: "text", text }] };
  }

  if (s === "selectors") {
    const flows = data.flows || {};
    const text = Object.entries(flows).map(([name, flow]: [string, any]) => {
      const sels = flow.selectors || {};
      const lines = Object.entries(sels).map(([k, v]) => `  ${k}: ${v}`).join("\n");
      return `### ${name}\n${lines}`;
    }).join("\n\n");
    return { content: [{ type: "text", text }] };
  }

  // "all" — return full playbook
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

server.tool("playbook_preflight", "Quick feasibility check before automating a platform. Scans the page for known blockers (captchas, WebGL, iframes), checks against playbook errors, tests selector availability. Returns go/yellow/red.", {
  url: z.string().describe("URL to check, e.g. 'https://x.com'"),
  task: z.string().optional().describe("What you want to automate, e.g. 'post a tweet'"),
  tabId: z.string().optional().describe("Tab ID if page is already open"),
}, async ({ url, task, tabId }) => {
  const issues: string[] = [];
  const warnings: string[] = [];
  const good: string[] = [];

  // 1. Extract domain and find matching playbook
  let domain: string;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return { content: [{ type: "text", text: `❌ Invalid URL: ${url}` }] };
  }

  // Check references/ for curated knowledge
  const reference = _playbookStoreForContext.matchByDomain(domain);
  if (reference) {
    good.push(`Found reference: "${reference.id}" (${reference.successCount} successes, ${reference.failCount} failures)`);

    // Check known errors
    if (reference.errors && reference.errors.length > 0) {
      for (const err of reference.errors) {
        if (err.severity === "high") {
          issues.push(`🔴 ${err.error} → ${err.solution}`);
        } else {
          warnings.push(`🟡 ${err.error} → ${err.solution}`);
        }
      }
    }

    // Check selector availability
    if (reference.selectors) {
      const selectorCount = Object.values(reference.selectors).reduce((sum, group) => sum + Object.keys(group).length, 0);
      good.push(`${selectorCount} selectors documented in reference`);
    }

    if (reference.flows && Object.keys(reference.flows).length > 0) {
      good.push(`${Object.keys(reference.flows).length} flows documented`);
    }
  } else {
    warnings.push(`🟡 No playbook exists for ${domain} — first-time automation, expect trial and error`);
  }

  // Check playbooks/ for executable steps
  const execPlaybookPath = path.resolve(playbooksDir, `${reference?.id ?? domain.split(".")[0]}.json`);
  if (fs.existsSync(execPlaybookPath)) {
    try {
      const execPb = JSON.parse(fs.readFileSync(execPlaybookPath, "utf-8"));
      if (Array.isArray(execPb.steps) && execPb.steps.length > 0) {
        good.push(`Executable playbook found: ${execPb.steps.length} steps — use job_create(playbookId="${execPb.id}") for auto-run`);
      }
    } catch { /* skip */ }
  } else if (reference) {
    warnings.push(`🟡 Reference exists but no executable playbook — manual execution needed`);
  }

  // 2. Scan the page if we have CDP access
  try {
    const { CDP: cdp, port } = await ensureCDP();
    let targetId = tabId;
    if (!targetId) {
      const targets = await cdp.List({ port });
      const page = targets.find((t: any) => t.type === "page" && t.url?.includes(domain));
      targetId = page?.id;
    }

    if (targetId) {
      const client = await cdp({ port, target: targetId });

      // Check for common blockers
      const checks = await client.Runtime.evaluate({
        expression: `(() => {
          const results = {};
          // Captcha detection
          results.hasCaptcha = !!(
            document.querySelector('[class*="captcha"]') ||
            document.querySelector('[class*="recaptcha"]') ||
            document.querySelector('[data-sitekey]') ||
            document.querySelector('iframe[src*="captcha"]') ||
            document.querySelector('iframe[src*="recaptcha"]')
          );
          // WebGL canvas (can't click via DOM)
          results.hasWebGL = !!(document.querySelector('canvas[data-engine]') || document.querySelector('canvas.webgl'));
          // Shadow DOM
          const allEls = document.querySelectorAll('*');
          let shadowCount = 0;
          for (const el of allEls) { if (el.shadowRoot) shadowCount++; }
          results.shadowDomCount = shadowCount;
          // Iframes
          results.iframeCount = document.querySelectorAll('iframe').length;
          // React/SPA detection
          results.isReact = !!(window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]'));
          results.isNextJs = !!document.querySelector('#__next');
          results.pageTitle = document.title;
          results.url = location.href;
          return results;
        })()`,
        returnByValue: true,
      });

      await client.close();

      const r = checks.result.value;
      if (r) {
        good.push(`Page loaded: "${r.pageTitle}"`);
        if (r.hasCaptcha) issues.push(`🔴 CAPTCHA detected — cannot be automated, needs manual solve`);
        if (r.hasWebGL) warnings.push(`🟡 WebGL canvas detected — DOM clicks won't work, use Input.dispatchMouseEvent or coordinates`);
        if (r.shadowDomCount > 0) warnings.push(`🟡 ${r.shadowDomCount} Shadow DOM elements — standard selectors may not reach them`);
        if (r.iframeCount > 0) warnings.push(`🟡 ${r.iframeCount} iframes — may need to switch context`);
        if (r.isReact) warnings.push(`🟡 React app — el.value assignment may not work, use browser_fill_form instead`);
      }
    } else {
      warnings.push(`🟡 Page not open in Chrome — open ${url} first for deeper scan`);
    }
  } catch {
    warnings.push(`🟡 Chrome CDP not available — can't scan page. Launch Chrome with --remote-debugging-port=9222`);
  }

  // 3. Check memory for past errors on this domain
  const memErrors = memory.readErrors();
  const domainErrors = memErrors.filter(e => {
    const paramStr = JSON.stringify(e.params ?? {});
    return paramStr.includes(domain);
  });
  if (domainErrors.length > 0) {
    warnings.push(`🟡 ${domainErrors.length} past error(s) recorded for ${domain} in memory`);
  }

  // 4. Build verdict
  const rating = issues.length > 0 ? "🔴 RED" : warnings.length > 2 ? "🟡 YELLOW" : "🟢 GREEN";

  const lines = [
    `# Preflight: ${domain}`,
    `Rating: ${rating}`,
    "",
    ...good.map(g => `✅ ${g}`),
    ...(issues.length > 0 ? ["", "## Blockers", ...issues] : []),
    ...(warnings.length > 0 ? ["", "## Warnings", ...warnings] : []),
    "",
    issues.length > 0
      ? "⛔ Some tasks may not be fully automatable. Review blockers above."
      : "✅ Looks feasible. Proceed with automation.",
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("export_playbook", "Generate a playbook JSON from your session. Extracts URLs, selectors, errors+solutions from memory. Share the output with ScreenHand to help others automate this platform.", {
  platform: z.string().describe("Platform name, e.g. 'linkedin', 'twitter'"),
  domain: z.string().describe("Domain to filter actions by, e.g. 'linkedin.com'"),
  description: z.string().optional().describe("Short description of the platform"),
  tabId: z.string().optional().describe("Tab ID to scan current page for selectors"),
}, async ({ platform, domain, description, tabId }) => {
  // 1. Pull URLs and errors from memory store
  const actions = memory.readActions();
  const errors = memory.readErrors();
  const strategies = memory.readStrategies();

  const domainLower = domain.toLowerCase();

  // Extract unique URLs from actions that touched this domain
  const urlSet = new Set<string>();
  for (const a of actions) {
    const params = a.params as Record<string, any> || {};
    const url = params.url || "";
    if (typeof url === "string" && url.toLowerCase().includes(domainLower)) {
      urlSet.add(url);
    }
    const result = a.result || "";
    const urlMatch = result.match(/https?:\/\/[^\s"]+/g);
    if (urlMatch) {
      for (const u of urlMatch) {
        if (u.toLowerCase().includes(domainLower)) urlSet.add(u);
      }
    }
  }

  // Extract errors related to this domain's tools
  const domainErrors: Array<{ error: string; tool: string; resolution: string | null; occurrences: number }> = [];
  for (const e of errors) {
    const params = e.params as Record<string, any> || {};
    const url = params.url || params.selector || "";
    const isRelevant = (typeof url === "string" && url.toLowerCase().includes(domainLower)) ||
      actions.some(a => {
        const ap = a.params as Record<string, any> || {};
        return a.tool === e.tool && typeof ap.url === "string" && ap.url.toLowerCase().includes(domainLower);
      });
    if (isRelevant) {
      domainErrors.push({
        error: e.error,
        tool: e.tool,
        resolution: e.resolution,
        occurrences: e.occurrences,
      });
    }
  }

  // Extract relevant strategies
  const domainStrategies = strategies.filter(s =>
    s.task.toLowerCase().includes(domainLower) ||
    s.task.toLowerCase().includes(platform.toLowerCase()) ||
    s.tags.some(t => t.toLowerCase().includes(platform.toLowerCase()))
  );

  // 2. Scan current page for selectors if tab is available
  let pageSelectors: Record<string, string> = {};
  if (tabId) {
    try {
      const { client } = await getCDPClient(tabId);
      await client.Runtime.enable();
      const scanResult = await client.Runtime.evaluate({
        expression: `(() => {
          const url = location.href;
          if (!url.toLowerCase().includes(${JSON.stringify(domainLower)})) return { match: false, url };
          const inputs = Array.from(document.querySelectorAll('input,select,textarea,button[type="submit"]'));
          const selectors = {};
          for (const el of inputs) {
            const id = el.id;
            const name = el.name || el.getAttribute('aria-label') || el.placeholder || el.type || el.tagName.toLowerCase();
            const key = (id || name || '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
            if (!key) continue;
            if (id) selectors[key] = '#' + id;
            else if (el.name) selectors[key] = '[name="' + el.name + '"]';
            else if (el.getAttribute('aria-label')) selectors[key] = '[aria-label="' + el.getAttribute('aria-label') + '"]';
          }
          return { match: true, url, selectors };
        })()`,
        returnByValue: true,
      });
      await client.close();
      if (scanResult.result.value?.match) {
        pageSelectors = scanResult.result.value.selectors || {};
      }
    } catch {
      // No browser or wrong page — skip selector scan
    }
  }

  // 3. Build playbook JSON
  const playbook = {
    platform: platform.toLowerCase(),
    version: "1.0.0",
    updated: new Date().toISOString().slice(0, 10),
    description: description || `Automation playbook for ${platform}`,
    urls: Object.fromEntries(
      Array.from(urlSet).sort().map((u, i) => {
        const urlObj = new URL(u);
        // L2-69 fix: Redact sensitive query params before exporting
        const sensitiveParams = new Set(["code", "token", "access_token", "refresh_token", "id_token",
          "secret", "password", "key", "api_key", "apikey", "auth",
          "session", "session_id", "sessionid", "state", "nonce"]);
        for (const paramName of urlObj.searchParams.keys()) {
          if (sensitiveParams.has(paramName.toLowerCase())) {
            urlObj.searchParams.set(paramName, "[REDACTED]");
          }
        }
        const safeUrl = urlObj.toString();
        const pathKey = urlObj.pathname.replace(/^\//, "").replace(/\//g, "_").replace(/[^a-zA-Z0-9_]/g, "") || "home";
        return [pathKey, safeUrl];
      })
    ),
    flows: {
      discovered: {
        // S75 Option C: Redact PII from exported strategy steps
        steps: domainStrategies.length > 0
          ? domainStrategies[0]!.steps.map((s: any) => redactPII(`${s.tool}(${JSON.stringify(s.params)})`))
          : ["No strategies recorded yet. Use the platform, then call export_playbook again."],
        selectors: pageSelectors,
      },
    },
    detection: {
      is_logged_in: "// Add detection JS for logged-in state",
    },
    errors: domainErrors.map(e => ({
      error: e.error,
      context: `Tool: ${e.tool} (${e.occurrences}x)`,
      solution: e.resolution || "No resolution recorded yet. Fix it and call memory_save.",
      severity: e.occurrences >= 3 ? "high" : "medium",
    })),
    _meta: {
      exported_from: "screenhand",
      actions_count: actions.filter(a => {
        const p = a.params as Record<string, any> || {};
        return typeof p.url === "string" && p.url.toLowerCase().includes(domainLower);
      }).length,
      strategies_count: domainStrategies.length,
    },
  };

  // 4. Save to references dir (curated knowledge, not executable steps)
  const safePlatformName = platform.toLowerCase().replace(/[^a-z0-9_\-]/g, "_").slice(0, 100);
  const outPath = path.resolve(referencesDir, `${safePlatformName}.json`);
  // Guard: refuse to write outside references dir
  if (!outPath.startsWith(path.resolve(referencesDir))) {
    return { content: [{ type: "text", text: `Error: invalid platform name "${platform}" — path traversal detected` }] };
  }
  const exists = fs.existsSync(outPath);

  if (!fs.existsSync(referencesDir)) fs.mkdirSync(referencesDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(playbook, null, 2));

  // Track playbook export for teaching ability rating factor
  const expBundleId = worldModel.getState().focusedApp?.bundleId;
  if (expBundleId) {
    const expMapData = appMap.getLoaded(expBundleId);
    if (expMapData) {
      expMapData.playbooksExported = (expMapData.playbooksExported ?? 0) + 1;
      appMap.save(expMapData, true);
    }
  }

  return {
    content: [{
      type: "text",
      text: `${exists ? "Updated" : "Created"} reference: references/${platform.toLowerCase()}.json\n\n` +
        `URLs found: ${urlSet.size}\n` +
        `Selectors found: ${Object.keys(pageSelectors).length}\n` +
        `Errors documented: ${domainErrors.length}\n` +
        `Strategies: ${domainStrategies.length}\n\n` +
        `Share this file to help others automate ${platform}.\n\n` +
        JSON.stringify(playbook, null, 2),
    }],
  };
});

// ═══════════════════════════════════════════════
// PLAYBOOK RECORD — macro recorder for MCP tool calls
// ═══════════════════════════════════════════════

server.tool("playbook_record", "Macro recorder: start recording, do the flow, stop to save as executable playbook. Captures every click/type/navigate tool call as a PlaybookStep.", {
  action: z.enum(["start", "stop", "cancel", "status"]).describe("start/stop/cancel/status"),
  platform: z.string().optional().describe("Platform name (required for start)"),
  name: z.string().optional().describe("Playbook name (required for stop)"),
  description: z.string().optional().describe("Playbook description (for stop)"),
  cdpPort: z.number().min(9222).max(9999).optional().describe("CDP port if needed for browser_js steps (e.g. 9333 for Codex)"),
}, async ({ action, platform, name, description, cdpPort }) => {
  switch (action) {
    case "start": {
      if (!platform) return { content: [{ type: "text", text: "Error: platform is required for start" }] };
      if (mcpRecorder.isRecording) return { content: [{ type: "text", text: "Already recording. Call stop or cancel first." }] };
      mcpRecorder.start(platform, cdpPort ?? undefined);
      return { content: [{ type: "text", text: `Recording started for "${platform}". All subsequent tool calls will be captured.\nCall playbook_record(action="stop", name="...") when done.` }] };
    }
    case "stop": {
      if (!mcpRecorder.isRecording) return { content: [{ type: "text", text: "No active recording." }] };
      if (!name) return { content: [{ type: "text", text: "Error: name is required for stop" }] };
      const playbook = mcpRecorder.stop(name, description ?? name);
      // Track playbook export for teaching ability rating factor
      const pbBundleId = worldModel.getState().focusedApp?.bundleId;
      if (pbBundleId) {
        const pbMapData = appMap.getLoaded(pbBundleId);
        if (pbMapData) {
          pbMapData.playbooksExported = (pbMapData.playbooksExported ?? 0) + 1;
          appMap.save(pbMapData, true);
        }
      }
      const stepList = playbook.steps.map((s, i) => `  ${i + 1}. [${s.action}] ${s.description ?? ""}`).join("\n");
      return { content: [{ type: "text", text: `Playbook saved: playbooks/${playbook.id}.json (${playbook.steps.length} steps)\n\n${stepList}` }] };
    }
    case "cancel": {
      mcpRecorder.cancel();
      return { content: [{ type: "text", text: "Recording cancelled." }] };
    }
    case "status": {
      if (!mcpRecorder.isRecording) return { content: [{ type: "text", text: "Not recording." }] };
      const steps = mcpRecorder.getSteps().map((s, i) => `  ${i + 1}. [${s.action}] ${s.description ?? ""}`).join("\n");
      return { content: [{ type: "text", text: `Recording active: ${mcpRecorder.stepCount} steps captured\n${steps}` }] };
    }
  }
});

// ═══════════════════════════════════════════════
// PLATFORM EXPLORE — autonomous app exploration
// ═══════════════════════════════════════════════

server.tool("platform_explore", "Autonomously explore an app or website. Maps all interactive elements, tries each one, records working selectors and broken paths. Outputs a reference JSON.", {
  platform: z.string().describe("Platform name for the output file, e.g. 'figma', 'canva'"),
  url: z.string().optional().describe("URL for web app. Requires Chrome with --remote-debugging-port."),
  bundleId: z.string().optional().describe("macOS bundle ID for native app, e.g. 'com.figma.Desktop'"),
  maxElements: z.number().optional().describe("Max elements to test (default: 30)"),
  tabId: z.string().optional().describe("Existing Chrome tab ID if page is already open"),
}, async ({ platform, url, bundleId, maxElements, tabId }) => {
  const max = maxElements ?? 30;

  if (url || tabId) {
    // Web exploration via CDP
    const { CDP: cdp, port } = await ensureCDP();
    let targetId = tabId;
    if (!targetId) {
      if (url) {
        // Navigate to URL in a new tab
        const targets = await cdp.List({ port });
        const page = targets.find((t: any) => t.type === "page");
        if (!page) throw new Error("No Chrome tabs open");
        targetId = page.id;
        const client = await cdp({ port, target: targetId });
        await client.Page.enable();
        await client.Page.navigate({ url });
        await new Promise(r => setTimeout(r, 3000));
        await client.close();
      }
    }
    if (!targetId) throw new Error("No tab available");

    const client = await cdp({ port, target: targetId });
    await client.Runtime.enable();

    const evaluate = async (expr: string) => {
      return client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    };

    // Discover elements
    const elements = await discoverWebElements(evaluate, max);

    // Test each element
    const tested = [];
    for (const el of elements) {
      const result = await testWebElement(evaluate, el);
      tested.push(result);
      await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
    }

    await client.close();

    // Compile and save
    const result = compileReference(platform, "web", tested, url);
    const filePath = saveExploreResult(referencesDir, result);

    return { content: [{ type: "text", text: `Exploration complete: ${filePath}\n\nElements found: ${elements.length}\nTested: ${result.testedElements}\nWorking selectors: ${result.workingSelectors}\nErrors: ${result.errors.length}\n\nKey discoveries:\n${result.keyDiscoveries.map(d => `  - ${d}`).join("\n")}` }] };

  } else if (bundleId) {
    // Native app exploration via bridge
    await ensureBridge();
    const apps = await bridge.call<Array<{ bundleId: string; pid: number }>>("app.list");
    const app = apps.find(a => a.bundleId === bundleId);
    if (!app) {
      await bridge.call("app.launch", { bundleId });
      await new Promise(r => setTimeout(r, 3000));
    }
    const appList = await bridge.call<Array<{ bundleId: string; pid: number }>>("app.list");
    const target = appList.find(a => a.bundleId === bundleId);
    if (!target) throw new Error(`App ${bundleId} not running`);

    const elements = await discoverNativeElements(bridge, target.pid, max);

    // For native apps, we record discovery but don't auto-click (too risky)
    const result = compileReference(platform, "native", elements.map(el => ({
      ...el, clickWorked: true, result: "discovered_not_tested",
    })), undefined, bundleId);
    const filePath = saveExploreResult(referencesDir, result);

    return { content: [{ type: "text", text: `Native app exploration complete: ${filePath}\n\nElements discovered: ${elements.length}\n(Native elements discovered but not auto-clicked for safety. Use playbook_record to test interactively.)` }] };

  } else {
    return { content: [{ type: "text", text: "Error: Provide either url (for web apps) or bundleId (for native apps)." }] };
  }
});

// ═══════════════════════════════════════════════
// PLATFORM LEARN — scrape docs/help/shortcuts
// ═══════════════════════════════════════════════

server.tool("platform_learn", "Scrape official docs, help center, keyboard shortcuts for a platform. Crawls pages via Chrome and extracts structured data into a reference JSON.", {
  platform: z.string().describe("Platform name, e.g. 'figma', 'notion', 'slack'"),
  url: z.string().optional().describe("Root URL to start from. If omitted, guesses from platform name."),
  maxPages: z.number().optional().describe("Max pages to crawl (default: 5)"),
}, async ({ platform, url, maxPages }) => {
  const max = maxPages ?? 5;
  const urls = buildDocUrls(platform, url);

  const { CDP: cdp, port } = await ensureCDP();
  const targets = await cdp.List({ port });
  const page = targets.find((t: any) => t.type === "page");
  if (!page) throw new Error("No Chrome tabs open. Open Chrome first.");

  const client = await cdp({ port, target: page.id });
  await client.Runtime.enable();
  await client.Page.enable();

  const crawled: Array<{ url: string; content?: any; shortcuts?: Record<string, string>; selectors?: Record<string, string> }> = [];
  let successCount = 0;

  for (const docUrl of urls) {
    if (successCount >= max) break;
    try {
      const result = await crawlPage(client, docUrl, 8000);
      if (result.success && result.content && result.content.text.length > 100) {
        crawled.push({ url: docUrl, content: result.content, ...(result.shortcuts ? { shortcuts: result.shortcuts } : {}), ...(result.selectors ? { selectors: result.selectors } : {}) });
        successCount++;
      }
    } catch {
      // Skip failed URLs silently
    }
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
  }

  await client.close();

  if (crawled.length === 0) {
    return { content: [{ type: "text", text: `No documentation pages found for "${platform}". Try providing a specific URL.` }] };
  }

  const result = compileLearnResult(platform, crawled);
  const filePath = saveLearnResult(referencesDir, result);

  return { content: [{ type: "text", text: `Learning complete: ${filePath}\n\nPages crawled: ${crawled.length}\nShortcuts found: ${Object.keys(result.shortcuts).length}\nFeatures found: ${result.features.length}\nSelectors found: ${Object.values(result.selectors).reduce((n, g) => n + Object.keys(g).length, 0)}\nAPI endpoints: ${result.apiEndpoints.length}\nKnown limitations: ${result.knownLimitations.length}` }] };
});

// ═══════════════════════════════════════════════
// APPLESCRIPT — control scriptable apps directly
// ═══════════════════════════════════════════════

server.tool("applescript", "Run an AppleScript command. For controlling Finder, Safari, Mail, Notes, etc. (macOS only). WARNING: Executes arbitrary AppleScript — can perform destructive actions (delete files, send emails). All executions are audit-logged.", {
  script: z.string().describe("AppleScript code to execute"),
}, async ({ script }) => {
  auditLog("applescript", { script });
  if (process.platform === "win32") {
    return { content: [{ type: "text", text: "AppleScript is not supported on Windows. Use ui_tree, ui_press, and other accessibility tools instead." }] };
  }
  // Block shell execution vectors in AppleScript — allowlist approach for safety-critical commands
  const scriptLower = script.toLowerCase();
  const BLOCKED_PATTERNS = [
    /do\s+shell\s+script/i,          // direct shell execution
    /run\s+shell\s+script/i,          // variant
    /run\s+script/i,                  // dynamic AppleScript eval (can construct blocked commands)
    /do\s+script/i,                   // Terminal.app shell execution
    /«class\s/i,                      // raw Apple Event codes (bypass text-level blocks)
    /system\s+events.*process/i,      // process spawning via System Events
    /NSAppleScript/i,                 // Objective-C bridge
    /ObjC\.import/i,                  // JXA Objective-C bridge
    /\bshell\b/i,                     // catch-all for shell-related commands
    /do\s+JavaScript/i,              // JXA execution
  ];
  if (BLOCKED_PATTERNS.some(p => p.test(script))) {
    return { content: [{ type: "text", text: "Blocked: this AppleScript contains a restricted command (shell execution, dynamic eval, or process spawning). Use the Bash tool for shell commands." }] };
  }
  // Block string concatenation that could reassemble blocked commands
  if (/&/.test(script) && (/script/i.test(script) || /shell/i.test(script))) {
    return { content: [{ type: "text", text: "Blocked: AppleScript with string concatenation containing 'script' or 'shell' — potential bypass attempt." }] };
  }
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim();
    return { content: [{ type: "text", text: result || "(no output)" }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: "Error: " + (e.stderr || e.message) }] };
  }
});

// ═══════════════════════════════════════════════
// MEMORY — recall past strategies and error patterns
// ═══════════════════════════════════════════════

originalTool("memory_snapshot", "Get current memory state snapshot — session info, mission, health metrics, known patterns, and policy.", {}, async () => {
  const snap = memory.getSnapshot();
  return { content: [{ type: "text" as const, text: JSON.stringify(snap, null, 2) }] };
});

originalTool("memory_recall", "Search past successful strategies by keyword. ALWAYS call this before automating an unfamiliar platform — it may have a saved strategy from a previous session. Returns matching strategies with step-by-step actions that worked before.", {
  task: z.string().describe("Describe the task you want to accomplish"),
  limit: z.number().optional().describe("Max results (default 5)"),
}, async ({ task, limit }) => {
  const matches = memory.recallStrategies(task, limit ?? 5);
  if (matches.length === 0) {
    return { content: [{ type: "text" as const, text: "No matching strategies found. Try memory_save after completing a task to build up knowledge." }] };
  }
  const text = matches.map((m, i) => {
    const steps = m.steps.map((s, j) => `  ${j + 1}. ${s.tool}(${JSON.stringify(s.params)})`).join("\n");
    return `${i + 1}. "${m.task}" (used ${m.successCount}x, score: ${m.score.toFixed(2)})\n${steps}`;
  }).join("\n\n");
  return { content: [{ type: "text" as const, text }] };
});

originalTool("memory_save", "Save a successful approach for future sessions. Call this after completing a task so next time you (or another agent) can memory_recall() it instead of figuring it out again. Persists to disk — survives restarts.", {
  task: z.string().describe("Short description of the task that was accomplished"),
  tags: z.array(z.string()).optional().describe("Optional tags for easier recall"),
}, async ({ task, tags }) => {
  const strategy = memory.saveStrategy(task, tags);
  if (!strategy) {
    return { content: [{ type: "text" as const, text: "No actions recorded in the current session. Perform some tool calls first, then save." }] };
  }
  return { content: [{ type: "text" as const, text: `Saved strategy "${task}" with ${strategy.steps.length} steps. Tags: ${strategy.tags.join(", ")}` }] };
});

originalTool("memory_record_error", "Record a known error pattern with an optional fix. Helps future sessions avoid the same problem.", {
  tool: z.string().describe("Tool that failed"),
  error: z.string().describe("Error message or description"),
  fix: z.string().optional().describe("How to fix or work around this error"),
  scope: z.string().optional().describe("Scope of the error (e.g., 'chrome/github.com', 'vscode/terminal')"),
}, async ({ tool, error, fix, scope }) => {
  memory.recordError(tool, error, fix ?? null, scope);
  return { content: [{ type: "text" as const, text: `Error pattern recorded for "${tool}": "${error}"${fix ? `\nFix: ${fix}` : ""}` }] };
});

originalTool("memory_record_learning", "Record a verified pattern — what works, what fails, and how to fix it. Builds the knowledge base for future sessions.", {
  scope: z.string().describe("Scope (e.g., 'chrome/github.com', 'slack/desktop', 'vscode/terminal')"),
  pattern: z.string().describe("What worked or failed"),
  method: z.enum(["ax", "cdp", "ocr", "coordinates"]).describe("Which execution method was used"),
  confidence: z.number().min(0).max(1).describe("Confidence level 0-1"),
  success: z.boolean().describe("Was this a success or failure?"),
  fix: z.string().optional().describe("Fix or workaround if it was a failure"),
}, async ({ scope, pattern, method, confidence, success, fix }) => {
  memory.recordLearning({
    scope,
    pattern,
    method,
    confidence,
    successCount: success ? 1 : 0,
    failCount: success ? 0 : 1,
    lastSeen: new Date().toISOString(),
    fix: fix ?? null,
  });
  return { content: [{ type: "text" as const, text: `Learning recorded: ${scope} — "${pattern}" (${method}, confidence=${confidence})` }] };
});

originalTool("memory_query_patterns", "Search verified learnings by scope and/or execution method.", {
  scope: z.string().optional().describe("Filter by scope (e.g., 'chrome', 'vscode')"),
  method: z.enum(["ax", "cdp", "ocr", "coordinates"]).optional().describe("Filter by execution method"),
}, async ({ scope, method }) => {
  const patterns = memory.queryPatterns(scope, method);
  if (patterns.length === 0) {
    return { content: [{ type: "text" as const, text: "No matching patterns found." }] };
  }
  const text = patterns.map((p, i) =>
    `${i + 1}. [${p.method}] ${p.scope}: "${p.pattern}" (confidence=${p.confidence.toFixed(2)}, ${p.successCount}✓ ${p.failCount}✗)${p.fix ? `\n   Fix: ${p.fix}` : ""}`
  ).join("\n");
  return { content: [{ type: "text" as const, text }] };
});

originalTool("memory_errors", "What goes wrong with this tool? Shows known error patterns and resolutions.", {
  tool: z.string().optional().describe("Tool name to filter by (omit for all errors)"),
}, async ({ tool }) => {
  const errors = memory.queryErrors(tool);
  if (errors.length === 0) {
    return { content: [{ type: "text" as const, text: tool ? `No known error patterns for "${tool}".` : "No error patterns recorded yet." }] };
  }
  const text = errors.map((e, i) =>
    `${i + 1}. ${e.tool}: "${e.error}" (${e.occurrences}x)${e.resolution ? `\n   Fix: ${e.resolution}` : ""}`
  ).join("\n");
  return { content: [{ type: "text" as const, text }] };
});

originalTool("memory_stats", "How much have I learned? Shows total actions, strategies, error patterns, and success rates.", {}, async () => {
  const stats = memory.getStats();
  const lines = [
    `Actions logged: ${stats.totalActions}`,
    `Strategies saved: ${stats.totalStrategies}`,
    `Error patterns: ${stats.totalErrors}`,
    `Success rate: ${(stats.successRate * 100).toFixed(1)}%`,
    `Disk usage: ${(stats.diskUsageBytes / 1024).toFixed(1)} KB`,
  ];
  if (stats.topTools.length > 0) {
    lines.push("", "Top tools:");
    for (const t of stats.topTools) {
      lines.push(`  ${t.tool}: ${t.count} calls`);
    }
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("memory_clear", "Forget everything or just a specific category. Clears stored memory data.", {
  what: z.enum(["all", "actions", "strategies", "errors", "learnings"]).describe("What to clear"),
}, async ({ what }) => {
  memory.clear(what);
  return { content: [{ type: "text" as const, text: `Cleared ${what === "all" ? "all memory data" : what}.` }] };
});

// ═══════════════════════════════════════════════
// SESSION SUPERVISOR — lease management, stall detection, recovery
// ═══════════════════════════════════════════════

originalTool("session_claim", "Claim exclusive control of an app window. Prevents other clients from acting on the same window.", {
  clientId: z.string().describe("Your client identifier (e.g., 'claude_abc123')"),
  clientType: z.enum(["claude", "codex", "cursor", "openclaw"]).describe("Client type"),
  app: z.string().describe("Bundle ID of the app (e.g., 'com.google.Chrome')"),
  windowId: z.number().describe("Window ID to claim (get from 'windows' tool)"),
}, async ({ clientId, clientType, app, windowId }) => {
  // Validate window ID exists
  try {
    await ensureBridge();
    const wins = await bridge.call<any[]>("window.list", {});
    if (wins && !wins.some((w: any) => w.windowId === windowId)) {
      return { content: [{ type: "text" as const, text: `Window ${windowId} does not exist. Use the windows() tool to get valid window IDs.` }] };
    }
  } catch { /* best-effort validation — proceed if bridge unavailable */ }

  // Use filesystem-backed lease manager directly (shared with daemon)
  const lease = leaseManager.claim(
    { id: clientId, type: clientType, startedAt: new Date().toISOString() },
    app, windowId,
  );
  if (!lease) {
    const existing = leaseManager.isLocked(app, windowId);
    return { content: [{ type: "text" as const, text: `Window already claimed by ${existing?.client.type ?? "unknown"} (session=${existing?.sessionId}). Release it first or wait for expiry.` }] };
  }
  return { content: [{ type: "text" as const, text: `Session claimed!\nSession ID: ${lease.sessionId}\nApp: ${app}\nWindow: ${windowId}\nExpires: ${lease.expiresAt}\n\nCall session_heartbeat every 60s to keep the lease alive.` }] };
});

originalTool("session_heartbeat", "Keep your session lease alive. Call every 60 seconds. Lease expires after 5 minutes without heartbeat.", {
  sessionId: z.string().describe("Session ID from session_claim"),
}, async ({ sessionId }) => {
  // Use filesystem-backed lease manager directly (shared with daemon)
  const ok = leaseManager.heartbeat(sessionId);
  if (!ok) {
    return { content: [{ type: "text" as const, text: `Session ${sessionId} not found or expired. Re-claim with session_claim.` }] };
  }
  return { content: [{ type: "text" as const, text: `Heartbeat OK for ${sessionId}.` }] };
});

originalTool("session_release", "Release your session lease so other clients can use the window.", {
  sessionId: z.string().describe("Session ID to release"),
}, async ({ sessionId }) => {
  // Flush playbook learnings before releasing session
  contextTracker.flush();

  // Use filesystem-backed lease manager directly (shared with daemon)
  const released = leaseManager.release(sessionId);
  return { content: [{ type: "text" as const, text: released ? `Session ${sessionId} released.` : `Session ${sessionId} not found.` }] };
});

originalTool("supervisor_status", "Get supervisor state — active sessions, health metrics, stall detection.", {
  tail_log: z.number().optional().describe("Show last N lines of supervisor log (default: 0, max: 50)"),
}, async ({ tail_log }) => {
  const { running: daemonRunning, pid: daemonPid } = isSupervisorDaemonRunning();

  // Always read active sessions from the shared filesystem lock dir (source of truth)
  const activeSessions = leaseManager.getActive();

  // Read daemon health counters if available, otherwise show minimal info
  let health = { uptimeMs: 0, totalSessions: 0, expiredLeases: 0, stallsDetected: 0, recoveriesAttempted: 0 };
  if (daemonRunning && fs.existsSync(SUPERVISOR_STATE_FILE)) {
    try {
      const daemonState = JSON.parse(fs.readFileSync(SUPERVISOR_STATE_FILE, "utf-8"));
      health = daemonState.health ?? health;
    } catch { /* use defaults */ }
  }

  const lines = [
    `Supervisor: ${daemonRunning ? "DAEMON RUNNING" : "STOPPED"} (pid=${daemonPid ?? "n/a"})`,
    `Active sessions: ${activeSessions.length} (from lock files)`,
  ];
  if (daemonRunning) {
    lines.push(
      `Uptime: ${Math.round(health.uptimeMs / 60000)}m`,
      `Expired leases: ${health.expiredLeases}`,
      `Stalls detected: ${health.stallsDetected}`,
      `Recoveries attempted: ${health.recoveriesAttempted}`,
    );
  }
  if (activeSessions.length > 0) {
    lines.push("", "Active sessions:");
    for (const s of activeSessions) {
      lines.push(`  ${s.sessionId}: ${s.client.type} → ${s.app} (window=${s.windowId}, heartbeat=${s.lastHeartbeat})`);
    }
  }

  if (tail_log && tail_log > 0) {
    try {
      const logContent = fs.readFileSync(SUPERVISOR_LOG_FILE, "utf-8");
      const logLines = logContent.trim().split("\n").slice(-Math.min(tail_log, 50));
      lines.push("", "--- Supervisor Log ---");
      lines.push(logLines.join("\n"));
    } catch {
      lines.push("\n(no log file found)");
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

const SUPERVISOR_DIR = path.join(os.homedir(), ".screenhand", "supervisor");
const SUPERVISOR_PID_FILE = path.join(SUPERVISOR_DIR, "supervisor.pid");
const SUPERVISOR_STATE_FILE = path.join(SUPERVISOR_DIR, "state.json");
const SUPERVISOR_LOG_FILE = path.join(SUPERVISOR_DIR, "supervisor.log");
const SUPERVISOR_RECOVERIES_FILE = path.join(SUPERVISOR_DIR, "recoveries.json");
const SUPERVISOR_DAEMON_SCRIPT = path.resolve(__dirname, "scripts", "supervisor-daemon.ts");

/** Read recoveries from daemon's filesystem state (with corrupt-file recovery). */
function readDaemonRecoveries(): RecoveryAction[] {
  return readJsonWithRecovery<RecoveryAction[]>(SUPERVISOR_RECOVERIES_FILE) ?? [];
}

/** Write recoveries atomically to daemon's filesystem state. */
function writeDaemonRecoveries(recoveries: RecoveryAction[]): void {
  fs.mkdirSync(SUPERVISOR_DIR, { recursive: true });
  writeFileAtomicSync(SUPERVISOR_RECOVERIES_FILE, JSON.stringify(recoveries, null, 2));
}

function isSupervisorDaemonRunning(): { running: boolean; pid: number | null } {
  try {
    if (!fs.existsSync(SUPERVISOR_PID_FILE)) return { running: false, pid: null };
    const pid = Number(fs.readFileSync(SUPERVISOR_PID_FILE, "utf-8").trim());
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}

originalTool("supervisor_start", "Start the supervisor as a background daemon. Survives Claude Code restarts. Monitors sessions, detects stalls, executes recovery actions via native bridge.", {
  pollMs: z.number().optional().describe("Poll interval in ms (default: 5000)"),
  stallMs: z.number().optional().describe("Stall threshold in ms (default: 300000 = 5 min)"),
  dryRun: z.boolean().optional().describe("Log recovery actions without executing them (default: false)"),
}, async ({ pollMs, stallMs, dryRun }) => {
  const { running, pid } = isSupervisorDaemonRunning();
  if (running) {
    return { content: [{ type: "text" as const, text: `Supervisor daemon already running (pid=${pid}). Use supervisor_stop first.` }] };
  }

  // Try compiled JS first (reliable), fall back to tsx (dev mode)
  // When running from dist/, the script is a sibling: dist/scripts/supervisor-daemon.js
  // When running from source via tsx, it's at dist/scripts/supervisor-daemon.js relative to project root
  const compiledPath = fs.existsSync(path.resolve(__dirname, "scripts", "supervisor-daemon.js"))
    ? path.resolve(__dirname, "scripts", "supervisor-daemon.js")               // running from dist/
    : path.resolve(__dirname, "dist", "scripts", "supervisor-daemon.js");      // running from source

  let child;
  let usedCompiled = false;
  if (fs.existsSync(compiledPath)) {
    const nodeArgs = [compiledPath];
    if (pollMs) nodeArgs.push("--poll", String(pollMs));
    if (stallMs) nodeArgs.push("--stall", String(stallMs));
    if (dryRun) nodeArgs.push("--dry-run");

    child = spawn("node", nodeArgs, {
      detached: true,
      stdio: "ignore",
      cwd: __dirname,
    });
    usedCompiled = true;
  } else {
    const daemonArgs = ["tsx", SUPERVISOR_DAEMON_SCRIPT];
    if (pollMs) daemonArgs.push("--poll", String(pollMs));
    if (stallMs) daemonArgs.push("--stall", String(stallMs));
    if (dryRun) daemonArgs.push("--dry-run");

    child = spawn("npx", daemonArgs, {
      detached: true,
      stdio: "ignore",
      cwd: __dirname,
    });
  }
  child.unref();

  const daemonPid = child.pid;

  // Wait briefly, then verify the daemon actually started by checking PID file
  await new Promise((r) => setTimeout(r, 2000));

  const verify = isSupervisorDaemonRunning();
  if (!verify.running) {
    return { content: [{ type: "text" as const, text: `Supervisor daemon failed to start (spawned pid=${daemonPid}, mode=${usedCompiled ? "compiled" : "tsx"}).\nCheck log: ${SUPERVISOR_LOG_FILE}\n\nIf running in a restricted environment, ensure 'npx tsx' or 'node' can spawn processes.\nYou can also run the daemon manually: npx tsx scripts/supervisor-daemon.ts` }] };
  }

  const dryNote = dryRun ? "\n⚠️  DRY RUN mode — recovery actions are logged but not executed." : "";
  return { content: [{ type: "text" as const, text: `Supervisor daemon started (pid=${verify.pid}, mode=${usedCompiled ? "compiled" : "tsx"}).\nPoll: ${pollMs ?? 5000}ms | Stall threshold: ${stallMs ?? 300000}ms\nLog: ${SUPERVISOR_LOG_FILE}${dryNote}\n\nThe daemon runs independently — survives Claude Code restarts.\nUse supervisor_status to check health.` }] };
});

originalTool("supervisor_stop", "Stop the supervisor background daemon.", {}, async () => {
  const { running, pid } = isSupervisorDaemonRunning();
  if (!running) {
    // Also stop in-process supervisor if it was started
    await supervisor.stop();
    return { content: [{ type: "text" as const, text: "No supervisor daemon running." }] };
  }
  try {
    process.kill(pid!, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    return { content: [{ type: "text" as const, text: `Supervisor daemon stopped (pid=${pid}).` }] };
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Failed to stop: ${err.message}` }] };
  }
});

originalTool("supervisor_pause", "Pause all automation — keeps leases but signals clients to stop acting.", {
  reason: z.string().optional().describe("Why automation is being paused"),
}, async ({ reason }) => {
  // Read active sessions from shared filesystem lock dir (source of truth)
  const sessions = leaseManager.getActive();

  // Add escalation recovery to daemon's filesystem state
  const recoveries = readDaemonRecoveries();
  for (const s of sessions) {
    recoveries.push({
      id: "recv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      sessionId: s.sessionId,
      type: "escalate",
      instruction: reason ?? "Automation paused by operator.",
      status: "pending",
      createdAt: new Date().toISOString(),
      attemptedAt: null,
      result: null,
    });
  }
  writeDaemonRecoveries(recoveries);

  return { content: [{ type: "text" as const, text: `Paused. ${sessions.length} session(s) notified. Leases held — call supervisor_resume to continue.` }] };
});

originalTool("supervisor_resume", "Resume automation after a pause.", {}, async () => {
  // Clear pending escalation recoveries from daemon's filesystem state
  const recoveries = readDaemonRecoveries();
  let cleared = 0;
  for (const r of recoveries) {
    if (r.type === "escalate" && r.status === "pending") {
      r.status = "succeeded";
      r.result = "Resumed by operator.";
      cleared++;
    }
  }
  writeDaemonRecoveries(recoveries);
  return { content: [{ type: "text" as const, text: `Resumed. ${cleared} pause escalation(s) cleared. Clients can continue.` }] };
});

originalTool("recovery_queue_add", "Add a manual recovery instruction for a stalled session.", {
  sessionId: z.string().describe("Session ID that needs recovery"),
  type: z.enum(["nudge", "restart", "escalate", "custom"]).describe("Recovery type"),
  instruction: z.string().describe("What to do (e.g., 'Click the login button', 'Restart Chrome')"),
}, async ({ sessionId, type, instruction }) => {
  // Validate that the session ID looks reasonable (basic format check)
  // Accept both lease-style (lease_*) and generic session IDs
  if (!sessionId || sessionId.length < 3 || sessionId.length > 200) {
    return { content: [{ type: "text" as const, text: `Error: Invalid session ID "${sessionId}". Must be 3-200 characters.` }] };
  }

  // Validate session is active — reject orphaned recovery instructions
  const activeSessions = leaseManager.getActive();
  const isActive = activeSessions.some(s => s.sessionId === sessionId);
  if (!isActive) {
    return { content: [{ type: "text" as const, text: `Session "${sessionId}" is not active. Use supervisor_status to find active sessions.` }] };
  }
  const warning = "";

  const recovery: RecoveryAction = {
    id: "recv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    sessionId,
    type,
    instruction,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptedAt: null,
    result: null,
  };

  // Write to daemon's filesystem state so the daemon picks it up
  const recoveries = readDaemonRecoveries();

  // Prune old completed/failed entries (keep last 50, drop entries older than 24h)
  const MAX_QUEUE_SIZE = 50;
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - MAX_AGE_MS;
  const pruned = recoveries.filter((r) => {
    if (r.status === "pending") return true; // always keep pending
    const age = new Date(r.createdAt).getTime();
    return age > cutoff;
  }).slice(-MAX_QUEUE_SIZE);

  pruned.push(recovery);
  writeDaemonRecoveries(pruned);

  return { content: [{ type: "text" as const, text: `Recovery queued: ${recovery.id} (type=${type})${warning}` }] };
});

originalTool("recovery_queue_list", "List recovery actions, optionally filtered by status.", {
  status: z.enum(["pending", "attempted", "succeeded", "failed"]).optional().describe("Filter by status"),
}, async ({ status }) => {
  // Read from daemon's filesystem state
  let recoveries = readDaemonRecoveries();
  if (status) {
    recoveries = recoveries.filter((r) => r.status === status);
  }
  if (recoveries.length === 0) {
    return { content: [{ type: "text" as const, text: `No ${status ?? ""} recovery actions.` }] };
  }
  const text = recoveries.map((r, i) =>
    `${i + 1}. [${r.status.toUpperCase()}] ${r.type}: "${r.instruction.slice(0, 80)}"\n   Session: ${r.sessionId} | Created: ${r.createdAt}${r.result ? `\n   Result: ${r.result}` : ""}`
  ).join("\n\n");
  return { content: [{ type: "text" as const, text }] };
});

// ── Service install / auto-start (launchd on macOS) ──

const LAUNCHD_LABEL = "com.screenhand.supervisor";
const LAUNCHD_PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

function findNodeBinary(): string {
  // Prefer the node that's running us — guaranteed to exist
  return process.execPath;
}

function findDaemonScript(): string | null {
  // compiled JS in dist/
  const fromDist = path.resolve(__dirname, "scripts", "supervisor-daemon.js");
  if (fs.existsSync(fromDist)) return fromDist;
  // running from source root
  const fromRoot = path.resolve(__dirname, "dist", "scripts", "supervisor-daemon.js");
  if (fs.existsSync(fromRoot)) return fromRoot;
  return null;
}

function generatePlist(nodeBin: string, daemonScript: string, opts: { pollMs?: number | undefined; stallMs?: number | undefined }): string {
  const args = [nodeBin, daemonScript];
  if (opts.pollMs) args.push("--poll", String(opts.pollMs));
  if (opts.stallMs) args.push("--stall", String(opts.stallMs));

  const programArgs = args.map((a) => `      <string>${a}</string>`).join("\n");

  // Inherit PATH so native bridge binary and node can be found
  const envPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>

    <key>WorkingDirectory</key>
    <string>${path.dirname(daemonScript).replace(/\/dist\/scripts$/, "").replace(/\/dist$/, "")}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${SUPERVISOR_DIR}/launchd-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${SUPERVISOR_DIR}/launchd-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${envPath}</string>
    </dict>
</dict>
</plist>
`;
}

function isServiceInstalled(): boolean {
  return fs.existsSync(LAUNCHD_PLIST_PATH);
}

originalTool("supervisor_install", "Install the supervisor as a system service (launchd on macOS). Starts automatically on login and restarts on crash.", {
  pollMs: z.number().optional().describe("Poll interval in ms (default: 5000)"),
  stallMs: z.number().optional().describe("Stall threshold in ms (default: 300000 = 5 min)"),
}, async ({ pollMs, stallMs }) => {
  if (process.platform !== "darwin") {
    return { content: [{ type: "text" as const, text: "Service install is currently macOS-only (launchd). Windows Task Scheduler support coming soon." }] };
  }

  const daemonScript = findDaemonScript();
  if (!daemonScript) {
    return { content: [{ type: "text" as const, text: "Cannot find compiled daemon script. Run `npx tsc` first to build dist/scripts/supervisor-daemon.js." }] };
  }

  const nodeBin = findNodeBinary();

  // Stop existing daemon if running (will be managed by launchd now)
  const { running, pid } = isSupervisorDaemonRunning();
  if (running && pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Unload existing plist if present
  if (isServiceInstalled()) {
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("launchctl", ["unload", LAUNCHD_PLIST_PATH], { stdio: "ignore" });
    } catch { /* ignore */ }
  }

  // Write plist
  const plist = generatePlist(nodeBin, daemonScript, { pollMs, stallMs });
  fs.mkdirSync(path.dirname(LAUNCHD_PLIST_PATH), { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST_PATH, plist);

  // Load the service
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("launchctl", ["load", LAUNCHD_PLIST_PATH]);
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Plist written to ${LAUNCHD_PLIST_PATH} but launchctl load failed: ${err.message}\nTry manually: launchctl load "${LAUNCHD_PLIST_PATH}"` }] };
  }

  // Verify it started
  await new Promise((r) => setTimeout(r, 2000));
  const verify = isSupervisorDaemonRunning();

  const lines = [
    `Service installed and loaded.`,
    `  Plist: ${LAUNCHD_PLIST_PATH}`,
    `  Node: ${nodeBin}`,
    `  Script: ${daemonScript}`,
    `  Poll: ${pollMs ?? 5000}ms | Stall: ${stallMs ?? 300000}ms`,
    `  Status: ${verify.running ? `running (pid=${verify.pid})` : "starting..."}`,
    ``,
    `The supervisor will:`,
    `  - Start automatically on login`,
    `  - Restart automatically if it crashes`,
    `  - Survive reboots`,
    ``,
    `Use supervisor_uninstall to remove.`,
  ];

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("supervisor_uninstall", "Uninstall the supervisor system service. Stops the daemon and removes the launchd plist.", {}, async () => {
  if (process.platform !== "darwin") {
    return { content: [{ type: "text" as const, text: "Service uninstall is currently macOS-only." }] };
  }

  if (!isServiceInstalled()) {
    return { content: [{ type: "text" as const, text: "No service installed (no plist at " + LAUNCHD_PLIST_PATH + ")." }] };
  }

  // Unload the service (stops the daemon)
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("launchctl", ["unload", LAUNCHD_PLIST_PATH]);
  } catch { /* ignore — may already be unloaded */ }

  // Remove plist
  try {
    fs.unlinkSync(LAUNCHD_PLIST_PATH);
  } catch { /* ignore */ }

  // Clean up PID file
  try {
    fs.unlinkSync(SUPERVISOR_PID_FILE);
  } catch { /* ignore */ }

  return { content: [{ type: "text" as const, text: `Service uninstalled.\n  Removed: ${LAUNCHD_PLIST_PATH}\n  Daemon stopped.\n\nState files in ~/.screenhand/ are preserved (logs, leases, recoveries).` }] };
});

// ═══════════════════════════════════════════════
// EXECUTION CONTRACT — canonical fallback chain
// ═══════════════════════════════════════════════

import {
  EXECUTION_METHODS,
  METHOD_CAPABILITIES,
  DEFAULT_RETRY_POLICY,
  planExecution,
  executeWithFallback,
} from "./src/runtime/execution-contract.js";
import type { ExecutionMethod, ActionResult, RetryPolicy } from "./src/runtime/execution-contract.js";

server.tool("execution_plan", "Show the execution plan for an action type. Returns the ordered fallback chain based on available infrastructure.", {
  action: z.enum(["click", "type", "read", "locate", "select", "scroll"]).describe("Action type"),
}, async ({ action }) => {
  const plan = planExecution(action, { hasBridge: true, hasCDP: cdpPort !== null }, getSensorRanking());
  const lines = plan.map((method, i) => {
    const cap = METHOD_CAPABILITIES[method];
    return `${i + 1}. ${method} (~${cap.avgLatencyMs}ms)${i === 0 ? " ← primary" : ""}`;
  });
  const policy = getAdaptedRetryPolicy();
  lines.push("", `Retry policy: ${policy.maxRetriesPerMethod}/method, ${policy.maxTotalRetries} total, escalate after ${policy.escalateAfter}, delay ${policy.delayBetweenRetriesMs}ms`);
  const appBundleId = worldModel.getState().focusedApp?.bundleId;
  if (appBundleId) {
    const budget = learningEngine.getAdaptiveBudget(appBundleId);
    lines.push(`Adaptive budgets: locate=${budget.locateMs}ms, act=${budget.actMs}ms, verify=${budget.verifyMs}ms`);
  }
  // Include app-specific hints from reference files and context tracker
  const hints = contextTracker.getHints(action, {});
  if (hints.length > 0) {
    lines.push("", "App-specific context:", ...hints.slice(0, 5));
  }
  return { content: [{ type: "text" as const, text: `Execution plan for "${action}":\n${lines.join("\n")}` }] };
});

// ── Shared helpers for resilient action tools ──

async function resolvePid(bundleId?: string | undefined): Promise<number> {
  let pid = 0;
  if (bundleId) {
    try {
      const appInfo = await bridge.call<{ pid: number }>("app.focus", { bundleId });
      pid = appInfo.pid ?? 0;
    } catch { /* fall through */ }
  }
  if (pid === 0) {
    try {
      const front = await bridge.call<{ pid: number }>("app.frontmost", {});
      pid = front.pid;
    } catch { /* caller will handle pid=0 */ }
  }
  return pid;
}

function infra() {
  return { hasBridge: true, hasCDP: cdpPort !== null };
}

/**
 * Get sensor rankings for the current app from the learning engine.
 * Used by planExecution() to reorder fallback methods based on learned success rates.
 * Returns undefined if no bundleId is known (falls back to canonical order).
 */
function getSensorRanking(overrideBundleId?: string): Array<{ sourceType: string; score: number; avgLatencyMs: number }> | undefined {
  // Use override bundleId when provided (from tool params), else worldModel, else lastKnown
  const bundleId = overrideBundleId ?? worldModel.getState().focusedApp?.bundleId ?? lastKnownBundleId;
  if (!bundleId) return undefined;
  const ranked = learningEngine.rankSensors(bundleId);
  return ranked.length > 0 ? ranked : undefined;
}

/**
 * Get a retry policy adapted by the learning engine's adaptive budgets
 * AND the AppMap's timing profiles (L7→L1).
 *
 * Priority: AppMap timing > Learning budget > Default
 * AppMap stores per-tool/per-action avg durations from real executions.
 * Learning budget stores per-app adaptive budgets from outcome stats.
 */
function getAdaptedRetryPolicy(toolName?: string, overrideBundleId?: string): RetryPolicy {
  let typicalMs: number | null = null;

  // L7→L1: Check AppMap timing profiles for the action type.
  // Timing keys are stored as "click::Submit", "click_text::Login", etc.
  // Fallback tools pass "click_with_fallback" — extract the action prefix to match.
  const bundleId = overrideBundleId ?? worldModel.getState().focusedApp?.bundleId ?? lastKnownBundleId;
  if (bundleId && toolName) {
    const actionPrefix = toolName.replace(/_with_fallback$/, "");
    // Get all timing profiles for this app, then filter by action prefix
    const allTimings = appMap.getTimingProfile(bundleId);
    const matchingTimings = allTimings.filter((t) => t.key.startsWith(actionPrefix + "::") || t.key === actionPrefix);
    if (matchingTimings.length > 0) {
      // Use element_response type if available, compute median avgMs across all matching entries
      const responseTimes = matchingTimings
        .filter((t) => t.type === "element_response")
        .map((t) => t.avgMs);
      if (responseTimes.length > 0) {
        responseTimes.sort((a, b) => a - b);
        const mid = Math.floor(responseTimes.length / 2);
        typicalMs = responseTimes.length % 2 === 1
          ? responseTimes[mid]!
          : (responseTimes[mid - 1]! + responseTimes[mid]!) / 2;
      } else {
        typicalMs = matchingTimings[0]!.avgMs;
      }
    }
  }

  // Fall back to L5 adaptive budget
  if (typicalMs == null && currentAdaptiveBudget) {
    typicalMs = Math.max(currentAdaptiveBudget.locateMs, currentAdaptiveBudget.actMs);
  }

  if (typicalMs == null) return DEFAULT_RETRY_POLICY;

  // Retry delay = max(100ms, typical * 1.5), capped at the default
  const adaptedDelay = Math.min(
    DEFAULT_RETRY_POLICY.delayBetweenRetriesMs,
    Math.max(100, Math.ceil(typicalMs * 1.5)),
  );
  if (adaptedDelay === DEFAULT_RETRY_POLICY.delayBetweenRetriesMs) return DEFAULT_RETRY_POLICY;
  return { ...DEFAULT_RETRY_POLICY, delayBetweenRetriesMs: adaptedDelay };
}

function formatResult(action: string, target: string, result: ActionResult, preCheckWarnings?: string[]): { content: Array<{ type: "text"; text: string }> } {
  const prefix = preCheckWarnings && preCheckWarnings.length > 0
    ? preCheckWarnings.join("\n") + "\n"
    : "";
  if (result.ok) {
    const fallbackNote = result.fallbackFrom ? ` (fell back from ${result.fallbackFrom})` : "";
    return { content: [{ type: "text" as const, text: `${prefix}${action} "${result.target ?? target}" via ${result.method}${fallbackNote} in ${result.durationMs}ms` }] };
  }
  return { content: [{ type: "text" as const, text: `${prefix}Failed to ${action} "${target}" — all methods exhausted. Last error: ${result.error}` }] };
}

/**
 * L3→L1: Pre-execution worldModel check.
 * Verifies the target app is focused and not blocked by dialogs.
 * Auto-focuses the app if it's in the background. Returns warnings
 * that should be prepended to the result.
 */
async function preExecutionCheck(bundleId?: string): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const state = worldModel.getState();
    const targetBundleId = bundleId ?? lastKnownBundleId ?? state.focusedApp?.bundleId;

    if (!targetBundleId) return warnings;

    // Check if target app is focused — use correct bridge method "app.focus"
    if (state.focusedApp && state.focusedApp.bundleId !== targetBundleId) {
      warnings.push(`[L3→L1] Target app ${targetBundleId} is not focused (current: ${state.focusedApp.bundleId}). Auto-focusing...`);
      try {
        await bridge.call("app.focus", { bundleId: targetBundleId });
      } catch {
        warnings.push(`[L3→L1] Auto-focus failed — proceeding anyway`);
      }
    }

    // Re-fetch state after auto-focus to get current focused app
    const postFocusState = worldModel.getState();

    // Check for blocking dialogs — scoped to target app only.
    // Observer-sourced dialogs have windowId=0 (no real window ID),
    // so fall back to checking if the focused app matches.
    const relevantDialogs = postFocusState.activeDialogs.filter((d) => {
      if (d.windowId === 0) {
        return postFocusState.focusedApp?.bundleId === targetBundleId;
      }
      const win = postFocusState.windows.get(d.windowId);
      return win?.bundleId === targetBundleId;
    });
    if (relevantDialogs.length > 0) {
      const dialogTitles = relevantDialogs
        .map((d) => d.title || d.type)
        .join(", ");
      warnings.push(`[L3→L1] Active dialog(s) detected: ${dialogTitles} — may block interaction`);
    }

    // Check if target window is off-screen
    for (const [, win] of state.windows) {
      if (win.bundleId === targetBundleId && !win.isOnScreen) {
        warnings.push(`[L3→L1] Window "${win.title.value}" is off-screen or minimized`);
      }
    }

    // Check if world state is stale (>10s since last update)
    const staleThresholdMs = 10_000;
    const lastUpdate = new Date(state.updatedAt).getTime();
    if (!Number.isNaN(lastUpdate) && Date.now() - lastUpdate > staleThresholdMs && state.confidence < 0.5) {
      warnings.push(`[L3→L1] World state is stale (${Math.round((Date.now() - lastUpdate) / 1000)}s old, confidence ${state.confidence.toFixed(2)}) — screen may have changed`);
    }
  } catch {
    // Pre-check is best-effort advisory — never crash the tool call
  }

  return warnings;
}

/**
 * L7→L1: Try to resolve an element's position from the AppMap.
 * Returns known screen coordinates if the map has a position for this label
 * AND we can get the current window bounds. Returns null otherwise.
 */
function resolveMapPosition(target: string, bundleId?: string): { x: number; y: number } | null {
  const bid = bundleId ?? worldModel.getState().focusedApp?.bundleId ?? lastKnownBundleId;
  if (!bid) return null;

  // Get window bounds from worldModel for coordinate conversion
  const state = worldModel.getState();
  const focusedWinId = state.focusedWindowId;
  if (focusedWinId == null) return null;
  const win = state.windows.get(focusedWinId);
  if (!win || win.bundleId !== bid) return null;

  const bounds = win.bounds.value;
  // Guard: reject stale bounds (>5s old) to prevent clicking at wrong position after window move
  const boundsAge = Date.now() - new Date(win.bounds.updatedAt).getTime();
  if (boundsAge > 5000 || boundsAge < 0) return null; // stale or future timestamp
  // Guard: reject uninitialized/zero-size bounds to prevent clicking at (0,0)
  if (bounds.width < 50 || bounds.height < 50) return null;

  return appMap.resolvePosition(bid, target, bounds);
}

// ── click_with_fallback ──

server.tool("click_with_fallback", "Click a target by text using the canonical fallback chain: AX → CDP → OCR. Automatically retries and falls through methods.", {
  target: z.string().describe("Text, title, or identifier of the element to click"),
  bundleId: z.string().optional().describe("App bundle ID (for AX path)"),
}, async ({ target, bundleId }) => {
  await ensureBridge();
  const preCheckWarnings = await preExecutionCheck(bundleId);

  // L7→L1: If AppMap knows this element's position, try coordinates first.
  // WARNING: Coordinate clicks are unverified — if the window moved or a modal
  // appeared, the click may hit the wrong target. On failure, falls through to
  // the standard AX/CDP/OCR chain which verifies element identity.
  // Skip map-guided shortcut if precheck detected blocking conditions (dialogs, off-screen)
  const hasBlockingCondition = preCheckWarnings.some((w) => w.includes("dialog") || w.includes("off-screen") || w.includes("not frontmost"));
  const mapPos = !hasBlockingCondition ? resolveMapPosition(target, bundleId) : null;
  if (mapPos) {
    try {
      const start = Date.now();
      await bridge.call("cg.mouseClick", { x: mapPos.x, y: mapPos.y });
      preCheckWarnings.push(`[L7→L1] Used map position (${mapPos.x}, ${mapPos.y}) for "${target}" — UNVERIFIED coordinate click`);
      return formatResult("Clicked", target, {
        ok: true, method: "coordinates", durationMs: Date.now() - start,
        fallbackFrom: null, retries: 0, error: null, target: `${target} at (${mapPos.x},${mapPos.y}) [map-guided, unverified]`,
      }, preCheckWarnings);
    } catch {
      preCheckWarnings.push(`[L7→L1] Map position click failed — falling back to standard chain`);
    }
  }

  const plan = planExecution("click", infra(), getSensorRanking())
    .filter((m) => m !== "coordinates");

  const targetPid = await resolvePid(bundleId);

  // L2→L1: Resolve known selector from references for direct injection
  const knownSelector = contextTracker.getSelector(target);
  if (knownSelector) {
    preCheckWarnings.push(`[L2→L1] Injecting known selector: ${knownSelector}`);
  }

  const result = await executeWithFallback("click", plan, getAdaptedRetryPolicy("click_with_fallback"), async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          // L2-65 fix: Try exact match first to avoid wrong-window match on minimized windows
          let found: { elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } };
          try {
            found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
              pid: targetPid,
              title: target,
              exact: true,
            });
          } catch {
            found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
              pid: targetPid,
              title: target,
              exact: false,
            });
          }
          await bridge.call("ax.performAction", {
            pid: targetPid,
            elementPath: found.elementPath,
            action: "AXPress",
          });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            // L2→L1: Try known selector first (wrapped in try/catch to handle
            // invalid selectors gracefully), then fall back to text search.
            const textSearchExpr = `Array.from(document.querySelectorAll('*')).find(e =>
                  e.textContent?.trim() === ${JSON.stringify(target)} ||
                  e.getAttribute('aria-label') === ${JSON.stringify(target)})`;
            const selectorExpr = knownSelector
              ? `(() => {
                try {
                  const el = document.querySelector(${JSON.stringify(knownSelector)});
                  if (el) { el.click(); return 'clicked'; }
                } catch(e) { /* invalid selector — fall through to text search */ }
                const fallback = ${textSearchExpr};
                if (fallback) { fallback.click(); return 'clicked'; }
                return null;
              })()`
              : `(() => {
                const el = ${textSearchExpr};
                if (el) { el.click(); return 'clicked'; }
                return null;
              })()`;
            const evalResult = await Runtime.evaluate({
              expression: selectorExpr,
              returnByValue: true,
            });
            if (evalResult.result?.value === "clicked") {
              return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
            }
            throw new Error("Element not found via CDP");
          } finally {
            await client.close();
          }
        }
        case "ocr": {
          // Capture screen, find text via vision.findText, click at center of bounds
          const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
          const matches = await bridge.call<Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>>("vision.findText", {
            imagePath: shot.path,
            searchText: target,
          });
          const match = Array.isArray(matches) ? matches[0] : null;
          if (match && match.bounds) {
            const x = match.bounds.x + match.bounds.width / 2;
            const y = match.bounds.y + match.bounds.height / 2;
            await bridge.call("cg.mouseClick", { x, y });
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} at (${Math.round(x)},${Math.round(y)})` };
          }
          throw new Error("Target not found via OCR");
        }
      }
      throw new Error(`Unknown method: ${method}`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target };
    }
  });

  return formatResult("Clicked", target, result, preCheckWarnings);
});

// ── type_with_fallback ──

server.tool("type_with_fallback", "Type text into a target field using the canonical fallback chain: AX → CDP → coordinates. Finds the field by label/placeholder, focuses it, then types.", {
  target: z.string().describe("Label, placeholder, or title of the field to type into"),
  text: z.string().describe("Text to type"),
  bundleId: z.string().optional().describe("App bundle ID"),
  clearFirst: z.boolean().optional().describe("Select-all and clear the field before typing (default: false)"),
}, async ({ target, text, bundleId, clearFirst }) => {
  await ensureBridge();
  const preCheckWarnings = await preExecutionCheck(bundleId);

  const plan = planExecution("type", infra(), getSensorRanking());
  const targetPid = await resolvePid(bundleId);

  // L2→L1: Resolve known selector for direct injection
  const knownSelector = contextTracker.getSelector(target);

  const result = await executeWithFallback("type", plan, getAdaptedRetryPolicy("type_with_fallback"), async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          // L2-65 fix: Try exact match first to avoid wrong-window match on minimized windows
          let found: { elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } };
          try {
            found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
              pid: targetPid,
              title: target,
              exact: true,
            });
          } catch {
            found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
              pid: targetPid,
              title: target,
              exact: false,
            });
          }
          // L2-62+L2-68 fix: If matched element is a window (short elementPath), find
          // the child AXTextArea/AXTextField SCOPED to the target window.
          const isLikelyWindow = found.elementPath.length <= 1;
          if (isLikelyWindow) {
            // Try window-scoped search first via getElementTree
            let scopedFound = false;
            try {
              const wins = await bridge.call<Array<{ windowId: number; title?: string }>>("app.windows");
              const matchWin = wins.find((w) => w.title === target) ?? wins.find((w) => w.title?.includes(target));
              if (matchWin?.windowId) {
                const windowTree = await bridge.call<any>("ax.getElementTree", {
                  pid: targetPid,
                  windowId: matchWin.windowId,
                  maxDepth: 8,
                });
                const findInTree = (node: any, path: number[]): number[] | null => {
                  if (node?.role && (node.role === "AXTextArea" || node.role === "AXTextField")) {
                    return path;
                  }
                  if (node?.children && Array.isArray(node.children)) {
                    for (let i = 0; i < node.children.length; i++) {
                      const r = findInTree(node.children[i], [...path, i]);
                      if (r) return r;
                    }
                  }
                  return null;
                };
                const textPath = findInTree(windowTree, found.elementPath);
                if (textPath) {
                  found = found.bounds
                    ? { elementPath: textPath, bounds: found.bounds }
                    : { elementPath: textPath };
                  scopedFound = true;
                }
              }
            } catch { /* fall through to unscoped search */ }

            // Fallback: unscoped search (original L2-62 behavior)
            if (!scopedFound) {
              for (const role of ["AXTextArea", "AXTextField"]) {
                try {
                  const textEl = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
                    pid: targetPid,
                    role,
                    maxDepth: 10,
                  });
                  found = textEl;
                  break;
                } catch { /* try next role */ }
              }
            }
          }
          if (clearFirst) {
            await bridge.call("ax.setElementValue", { pid: targetPid, elementPath: found.elementPath, value: "" });
          }
          await bridge.call("ax.setElementValue", { pid: targetPid, elementPath: found.elementPath, value: text });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime, DOM, Input } = client;
            // L2→L1: Try known selector first (with try/catch for invalid selectors),
            // then fall back to attribute search.
            const fieldSearchExpr = `Array.from(document.querySelectorAll('input, textarea, [contenteditable]')).find(e =>
                  e.getAttribute('placeholder') === ${JSON.stringify(target)} ||
                  e.getAttribute('aria-label') === ${JSON.stringify(target)} ||
                  e.getAttribute('name') === ${JSON.stringify(target)} ||
                  (e.labels && Array.from(e.labels).some(l => l.textContent?.trim() === ${JSON.stringify(target)})))`;
            const fieldExpr = knownSelector
              ? `(() => {
                try {
                  const el = document.querySelector(${JSON.stringify(knownSelector)});
                  if (el) { el.focus(); return true; }
                } catch(e) { /* invalid selector — fall through */ }
                const fallback = ${fieldSearchExpr};
                if (fallback) { fallback.focus(); return true; }
                return false;
              })()`
              : `(() => {
                const el = ${fieldSearchExpr};
                if (el) { el.focus(); return true; }
                return false;
              })()`;
            const evalResult = await Runtime.evaluate({
              expression: fieldExpr,
              returnByValue: true,
            });
            if (!evalResult.result?.value) throw new Error("Field not found via CDP");
            if (clearFirst) {
              const selectAllMod = process.platform === "darwin" ? 4 : 2; // Cmd on macOS, Ctrl on Windows/Linux
              await Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", modifiers: selectAllMod });
              await Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", modifiers: selectAllMod });
            }
            for (const char of text) {
              await Input.dispatchKeyEvent({ type: "keyDown", key: char, text: char });
              await Input.dispatchKeyEvent({ type: "keyUp", key: char });
            }
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target };
          } finally {
            await client.close();
          }
        }
      }
      throw new Error(`Method ${method} does not support type`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target };
    }
  });

  return formatResult("Typed into", target, result, preCheckWarnings);
});

// ── read_with_fallback ──

server.tool("read_with_fallback", "Read text content from the screen or a specific element using the canonical fallback chain: AX → CDP → OCR. Returns the text found.", {
  target: z.string().optional().describe("Element label/title to read from (omit for full-screen OCR)"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ target, bundleId }) => {
  await ensureBridge();
  const preCheckWarnings = await preExecutionCheck(bundleId);

  const plan = planExecution("read", infra(), getSensorRanking());
  const targetPid = await resolvePid(bundleId);

  // L2→L1: Resolve known selector from references for direct injection
  const knownSelector = target ? contextTracker.getSelector(target) : null;
  if (knownSelector) {
    preCheckWarnings.push(`[L2→L1] Injecting known selector: ${knownSelector}`);
  }

  const result = await executeWithFallback("read", plan, getAdaptedRetryPolicy("read_with_fallback"), async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          if (target) {
            // L2-65 fix: Try exact match first to avoid reading from the wrong
            // window when multiple windows share a title prefix (e.g. "Untitled 39" vs "Untitled 40").
            // Minimized windows may be skipped by the bridge search, so an inexact match
            // can silently return a sibling window's content with no warning.
            let found: { elementPath: number[]; title?: string };
            try {
              found = await bridge.call<{ elementPath: number[]; title?: string }>("ax.findElement", {
                pid: targetPid,
                title: target,
                exact: true,
              });
            } catch {
              // Exact match failed — fall back to fuzzy match
              found = await bridge.call<{ elementPath: number[]; title?: string }>("ax.findElement", {
                pid: targetPid,
                title: target,
                exact: false,
              });
            }
            const val = await bridge.call<{ value: string }>("ax.getElementValue", {
              pid: targetPid,
              elementPath: found.elementPath,
            });
            // L2-59+L2-61+L2-68 fix: If matched element has no value (e.g. AXWindow), find a
            // text-bearing child element SCOPED to the target window.
            // L2-68: Previously used unscoped ax.findElement(role) which returned AXTextArea from
            // ANY window. Now uses ax.getElementTree(windowId) to scope the search.
            if (!val.value) {
              // Try to find the matching CG windowId by title
              let windowTree: { children?: Array<{ role?: string; value?: string; children?: any[] }> } | null = null;
              try {
                const wins = await bridge.call<Array<{ windowId: number; title?: string }>>("app.windows");
                const matchWin = wins.find((w) => w.title === target) ?? wins.find((w) => w.title?.includes(target));
                if (matchWin?.windowId) {
                  windowTree = await bridge.call<any>("ax.getElementTree", {
                    pid: targetPid,
                    windowId: matchWin.windowId,
                    maxDepth: 8,
                  });
                }
              } catch { /* fall through to unscoped search */ }

              // Walk the window tree to find first text-bearing element
              const textRoles = new Set(["AXTextArea", "AXTextField", "AXWebArea"]);
              const findTextInTree = (node: any, path: number[]): { value: string; path: number[] } | null => {
                if (node?.role && textRoles.has(node.role) && node.value) {
                  return { value: node.value, path };
                }
                if (node?.children && Array.isArray(node.children)) {
                  for (let i = 0; i < node.children.length; i++) {
                    const result = findTextInTree(node.children[i], [...path, i]);
                    if (result) return result;
                  }
                }
                return null;
              };

              if (windowTree) {
                const textNode = findTextInTree(windowTree, found.elementPath);
                if (textNode?.value) {
                  return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: textNode.value };
                }
              }

              // Fallback: unscoped search (original L2-59 behavior) if window-scoped search fails
              const fallbackRoles = ["AXTextArea", "AXTextField", "AXWebArea"];
              for (const role of fallbackRoles) {
                try {
                  const textEl = await bridge.call<{ elementPath: number[] }>("ax.findElement", {
                    pid: targetPid,
                    role,
                    maxDepth: 10,
                  });
                  const textVal = await bridge.call<{ value: string }>("ax.getElementValue", {
                    pid: targetPid,
                    elementPath: textEl.elementPath,
                  });
                  if (textVal.value) {
                    return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: textVal.value };
                  }
                } catch { /* try next role */ }
              }
            }
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: val.value ?? "" };
          }
          // No specific target — get the full element tree text
          const tree = await bridge.call<{ description: string }>("ax.getElementTree", {
            pid: targetPid,
            maxDepth: 4,
          });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: tree.description ?? JSON.stringify(tree).slice(0, 2000) };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            if (target) {
              // L2→L1: Try known selector first, then fall back to text search
              const textSearch = `Array.from(document.querySelectorAll('*')).find(e =>
                    e.getAttribute('aria-label') === ${JSON.stringify(target)} ||
                    e.textContent?.trim() === ${JSON.stringify(target)})`;
              const expr = knownSelector
                ? `(() => {
                    try {
                      const el = document.querySelector(${JSON.stringify(knownSelector)});
                      if (el) return (el.value ?? el.textContent ?? '').trim();
                    } catch(e) {}
                    const fallback = ${textSearch};
                    return fallback ? (fallback.value ?? fallback.textContent ?? '').trim() : null;
                  })()`
                : `(() => {
                    const el = ${textSearch};
                    return el ? (el.value ?? el.textContent ?? '').trim() : null;
                  })()`;
              const evalResult = await Runtime.evaluate({
                expression: expr,
                returnByValue: true,
              });
              if (evalResult.result?.value == null) throw new Error("Element not found via CDP");
              return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: String(evalResult.result.value) };
            }
            // Full page text
            const evalResult = await Runtime.evaluate({
              expression: "document.body?.innerText?.slice(0, 4000) ?? ''",
              returnByValue: true,
            });
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: String(evalResult.result?.value ?? "") };
          } finally {
            await client.close();
          }
        }
        case "ocr": {
          const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
          if (target) {
            const matches = await bridge.call<Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>>("vision.findText", {
              imagePath: shot.path,
              searchText: target,
            });
            const match = Array.isArray(matches) ? matches[0] : null;
            if (!match) throw new Error("Text not found via OCR");
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: match.text };
          }
          const ocr = await bridge.call<{ text: string }>("vision.ocr", { imagePath: shot.path });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: ocr.text?.slice(0, 4000) ?? "" };
        }
      }
      throw new Error(`Method ${method} does not support read`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target: null };
    }
  });

  // Custom format (not formatResult) — read results include content inline
  const prefix = preCheckWarnings.length > 0 ? preCheckWarnings.join("\n") + "\n" : "";
  if (result.ok) {
    const fallbackNote = result.fallbackFrom ? ` (fell back from ${result.fallbackFrom})` : "";
    return { content: [{ type: "text" as const, text: `${prefix}Read via ${result.method}${fallbackNote} in ${result.durationMs}ms:\n\n${result.target}` }] };
  }
  return { content: [{ type: "text" as const, text: `${prefix}Failed to read${target ? ` "${target}"` : ""} — all methods exhausted. Last error: ${result.error}` }] };
});

// ── locate_with_fallback ──

server.tool("locate_with_fallback", "Find an element's position on screen using the canonical fallback chain: AX → CDP → OCR. Returns bounds (x, y, width, height).", {
  target: z.string().describe("Text, title, or identifier of the element to locate"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ target, bundleId }) => {
  await ensureBridge();
  const preCheckWarnings = await preExecutionCheck(bundleId);

  // L7→L1: If AppMap knows this element's position, return it immediately
  const mapPos = resolveMapPosition(target, bundleId);
  if (mapPos) {
    // Map provides center point only — use as hint, not authoritative bounds.
    // Fall through to full locate chain for accurate bounds.
    preCheckWarnings.push(`[L7→L1] Map hint: "${target}" expected near (${mapPos.x}, ${mapPos.y}) — verifying via locate chain`);
  }

  const plan = planExecution("locate", infra(), getSensorRanking());
  const targetPid = await resolvePid(bundleId);

  // L2→L1: Resolve known selector from references for direct injection
  const knownSelector = contextTracker.getSelector(target);
  if (knownSelector) {
    preCheckWarnings.push(`[L2→L1] Injecting known selector: ${knownSelector}`);
  }

  const result = await executeWithFallback("locate", plan, getAdaptedRetryPolicy("locate_with_fallback"), async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          // L2-65 fix: Try exact match first
          let found: { elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } };
          try {
            found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
              pid: targetPid,
              title: target,
              exact: true,
            });
          } catch {
            found = await bridge.call<{ elementPath: number[]; bounds?: { x: number; y: number; width: number; height: number } }>("ax.findElement", {
              pid: targetPid,
              title: target,
              exact: false,
            });
          }
          if (!found.bounds) throw new Error("Element found but has no bounds");
          const b = found.bounds;
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} at (${b.x},${b.y} ${b.width}x${b.height})` };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            // L2→L1: Try known selector first, then fall back to text search
            const textSearch = `Array.from(document.querySelectorAll('*')).find(e =>
                  e.textContent?.trim() === ${JSON.stringify(target)} ||
                  e.getAttribute('aria-label') === ${JSON.stringify(target)})`;
            const expr = knownSelector
              ? `(() => {
                  try {
                    const el = document.querySelector(${JSON.stringify(knownSelector)});
                    if (el) { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; }
                  } catch(e) {}
                  const fallback = ${textSearch};
                  if (!fallback) return null;
                  const r = fallback.getBoundingClientRect();
                  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
                })()`
              : `(() => {
                  const el = ${textSearch};
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
                })()`;
            const evalResult = await Runtime.evaluate({
              expression: expr,
              returnByValue: true,
            });
            const bounds = evalResult.result?.value;
            if (!bounds) throw new Error("Element not found via CDP");
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} at (${bounds.x},${bounds.y} ${bounds.width}x${bounds.height})` };
          } finally {
            await client.close();
          }
        }
        case "ocr": {
          const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
          const matches = await bridge.call<Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>>("vision.findText", {
            imagePath: shot.path,
            searchText: target,
          });
          const match = Array.isArray(matches) ? matches[0] : null;
          if (!match?.bounds) throw new Error("Target not found via OCR");
          const b = match.bounds;
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} at (${b.x},${b.y} ${b.width}x${b.height})` };
        }
      }
      throw new Error(`Method ${method} does not support locate`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target: null };
    }
  });

  return formatResult("Located", target, result, preCheckWarnings);
});

// ── select_with_fallback ──

server.tool("select_with_fallback", "Select an option from a dropdown/menu using the canonical fallback chain: AX → CDP. Finds the control, opens it, and picks the specified option.", {
  target: z.string().describe("Label or title of the dropdown/menu control"),
  option: z.string().describe("Text of the option to select"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ target, option, bundleId }) => {
  await ensureBridge();
  const preCheckWarnings = await preExecutionCheck(bundleId);

  const plan = planExecution("select", infra(), getSensorRanking());
  const targetPid = await resolvePid(bundleId);

  // L2→L1: Resolve known selector from references for direct injection
  const knownSelector = contextTracker.getSelector(target);
  if (knownSelector) {
    preCheckWarnings.push(`[L2→L1] Injecting known selector: ${knownSelector}`);
  }

  const result = await executeWithFallback("select", plan, getAdaptedRetryPolicy("select_with_fallback"), async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      switch (method) {
        case "ax": {
          // Find the popup button / combo box by title
          const found = await bridge.call<{ elementPath: number[] }>("ax.findElement", {
            pid: targetPid,
            title: target,
            exact: false,
          });
          // Press to open the menu
          await bridge.call("ax.performAction", { pid: targetPid, elementPath: found.elementPath, action: "AXPress" });
          await new Promise((r) => setTimeout(r, 300));
          // Now find the menu item by title
          const menuItem = await bridge.call<{ elementPath: number[] }>("ax.findElement", {
            pid: targetPid,
            title: option,
            exact: false,
          });
          await bridge.call("ax.performAction", { pid: targetPid, elementPath: menuItem.elementPath, action: "AXPress" });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} → ${option}` };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            // L2→L1: Try known selector first for the select element
            const textSearch = `Array.from(document.querySelectorAll('select')).find(s =>
                  s.getAttribute('aria-label') === ${JSON.stringify(target)} ||
                  s.getAttribute('name') === ${JSON.stringify(target)} ||
                  (s.labels && Array.from(s.labels).some(l => l.textContent?.trim() === ${JSON.stringify(target)})))`;
            const selectExpr = knownSelector
              ? `(() => {
                  let sel = null;
                  try { sel = document.querySelector(${JSON.stringify(knownSelector)}); } catch(e) {}
                  if (!sel || sel.tagName !== 'SELECT') sel = ${textSearch};
                  if (!sel) return null;
                  const opt = Array.from(sel.options).find(o => o.text.trim() === ${JSON.stringify(option)} || o.value === ${JSON.stringify(option)});
                  if (!opt) return 'no_option';
                  sel.value = opt.value;
                  sel.dispatchEvent(new Event('change', { bubbles: true }));
                  return 'selected';
                })()`
              : `(() => {
                  const sel = ${textSearch};
                  if (!sel) return null;
                  const opt = Array.from(sel.options).find(o => o.text.trim() === ${JSON.stringify(option)} || o.value === ${JSON.stringify(option)});
                  if (!opt) return 'no_option';
                  sel.value = opt.value;
                  sel.dispatchEvent(new Event('change', { bubbles: true }));
                  return 'selected';
                })()`;
            const evalResult = await Runtime.evaluate({
              expression: selectExpr,
              returnByValue: true,
            });
            if (evalResult.result?.value === "selected") {
              return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${target} → ${option}` };
            }
            if (evalResult.result?.value === "no_option") throw new Error(`Option "${option}" not found in select`);
            throw new Error("Select element not found via CDP");
          } finally {
            await client.close();
          }
        }
      }
      throw new Error(`Method ${method} does not support select`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target: null };
    }
  });

  return formatResult("Selected", `${target} → ${option}`, result, preCheckWarnings);
});

// ── scroll_with_fallback ──

server.tool("scroll_with_fallback", "Scroll within an element or the active window using the canonical fallback chain: AX → CDP → coordinates. Scrolls until target text is visible, or by a fixed amount.", {
  direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
  amount: z.number().optional().describe("Scroll amount in pixels (default: 300)"),
  target: z.string().optional().describe("Scroll until this text is visible (overrides amount)"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ direction, amount, target, bundleId }) => {
  await ensureBridge();
  const preCheckWarnings = await preExecutionCheck(bundleId);

  const plan = planExecution("scroll", infra(), getSensorRanking());
  const targetPid = await resolvePid(bundleId);
  const scrollAmount = amount ?? 300;

  // L2→L1: Resolve known selector from references for scroll container
  const knownSelector = target ? contextTracker.getSelector(target) : null;
  if (knownSelector) {
    preCheckWarnings.push(`[L2→L1] Injecting known selector: ${knownSelector}`);
  }

  // Resolve scroll coordinates — center of the frontmost window
  let scrollX = 400, scrollY = 400;
  try {
    const wins = await bridge.call<Array<{ x: number; y: number; width: number; height: number }>>("cg.windows", {});
    if (wins && wins.length > 0) {
      const w = wins[0]!;
      scrollX = Math.round(w.x + w.width / 2);
      scrollY = Math.round(w.y + w.height / 2);
    }
  } catch { /* fallback to default coords */ }

  // If target is specified, scroll in a loop until text is visible (max 10 scrolls)
  if (target) {
    for (let i = 0; i < 10; i++) {
      // Check if target is already visible
      try {
        const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
        const matches = await bridge.call<Array<{ text: string }>>("vision.findText", {
          imagePath: shot.path,
          searchText: target,
        });
        if (Array.isArray(matches) && matches.length > 0) {
          return { content: [{ type: "text" as const, text: `"${target}" is visible after ${i} scroll(s).` }] };
        }
      } catch { /* OCR failed, keep scrolling */ }

      // Scroll once
      const deltaX = direction === "left" ? -scrollAmount : direction === "right" ? scrollAmount : 0;
      const deltaY = direction === "up" ? -scrollAmount : direction === "down" ? scrollAmount : 0;
      await bridge.call("cg.scroll", { x: scrollX, y: scrollY, deltaX, deltaY });
      await new Promise((r) => setTimeout(r, 400));
    }
    return { content: [{ type: "text" as const, text: `Scrolled ${direction} 10 times but "${target}" not found.` }] };
  }

  // Fixed-amount scroll via fallback chain
  const result = await executeWithFallback("scroll", plan, getAdaptedRetryPolicy("scroll_with_fallback"), async (method: ExecutionMethod, attempt: number): Promise<ActionResult> => {
    const start = Date.now();
    try {
      const deltaX = direction === "left" ? -scrollAmount : direction === "right" ? scrollAmount : 0;
      const deltaY = direction === "up" ? -scrollAmount : direction === "down" ? scrollAmount : 0;

      switch (method) {
        case "ax": {
          // AX scroll is unreliable — use CG scroll directly (works on the focused app)
          await bridge.call("cg.scroll", { x: scrollX, y: scrollY, deltaX, deltaY });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${direction} ${scrollAmount}px` };
        }
        case "cdp": {
          if (!cdpPort) throw new Error("CDP not available");
          const { CDP: CDPClient, port } = await ensureCDP();
          const client = await CDPClient({ port });
          try {
            const { Runtime } = client;
            // L2→L1: Try scrolling known selector container first
            const scrollExpr = knownSelector
              ? `(() => {
                  try {
                    const el = document.querySelector(${JSON.stringify(knownSelector)});
                    if (el) { el.scrollBy(${deltaX}, ${deltaY}); return 'scrolled'; }
                  } catch(e) {}
                  window.scrollBy(${deltaX}, ${deltaY});
                  return 'scrolled';
                })()`
              : `window.scrollBy(${deltaX}, ${deltaY})`;
            await Runtime.evaluate({ expression: scrollExpr });
            return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${direction} ${scrollAmount}px` };
          } finally {
            await client.close();
          }
        }
        case "coordinates": {
          await bridge.call("cg.scroll", { x: scrollX, y: scrollY, deltaX, deltaY });
          return { ok: true, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: null, target: `${direction} ${scrollAmount}px` };
        }
      }
      throw new Error(`Method ${method} does not support scroll`);
    } catch (err) {
      return { ok: false, method, durationMs: Date.now() - start, fallbackFrom: null, retries: attempt, error: err instanceof Error ? err.message : String(err), target: null };
    }
  });

  return formatResult("Scrolled", `${direction} ${scrollAmount}px`, result, preCheckWarnings);
});

// ── wait_for_state ──

server.tool("wait_for_state", "Wait until a condition is met on screen: text appears, text disappears, or element becomes available. Polls at intervals using the fallback chain.", {
  condition: z.enum(["text_appears", "text_disappears", "element_exists"]).describe("What to wait for"),
  target: z.string().describe("Text or element to watch for"),
  timeoutMs: z.number().optional().describe("Maximum wait time in ms (default: 10000)"),
  pollMs: z.number().optional().describe("Poll interval in ms (default: 1000)"),
  bundleId: z.string().optional().describe("App bundle ID"),
}, async ({ condition, target, timeoutMs, pollMs, bundleId }) => {
  await ensureBridge();

  const timeout = timeoutMs ?? 10000;
  const poll = pollMs ?? 1000;
  const deadline = Date.now() + timeout;
  const targetPid = await resolvePid(bundleId);
  let lastCheck = "";

  while (Date.now() < deadline) {
    let found = false;

    // Try AX first (fastest), then OCR as fallback
    try {
      if (condition === "element_exists") {
        await bridge.call("ax.findElement", { pid: targetPid, title: target, exact: false });
        found = true;
      } else {
        // L2-67 fix: Try AX text search first (works for non-frontmost apps),
        // then fall back to OCR if AX doesn't find it.
        try {
          const axEl = await bridge.call<{ value?: string }>("ax.findElement", { pid: targetPid, title: target, exact: false });
          found = true;
        } catch {
          // AX title search failed — also try reading text content via AX tree
          try {
            const tree = await bridge.call<{ description: string }>("ax.getElementTree", { pid: targetPid, maxDepth: 4 });
            const desc = tree.description ?? JSON.stringify(tree);
            found = desc.includes(target);
          } catch {
            // AX unavailable — fall back to OCR
            const shot = await bridge.call<{ path: string }>("cg.captureScreen", {});
            const matches = await bridge.call<Array<{ text: string }>>("vision.findText", {
              imagePath: shot.path,
              searchText: target,
            });
            found = Array.isArray(matches) && matches.length > 0;
          }
        }
      }
    } catch {
      found = false;
    }

    // Also try CDP if available and text-based
    if (!found && cdpPort && condition !== "element_exists") {
      try {
        const { CDP: CDPClient, port } = await ensureCDP();
        const client = await CDPClient({ port });
        try {
          const { Runtime } = client;
          const evalResult = await Runtime.evaluate({
            expression: `document.body?.innerText?.includes(${JSON.stringify(target)}) ?? false`,
            returnByValue: true,
          });
          found = !!evalResult.result?.value;
        } finally {
          await client.close();
        }
      } catch { /* CDP unavailable */ }
    }

    const elapsed = Date.now() - (deadline - timeout);
    lastCheck = `${elapsed}ms`;

    if (condition === "text_appears" && found) {
      return { content: [{ type: "text" as const, text: `"${target}" appeared after ${lastCheck}.` }] };
    }
    if (condition === "text_disappears" && !found) {
      return { content: [{ type: "text" as const, text: `"${target}" disappeared after ${lastCheck}.` }] };
    }
    if (condition === "element_exists" && found) {
      return { content: [{ type: "text" as const, text: `Element "${target}" found after ${lastCheck}.` }] };
    }

    await new Promise((r) => setTimeout(r, poll));
  }

  return { content: [{ type: "text" as const, text: `Timeout: "${target}" — condition "${condition}" not met after ${timeout}ms.` }] };
});

// ═══════════════════════════════════════════════
// JOBS — persistent multi-step automation with resume
// ═══════════════════════════════════════════════

originalTool("job_create", "Create a new automation job. Jobs persist across restarts and can be resumed from the last successful step. Supports chaining: set dependsOn to wait for another job, and vars for template substitution (e.g. {PROMPT_TEXT}).", {
  task: z.string().describe("Human-readable description of what this job should do"),
  playbookId: z.string().optional().describe("Playbook ID to drive this job (optional — AI-only if omitted)"),
  bundleId: z.string().optional().describe("Target application bundle ID (e.g., 'com.apple.Safari'). Omit for app-agnostic jobs."),
  windowId: z.number().optional().describe("Target window ID within the application. Omit for app-agnostic jobs."),
  steps: z.array(z.object({
    action: z.string().describe("Action name (e.g., navigate, click, type_text, screenshot, key, browser_js, cdp_key_event)"),
    target: z.string().optional().describe("Target element or URL"),
    description: z.string().optional().describe("Human-readable description"),
    text: z.string().optional().describe("Text payload for type_text/type_into actions"),
    keys: z.string().optional().describe("Key combo string for key/key_combo actions (e.g., 'cmd+a')"),
    value: z.string().optional().describe("Value payload for set_value actions"),
  })).optional().describe("Ordered steps for this job (can be populated from a playbook)"),
  tags: z.array(z.string()).optional().describe("Tags for filtering/grouping"),
  priority: z.number().optional().describe("Priority (lower = higher priority, default: 10)"),
  maxRetries: z.number().optional().describe("Max retry attempts on failure (default: 3)"),
  sessionId: z.string().optional().describe("Bind to an existing supervisor session"),
  chainId: z.string().optional().describe("Chain ID to group linked jobs into a flow"),
  dependsOn: z.string().optional().describe("Job ID this job depends on — won't run until dependency is done"),
  vars: z.record(z.string(), z.string()).optional().describe("Variables for template substitution in playbook steps (e.g. {PROMPT_TEXT} → 'hello world'). Use {prev.outputKey} to reference outputs from dependsOn job."),
}, async ({ task, playbookId, bundleId, windowId, steps, tags, priority, maxRetries, sessionId, chainId, dependsOn, vars }) => {
  const createOpts: Parameters<typeof jobManager.create>[0] = { task };
  if (playbookId !== undefined) createOpts.playbookId = playbookId;
  if (bundleId !== undefined) createOpts.bundleId = bundleId;
  if (windowId !== undefined) createOpts.windowId = windowId;
  if (steps !== undefined) createOpts.steps = steps;
  if (tags !== undefined) createOpts.tags = tags;
  if (priority !== undefined) createOpts.priority = priority;
  if (maxRetries !== undefined) createOpts.maxRetries = maxRetries;
  if (sessionId !== undefined) createOpts.sessionId = sessionId;
  if (chainId !== undefined) createOpts.chainId = chainId;
  if (dependsOn !== undefined) createOpts.dependsOn = dependsOn;
  if (vars !== undefined) createOpts.vars = vars as Record<string, string>;
  const job = jobManager.create(createOpts);
  const extra = [];
  if (job.chainId) extra.push(`Chain: ${job.chainId}`);
  if (job.dependsOn) extra.push(`Depends on: ${job.dependsOn}`);
  if (job.vars && Object.keys(job.vars).length > 0) extra.push(`Vars: ${Object.keys(job.vars).join(", ")}`);
  return { content: [{ type: "text" as const, text: `Job created: ${job.id}\nTask: ${job.task}\nState: ${job.state}\nSteps: ${job.steps.length}\nPriority: ${job.priority}\nTarget: ${job.bundleId ?? "(any app)"}${job.windowId != null ? ` window ${job.windowId}` : ""}${extra.length > 0 ? "\n" + extra.join("\n") : ""}` }] };
});

originalTool("job_create_chain", "Create a chain of linked jobs that run sequentially. Each job waits for the previous one to finish. Use vars with {prev.outputKey} to pass data between jobs.", {
  jobs: z.array(z.object({
    task: z.string().describe("What this job does"),
    playbookId: z.string().optional().describe("Playbook ID"),
    bundleId: z.string().optional().describe("Target app bundle ID"),
    vars: z.record(z.string(), z.string()).optional().describe("Variables — use {prev.Read_Codex_response} to get output from prior job step"),
    tags: z.array(z.string()).optional(),
  })).describe("Ordered list of jobs to chain"),
}, async ({ jobs }) => {
  const cleanJobs = jobs.map(j => {
    const clean: { task: string; playbookId?: string; bundleId?: string; vars?: Record<string, string>; tags?: string[] } = { task: j.task };
    if (j.playbookId) clean.playbookId = j.playbookId;
    if (j.bundleId) clean.bundleId = j.bundleId;
    if (j.vars) clean.vars = j.vars as Record<string, string>;
    if (j.tags) clean.tags = j.tags;
    return clean;
  });
  const chain = jobManager.createChain({ jobs: cleanJobs });
  const lines = [`Chain created: ${chain[0]?.chainId ?? "unknown"} (${chain.length} jobs)`];
  for (const job of chain) {
    lines.push(`  ${job.id}: ${job.task}${job.dependsOn ? ` (after ${job.dependsOn})` : " (first)"}`);
  }
  lines.push("", "Run with: job_run_all() to execute the full chain sequentially.");
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("job_status", "Get detailed status of a job including step progress and resume point.", {
  jobId: z.string().describe("Job ID"),
}, async ({ jobId }) => {
  const job = jobManager.get(jobId);
  if (!job) return { content: [{ type: "text" as const, text: `Job ${jobId} not found.` }] };

  const completed = job.steps.filter((s) => s.status === "done").length;
  const failed = job.steps.filter((s) => s.status === "failed").length;
  const pending = job.steps.filter((s) => s.status === "pending").length;
  const resume = jobManager.getResumePoint(jobId);

  const lines = [
    `Job: ${job.id}`,
    `Task: ${job.task}`,
    `State: ${job.state}`,
    `Playbook: ${job.playbookId ?? "(none)"}`,
    `Target: ${job.bundleId ?? "(any app)"}${job.windowId != null ? ` window ${job.windowId}` : ""}`,
    `Session: ${job.sessionId ?? "(unbound)"}`,
    `Steps: ${completed} done, ${failed} failed, ${pending} pending (${job.steps.length} total)`,
    `Last completed step: ${job.lastStep}`,
    `Resume point: ${resume ? `step ${resume.stepIndex} — ${resume.step.description ?? resume.step.action}` : "(none — all done or no pending steps)"}`,
    `Retries: ${job.retries}/${job.maxRetries}`,
  ];
  if (job.chainId) lines.push(`Chain: ${job.chainId}`);
  if (job.dependsOn) lines.push(`Depends on: ${job.dependsOn}`);
  if (job.vars && Object.keys(job.vars).length > 0) lines.push(`Vars: ${JSON.stringify(job.vars)}`);
  if (job.blockReason) lines.push(`Block reason: ${job.blockReason}`);
  if (job.lastError) lines.push(`Last error: ${job.lastError}`);
  if (job.startedAt) lines.push(`Started: ${job.startedAt}`);
  if (job.completedAt) lines.push(`Completed: ${job.completedAt}`);

  if (job.steps.length > 0) {
    lines.push("", "Steps:");
    for (const s of job.steps) {
      const icon = s.status === "done" ? "✓" : s.status === "failed" ? "✗" : s.status === "skipped" ? "–" : "○";
      lines.push(`  ${icon} [${s.index}] ${s.description ?? s.action}${s.error ? ` (${s.error})` : ""}${s.durationMs != null ? ` ${s.durationMs}ms` : ""}`);
      if (s.output) lines.push(`      → ${s.output.substring(0, 200)}${s.output.length > 200 ? "..." : ""}`);
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("job_list", "List all jobs, optionally filtered by state. Shows summary counts and job details.", {
  state: z.enum(["queued", "running", "blocked", "waiting_human", "done", "failed"]).optional().describe("Filter by state"),
}, async ({ state }) => {
  const jobs = jobManager.list(state as JobState | undefined);
  const sum = jobManager.summary();

  const lines = [
    `Jobs: ${sum.total} total — queued:${sum.byState.queued} running:${sum.byState.running} blocked:${sum.byState.blocked} waiting_human:${sum.byState.waiting_human} done:${sum.byState.done} failed:${sum.byState.failed}`,
  ];
  if (sum.oldestQueued) lines.push(`Oldest queued: ${sum.oldestQueued}`);
  if (sum.runningJobIds.length > 0) lines.push(`Running: ${sum.runningJobIds.join(", ")}`);

  if (jobs.length > 0) {
    lines.push("");
    for (const j of jobs.slice(0, 50)) {
      const completed = j.steps.filter((s) => s.status === "done").length;
      lines.push(`[${j.state}] ${j.id} — ${j.task.slice(0, 60)} (${completed}/${j.steps.length} steps, pri=${j.priority})`);
    }
    if (jobs.length > 50) lines.push(`  ... and ${jobs.length - 50} more`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("job_transition", "Move a job to a new state. Validates the transition is allowed by the state machine.", {
  jobId: z.string().describe("Job ID"),
  to: z.enum(["queued", "running", "blocked", "waiting_human", "done", "failed"]).describe("Target state"),
  reason: z.string().optional().describe("Block/failure reason"),
  sessionId: z.string().optional().describe("Session ID (when transitioning to running)"),
}, async ({ jobId, to, reason, sessionId }) => {
  const transOpts: { blockReason?: string; error?: string; sessionId?: string } = {};
  if ((to === "blocked" || to === "waiting_human") && reason) transOpts.blockReason = reason;
  if (to === "failed" && reason) transOpts.error = reason;
  if (sessionId !== undefined) transOpts.sessionId = sessionId;
  const result = jobManager.transition(jobId, to as JobState, transOpts);
  if ("error" in result) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
  return { content: [{ type: "text" as const, text: `Job ${jobId} → ${to}${reason ? ` (${reason})` : ""}` }] };
});

originalTool("job_step_done", "Mark a step as completed and advance the job's resume point.", {
  jobId: z.string().describe("Job ID"),
  stepIndex: z.number().describe("Step index to mark done"),
  durationMs: z.number().optional().describe("How long the step took"),
}, async ({ jobId, stepIndex, durationMs }) => {
  const stepOpts: { durationMs?: number } = {};
  if (durationMs !== undefined) stepOpts.durationMs = durationMs;
  const result = jobManager.completeStep(jobId, stepIndex, stepOpts);
  if ("error" in result) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
  const resume = jobManager.getResumePoint(jobId);
  return { content: [{ type: "text" as const, text: `Step ${stepIndex} done.${resume ? ` Next: step ${resume.stepIndex} — ${resume.step.description ?? resume.step.action}` : " All steps complete."}` }] };
});

originalTool("job_step_fail", "Mark a step as failed. The job stays running — caller decides whether to retry, block, or fail the job.", {
  jobId: z.string().describe("Job ID"),
  stepIndex: z.number().describe("Step index that failed"),
  error: z.string().describe("Error message"),
}, async ({ jobId, stepIndex, error }) => {
  const result = jobManager.failStep(jobId, stepIndex, error);
  if ("error" in result) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
  return { content: [{ type: "text" as const, text: `Step ${stepIndex} failed: ${error}` }] };
});

originalTool("job_resume", "Get the resume point for a job — the next pending step after the last successful one.", {
  jobId: z.string().describe("Job ID"),
}, async ({ jobId }) => {
  const job = jobManager.get(jobId);
  if (!job) return { content: [{ type: "text" as const, text: `Job ${jobId} not found.` }] };
  const resume = jobManager.getResumePoint(jobId);
  if (!resume) {
    return { content: [{ type: "text" as const, text: `No pending steps. Last completed: ${job.lastStep}. State: ${job.state}.` }] };
  }
  return { content: [{ type: "text" as const, text: `Resume at step ${resume.stepIndex}: ${resume.step.description ?? resume.step.action}\nAction: ${resume.step.action}${resume.step.target ? `\nTarget: ${resume.step.target}` : ""}` }] };
});

originalTool("job_dequeue", "Pop the highest-priority queued job and transition it to running.", {
  sessionId: z.string().optional().describe("Session ID to bind the job to"),
}, async ({ sessionId }) => {
  const job = jobManager.dequeue(sessionId);
  if (!job) return { content: [{ type: "text" as const, text: "No queued jobs." }] };
  const resume = jobManager.getResumePoint(job.id);
  return { content: [{ type: "text" as const, text: `Dequeued: ${job.id}\nTask: ${job.task}\nSteps: ${job.steps.length}\nResume: ${resume ? `step ${resume.stepIndex}` : "start"}` }] };
});

originalTool("job_remove", "Remove a job entirely (any state).", {
  jobId: z.string().describe("Job ID"),
}, async ({ jobId }) => {
  const ok = jobManager.remove(jobId);
  return { content: [{ type: "text" as const, text: ok ? `Job ${jobId} removed.` : `Job ${jobId} not found.` }] };
});

// ── Job Runner + Worker ─────────────────────────

const PLAYBOOKS_DIR = playbooksDir; // Use same dir as recorder (project-local ./playbooks/)

let activeJobRunner: JobRunner | null = null;
let activePlaybookStore: PlaybookStore | null = null;
let activePlaybookEngine: PlaybookEngine | null = null;


function getJobRunner(): JobRunner {
  // Always reload playbooks from disk (new files may have been added)
  if (!activePlaybookStore) {
    activePlaybookStore = new PlaybookStore(PLAYBOOKS_DIR);
  }
  activePlaybookStore.load();

  if (!activeJobRunner) {
    // Build playbook engine stack: adapter → runtime → engine
    const adapter = new AccessibilityAdapter(bridge);
    const logger = new TimelineLogger();
    const locCache = new LocatorCache();
    locCache.setLearningEngine(learningEngine);
    const runtimeService = new AutomationRuntimeService(adapter, logger, locCache);
    // Wire #15: connect AppMap to Executor for skip-verify optimization
    runtimeService.setAppMap(appMap);
    const playbookEngine = new PlaybookEngine(runtimeService);
    activePlaybookEngine = playbookEngine;
    // Wire CDP into playbook engine for browser_js / cdp_key_event steps
    playbookEngine.setCDPConnect(async (overridePort?: number) => {
      if (overridePort) {
        if (!CDP) CDP = (await import("chrome-remote-interface")).default;
        const client = await CDP({ port: overridePort });
        return { Runtime: client.Runtime, Input: client.Input, close: () => client.close() };
      }
      const { CDP: CDPClient, port } = await ensureCDP();
      const client = await CDPClient({ port });
      return { Runtime: client.Runtime, Input: client.Input, close: () => client.close() };
    });

    activeJobRunner = new JobRunner(
      bridge,
      jobManager,
      leaseManager,
      supervisor,
      (() => {
        const cfg: Partial<import("./src/jobs/runner.js").JobRunnerConfig> = {
          hasCDP: cdpPort !== null,
          playbookEngine,
          playbookStore: activePlaybookStore,
          runtimeService,
        };
        if (cdpPort) {
          cfg.cdpConnect = async () => {
            const { CDP: CDPClient, port } = await ensureCDP();
            const client = await CDPClient({ port });
            return { Runtime: client.Runtime, Input: client.Input, close: () => client.close() };
          };
        }
        return cfg;
      })(),
    );
  }
  return activeJobRunner;
}



originalTool("job_run", "Execute the next queued job: dequeue → claim session → run steps through fallback chain → auto-transition. Returns when the job completes, blocks, or fails.", {
}, async () => {
  await ensureBridge();
  const runner = getJobRunner();
  const result = await runner.run();
  if (!result) return { content: [{ type: "text" as const, text: "No queued jobs." }] };

  const lines = [
    `Job: ${result.jobId}`,
    `Final state: ${result.finalState}`,
    `Steps: ${result.stepsCompleted}/${result.totalSteps}`,
    `Duration: ${result.durationMs}ms`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("job_run_all", "Process all queued jobs sequentially until the queue is empty or a job blocks/fails. Each job gets its own session.", {
  maxJobs: z.number().optional().describe("Max jobs to process (default: unlimited)"),
}, async ({ maxJobs }) => {
  await ensureBridge();
  const runner = getJobRunner();
  const results: Array<{ jobId: string; finalState: string; stepsCompleted: number; totalSteps: number; durationMs: number; error: string | null }> = [];

  const limit = maxJobs ?? Infinity;
  for (let i = 0; i < limit; i++) {
    const result = await runner.run();
    if (!result) break;
    results.push(result);
  }

  if (results.length === 0) return { content: [{ type: "text" as const, text: "No queued jobs." }] };

  const lines = [`Processed ${results.length} job(s):`];
  for (const r of results) {
    lines.push(`  ${r.jobId}: ${r.finalState} (${r.stepsCompleted}/${r.totalSteps} steps, ${r.durationMs}ms)${r.error ? ` — ${r.error}` : ""}`);
  }

  const done = results.filter((r) => r.finalState === "done").length;
  const failed = results.filter((r) => r.finalState === "failed").length;
  const blocked = results.filter((r) => r.finalState === "blocked" || r.finalState === "waiting_human").length;
  lines.push(`\nSummary: ${done} done, ${failed} failed, ${blocked} blocked`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// ── Job Worker Daemon (separate process, survives restarts) ───

const WORKER_DAEMON_PATH = path.resolve(__dirname, "scripts/worker-daemon.ts");

originalTool("worker_start", "Start the job worker daemon as a detached background process. Survives MCP/client restarts. Continuously processes the job queue.", {
  pollMs: z.number().optional().describe("Poll interval when queue is empty (default: 3000ms)"),
  maxJobs: z.number().optional().describe("Max jobs to process before auto-stopping (0 = unlimited, default: 0)"),
}, async ({ pollMs, maxJobs }) => {
  const existingPid = getWorkerDaemonPid();
  if (existingPid !== null) {
    return { content: [{ type: "text" as const, text: `Worker daemon is already running (pid=${existingPid}).` }] };
  }

  const daemonArgs = ["tsx", WORKER_DAEMON_PATH];
  if (pollMs !== undefined) daemonArgs.push("--poll", String(pollMs));
  if (maxJobs !== undefined) daemonArgs.push("--max-jobs", String(maxJobs));

  const child = spawn("npx", daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Wait briefly for PID file to appear
  await new Promise((r) => setTimeout(r, 1500));
  const pid = getWorkerDaemonPid();

  return { content: [{ type: "text" as const, text: pid
    ? `Worker daemon started (pid=${pid}).\nPoll: ${pollMs ?? 3000}ms | Max jobs: ${maxJobs ?? "unlimited"}\nLog: ${WORKER_LOG_FILE}`
    : `Worker daemon spawn attempted but PID not yet confirmed. Check log: ${WORKER_LOG_FILE}` }] };
});

originalTool("worker_stop", "Stop the worker daemon. Sends SIGTERM for graceful shutdown — current job finishes before exit.", {
}, async () => {
  const pid = getWorkerDaemonPid();
  if (pid === null) {
    return { content: [{ type: "text" as const, text: "Worker daemon is not running." }] };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { content: [{ type: "text" as const, text: `Failed to send SIGTERM to pid=${pid}. Process may have already exited.` }] };
  }

  // Wait for it to exit
  await new Promise((r) => setTimeout(r, 2000));
  const stillAlive = getWorkerDaemonPid();

  const s = getWorkerLiveStatus();
  const summary = `Jobs processed: ${s.jobsProcessed} (${s.jobsDone} done, ${s.jobsFailed} failed, ${s.jobsBlocked} blocked)`;

  return { content: [{ type: "text" as const, text: stillAlive
    ? `SIGTERM sent to pid=${pid} but process is still running. It may be finishing a job.\n${summary}`
    : `Worker daemon stopped (was pid=${pid}).\n${summary}` }] };
});

originalTool("worker_status", "Get the current status of the worker daemon (reads persisted state from disk).", {
}, async () => {
  const s = getWorkerLiveStatus();
  const lines = [
    `Running: ${s.running}${s.pid ? ` (pid=${s.pid})` : ""}`,
    `Started: ${s.startedAt ?? "(not started)"}`,
    `Uptime: ${Math.round(s.uptimeMs / 1000)}s`,
    `Poll: ${s.pollMs}ms | Max jobs: ${s.maxJobs || "unlimited"}`,
    `Jobs processed: ${s.jobsProcessed}`,
    `  Done: ${s.jobsDone}`,
    `  Failed: ${s.jobsFailed}`,
    `  Blocked: ${s.jobsBlocked}`,
  ];
  if (s.lastJobId) lines.push(`Last job: ${s.lastJobId} → ${s.lastJobState}`);

  if (s.recentResults.length > 0) {
    lines.push("", `Recent (last ${Math.min(s.recentResults.length, 10)}):`);
    for (const r of s.recentResults.slice(-10)) {
      lines.push(`  ${r.jobId}: ${r.finalState} (${r.stepsCompleted}/${r.totalSteps}, ${r.durationMs}ms)`);
    }
  }

  lines.push("", `Log: ${WORKER_LOG_FILE}`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// ═══════════════════════════════════════════════
// PLANNER — goal-oriented planning
// ═══════════════════════════════════════════════

originalTool("plan_goal", "Describe WHAT you want to achieve — ScreenHand builds a step-by-step plan by searching playbooks, saved strategies, and platform references. Returns steps with confidence scores. Does NOT execute — review the plan, then use plan_execute() or plan_step() to run it. Use for complex multi-step workflows instead of figuring out each step yourself.", {
  goal: z.string().describe("What you want to achieve (e.g. 'Export Premiere Pro timeline as H.264')"),
}, async ({ goal: goalDescription }) => {
  const goal = planner.createGoal(goalDescription);
  await planner.planGoal(goal);
  goalStore.add(goal);

  const sg = goal.subgoals[0]!;
  const plan = sg.plan;

  if (!plan) {
    return { content: [{ type: "text" as const, text: "No plan could be generated." }] };
  }

  const lines = [
    `Goal: ${goalDescription}`,
    `Plan source: ${plan.source}${plan.sourceId ? ` (${plan.sourceId})` : ""}`,
    `Confidence: ${(plan.confidence * 100).toFixed(0)}%`,
    `Steps: ${plan.steps.length}`,
    "",
  ];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const params = Object.keys(step.params).length > 0
      ? ` ${JSON.stringify(step.params)}`
      : "";
    const llmTag = step.requiresLLM ? " [LLM]" : "";
    const postcond = step.expectedPostcondition
      ? ` → verify: ${step.expectedPostcondition.type}(${step.expectedPostcondition.target})`
      : "";
    lines.push(`  ${i + 1}. ${step.tool || step.description}${params}${llmTag}${postcond}`);
  }

  lines.push("", `Goal ID: ${goal.id}`);

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    _meta: { goalId: goal.id, plan },
  };
});

originalTool("plan_execute", "Run a plan automatically. Known steps (from playbooks/references) execute internally at full speed. Pauses at LLM steps where YOUR judgment is needed — call plan_step_resolve() to provide the tool+params. On completion, the successful strategy is auto-saved to memory for future reuse.", {
  goalId: z.string().describe("Goal ID from plan_goal"),
}, async ({ goalId }) => {
  const goal = goalStore.get(goalId);
  if (!goal) {
    return { content: [{ type: "text" as const, text: `Goal not found: ${goalId}` }] };
  }

  const adaptiveBudget = learningEngine.getAdaptiveBudget(worldModel.getState().focusedApp?.bundleId ?? "unknown");
  const executor = new PlanExecutor(worldModel, planner, toolRegistry.toExecutor(), { postconditionWaitMs: adaptiveBudget.verifyMs, defaultStepTimeout: Math.max(30_000, adaptiveBudget.actMs * 2) }, recoveryEngine, learningEngine);
  executor.setAppMap(appMap);
  const result = await executor.executeGoal(goal);
  goalStore.update(goalId, goal);

  // Check if paused at an LLM step
  if ("paused" in result) {
    const pause = result as ExecutionPause;
    return {
      content: [{ type: "text" as const, text: [
        `PAUSED at step ${pause.stepIndex + 1}/${pause.totalSteps} — requires your interpretation.`,
        `Step: ${pause.stepDescription}`,
        "",
        "Use plan_step_resolve to provide the tool + params for this step,",
        "then call plan_execute again to continue.",
      ].join("\n") }],
      _meta: { goalId, paused: true, stepIndex: pause.stepIndex },
    };
  }

  // Completed — save strategy to memory if successful
  if (result.success) {
    try {
      const sg = goal.subgoals.find((s) => s.status === "completed");
      if (sg?.plan) {
        const steps = sg.plan.steps
          .filter((s) => s.status === "completed" && s.tool)
          .map((s) => ({ tool: s.tool, params: s.params }));
        if (steps.length > 0) {
          memory.appendStrategy({
            id: "str_plan_" + Date.now().toString(36),
            task: goal.description,
            steps,
            totalDurationMs: result.durationMs,
            successCount: 1,
            failCount: 0,
            lastUsed: new Date().toISOString(),
            tags: ["auto-plan", sg.plan.source],
            fingerprint: "",
          });
        }
      }
    } catch { /* strategy recording is best-effort */ }
  }

  const lines = [
    result.success ? "Goal completed successfully." : `Goal failed: ${result.error}`,
    `Steps: ${result.stepsExecuted} executed, ${result.replans} replans`,
    `Duration: ${result.durationMs}ms`,
    `Subgoals: ${result.subgoalsCompleted}/${result.totalSubgoals} completed`,
    "",
    "── EXECUTION LOG ──",
    ...("executionLog" in result ? result.executionLog : []),
  ];

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("plan_step", "Execute the next single step of a goal. For incremental client-driven execution. Returns the step result, or pauses at LLM steps for you to interpret.", {
  goalId: z.string().describe("Goal ID from plan_goal"),
}, async ({ goalId }) => {
  const goal = goalStore.get(goalId);
  if (!goal) {
    return { content: [{ type: "text" as const, text: `Goal not found: ${goalId}` }] };
  }

  const adaptiveBudget = learningEngine.getAdaptiveBudget(worldModel.getState().focusedApp?.bundleId ?? "unknown");
  const executor = new PlanExecutor(worldModel, planner, toolRegistry.toExecutor(), { postconditionWaitMs: adaptiveBudget.verifyMs, defaultStepTimeout: Math.max(30_000, adaptiveBudget.actMs * 2) }, recoveryEngine, learningEngine);
  executor.setAppMap(appMap);
  const result = await executor.executeNextStep(goal);
  goalStore.update(goalId, goal);

  if ("paused" in result) {
    const pause = result as ExecutionPause;
    return {
      content: [{ type: "text" as const, text: [
        `Step ${pause.stepIndex + 1}/${pause.totalSteps} requires LLM interpretation:`,
        `  ${pause.stepDescription}`,
        "",
        "Use plan_step_resolve to provide tool + params, or execute the step yourself and call plan_step again.",
      ].join("\n") }],
    };
  }

  if ("goalId" in result) {
    // PlanResult — goal completed
    return {
      content: [{ type: "text" as const, text: result.success
        ? `Goal completed: ${result.subgoalsCompleted}/${result.totalSubgoals} subgoals done.`
        : `Goal failed: ${result.error}` }],
    };
  }

  // StepResult
  const sr = result;
  return {
    content: [{ type: "text" as const, text: [
      sr.success ? `Step completed: ${sr.step.tool}` : `Step failed: ${sr.error}`,
      `Duration: ${sr.durationMs}ms`,
      sr.usedFallback ? "(used fallback tool)" : "",
      sr.postconditionMet ? "" : "Warning: postcondition not met",
    ].filter(Boolean).join("\n") }],
  };
});

originalTool("plan_step_resolve", "Resolve a paused LLM step by providing the tool and params to use. The server executes the tool, verifies postconditions, and advances the plan.", {
  goalId: z.string().describe("Goal ID"),
  tool: z.string().describe("MCP tool name to execute for this step"),
  params: z.record(z.string(), z.unknown()).optional().describe("Tool parameters"),
}, async ({ goalId, tool, params }) => {
  const goal = goalStore.get(goalId);
  if (!goal) {
    return { content: [{ type: "text" as const, text: `Goal not found: ${goalId}` }] };
  }

  const adaptiveBudget = learningEngine.getAdaptiveBudget(worldModel.getState().focusedApp?.bundleId ?? "unknown");
  const executor = new PlanExecutor(worldModel, planner, toolRegistry.toExecutor(), { postconditionWaitMs: adaptiveBudget.verifyMs, defaultStepTimeout: Math.max(30_000, adaptiveBudget.actMs * 2) }, recoveryEngine, learningEngine);
  executor.setAppMap(appMap);
  const result = await executor.resolveStep(goal, tool, params ?? {});
  goalStore.update(goalId, goal);

  return {
    content: [{ type: "text" as const, text: result.success
      ? `Step resolved and completed: ${tool}`
      : `Step failed: ${result.error}` }],
  };
});

originalTool("plan_status", "Check the current status of a goal: subgoal progress, current step, completion state.", {
  goalId: z.string().describe("Goal ID"),
}, async ({ goalId }) => {
  const goal = goalStore.get(goalId);
  if (!goal) {
    return { content: [{ type: "text" as const, text: `Goal not found: ${goalId}` }] };
  }

  const lines = [
    `Goal: ${goal.description}`,
    `Status: ${goal.status}`,
    `Created: ${goal.createdAt}`,
    goal.completedAt ? `Completed: ${goal.completedAt}` : "",
    "",
  ].filter(Boolean);

  for (let i = 0; i < goal.subgoals.length; i++) {
    const sg = goal.subgoals[i]!;
    const plan = sg.plan;
    const progress = plan
      ? `${plan.currentStepIndex}/${plan.steps.length} steps`
      : "no plan";
    lines.push(`  Subgoal ${i + 1}: ${sg.status} (${progress}, ${sg.attempts} attempts)`);
    if (sg.lastError) lines.push(`    Error: ${sg.lastError}`);
  }

  if (goal.pausedAt) {
    lines.push("", `Paused at: subgoal ${goal.pausedAt.subgoalIndex + 1}, step ${goal.pausedAt.stepIndex + 1}`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("plan_list", "List all goals (active, completed, failed). Optionally filter by status.", {
  status: z.string().optional().describe("Filter by status: pending, active, completed, failed"),
}, async ({ status }) => {
  const goals = status
    ? goalStore.list(status as any)
    : goalStore.list();

  if (goals.length === 0) {
    return { content: [{ type: "text" as const, text: "No goals found." }] };
  }

  const lines = goals.map((g) => {
    const sgDone = g.subgoals.filter((s) => s.status === "completed").length;
    return `  ${g.id}: ${g.status} — "${g.description}" (${sgDone}/${g.subgoals.length} subgoals, ${g.createdAt})`;
  });

  return { content: [{ type: "text" as const, text: [`${goals.length} goal(s):`, ...lines].join("\n") }] };
});

// ═══════════════════════════════════════════════
// PERCEPTION + WORLD MODEL — continuous state tracking
// ═══════════════════════════════════════════════

originalTool("perception_status", "Get continuous perception status: multi-rate loop stats, freshness of AX/CDP/vision sources, and event counts.", {
}, async () => {
  const stats = perceptionManager.getStats();
  const freshness = perceptionManager.getFreshnessSummary();

  const lines = [
    freshness,
    `Running: ${perceptionManager.isRunning}`,
  ];

  if (stats.started) {
    lines.push(`Started: ${stats.startedAt}`);
    lines.push("");
    const pcConfig = perceptionManager.getConfig();
    lines.push("Loop cycles:");
    lines.push(`  Fast  (${pcConfig?.fastIntervalMs ?? 100}ms): ${stats.fastCycles} cycles`);
    lines.push(`  Medium (${pcConfig?.mediumIntervalMs ?? 500}ms): ${stats.mediumCycles} cycles`);
    lines.push(`  Slow  (${pcConfig?.slowIntervalMs ?? 2000}ms): ${stats.slowCycles} cycles`);
    lines.push("");
    lines.push("Events processed:");
    lines.push(`  AX events: ${stats.axEventsProcessed}`);
    lines.push(`  AX tree polls: ${stats.axTreePolls}`);
    lines.push(`  CDP mutations: ${stats.cdpMutationsProcessed}`);
    lines.push(`  CDP snapshots: ${stats.cdpSnapshots}`);
    lines.push(`  Vision diffs: ${stats.visionDiffs}`);
    lines.push(`  Vision OCRs: ${stats.visionOCRs}`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("world_state", "Get what's currently on screen: focused app, windows, controls, dialogs, scroll position. Call this to verify UI state before acting. Use verbose=true to see all controls with roles/labels/positions. Works best after perception_start() which keeps it continuously updated.", {
  verbose: z.boolean().optional().default(false).describe("Dump all controls with roles, labels, positions, and confidence"),
}, async ({ verbose }: { verbose?: boolean | undefined }) => {
  const state = worldModel.getState();
  const summary = worldModel.toSummary();
  const focused = worldModel.getFocusedWindow();
  const dialogs = worldModel.getActiveDialogs();

  const lines: string[] = [];

  // Warn when world model is empty
  if (state.windows.size === 0 && !state.focusedApp) {
    if (!perceptionManager.isRunning) {
      lines.push("Warning: World model is empty. Run perception_start or use focus()/ui_tree to populate state.");
    } else {
      lines.push("World model is empty — perception is running but no data received yet.");
    }
    lines.push("");
  }
  lines.push(summary);
  if (focused) {
    lines.push(`\nFocused window: "${focused.title.value}" (id=${focused.windowId}, ${focused.controls.size} controls, confidence=${focused.title.confidence.toFixed(2)})`);
  }
  if (dialogs.length > 0) {
    lines.push("\nActive dialogs:");
    for (const d of dialogs) {
      lines.push(`  - ${d.type}: "${d.title}" (${d.controls.size} controls, detected ${d.detectedAt})`);
    }
  }
  lines.push(`\nSession: ${state.sessionId || "(not initialized)"}`);

  // Show browser domain state (URL, title, tabs) if available
  for (const [bid, domain] of state.appDomains) {
    if (domain.family === "browser") {
      const bs = domain as import("./src/state/types.js").BrowserState;
      if (bs.url?.value || bs.title?.value) {
        lines.push(`\nBrowser (${bid}):`);
        if (bs.url?.value) lines.push(`  URL: ${bs.url.value}`);
        if (bs.title?.value) lines.push(`  Title: ${bs.title.value}`);
        if (bs.tabs && bs.tabs.length > 0) {
          lines.push(`  Tabs (${bs.tabs.length}):`);
          for (const tab of bs.tabs) {
            lines.push(`    ${tab.index}. ${tab.isActive ? "▸ " : "  "}${tab.title} | ${tab.url}`);
          }
        }
      }
    }
  }

  // Show tracked entities
  const entities = worldModel.getTrackedEntities();
  if (entities.size > 0) {
    lines.push(`\nTracked entities (${entities.size}):`);
    for (const entity of entities.values()) {
      const lastPos = entity.positions[entity.positions.length - 1];
      const posStr = lastPos ? `(${lastPos.x},${lastPos.y})` : "";
      lines.push(`  - ${entity.type}: "${entity.label}" ${posStr} (seen ${entity.positions.length}x, since ${entity.firstSeen})`);
    }
  }

  if (verbose) {
    lines.push("\n── ALL CONTROLS ──");
    for (const [winId, win] of state.windows) {
      lines.push(`\nWindow ${winId}: "${win.title.value}" (${win.bundleId ?? "?"})`);
      if (win.focusedElement) {
        lines.push(`  Focused: ${win.focusedElement.role} "${win.focusedElement.label.value}" @ (${win.focusedElement.position.x}, ${win.focusedElement.position.y})`);
      }

      // Group by role for readability
      const byRole = new Map<string, Array<{ label: string; pos: string; size: string; conf: string; focused: boolean }>>();
      for (const ctrl of win.controls.values()) {
        const role = ctrl.role;
        if (!byRole.has(role)) byRole.set(role, []);
        byRole.get(role)!.push({
          label: ctrl.label.value || "(no label)",
          pos: `${Math.round(ctrl.position.x)},${Math.round(ctrl.position.y)}`,
          size: `${ctrl.size.width}x${ctrl.size.height}`,
          conf: ctrl.label.confidence.toFixed(2),
          focused: ctrl.focused,
        });
      }

      for (const [role, controls] of [...byRole.entries()].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`  [${role}] (${controls.length})`);
        for (const c of controls.slice(0, 50)) {
          const focus = c.focused ? " *FOCUSED*" : "";
          lines.push(`    "${c.label}" @ (${c.pos}) ${c.size} conf=${c.conf}${focus}`);
        }
        if (controls.length > 50) lines.push(`    ... +${controls.length - 50} more`);
      }
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("world_state_diff", "Get stale UI controls that haven't been refreshed within a threshold. Useful for finding controls whose state may be outdated.", {
  thresholdMs: z.number().optional().describe("Stale threshold in ms (default: 5 minutes)"),
}, async ({ thresholdMs }) => {
  const stale = worldModel.getStaleControls(thresholdMs);
  if (stale.length === 0) {
    // Distinguish "no data" from "all fresh"
    const totalControls = Array.from(worldModel.getState().windows.values()).reduce((sum, w) => sum + w.controls.size, 0);
    if (totalControls === 0) {
      const hint = perceptionManager.isRunning
        ? "Perception is running but no controls tracked yet."
        : "Run perception_start or ui_tree to populate state.";
      return { content: [{ type: "text" as const, text: `World model has no tracked controls. ${hint}` }] };
    }
    return { content: [{ type: "text" as const, text: "No stale controls — all state is fresh." }] };
  }
  const lines = [`${stale.length} stale control(s):`];
  for (const c of stale.slice(0, 20)) {
    const age = Math.round((Date.now() - new Date(c.value.updatedAt).getTime()) / 1000);
    lines.push(`  ${c.stableId} ${c.role} "${c.label.value}" — ${age}s old`);
  }
  if (stale.length > 20) lines.push(`  ... and ${stale.length - 20} more`);
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("learning_status", "See what ScreenHand has learned about an app: which selectors work best, which recovery strategies succeed, optimal timing budgets, and sensor preferences. Learning happens automatically — every tool call teaches the system. Use this to inspect learned knowledge or debug why something isn't working.", {
  bundleId: z.string().optional().describe("App bundle ID to query (default: currently focused app)"),
}, async ({ bundleId }: { bundleId?: string | undefined }) => {
  const bid = bundleId ?? worldModel.getState().focusedApp?.bundleId ?? "unknown";
  const summary = learningEngine.getAppSummary(bid);

  const lines = [
    `Learning stats for ${bid}:`,
    `  Locator entries: ${summary.locatorEntries}`,
    `  Recovery entries: ${summary.recoveryEntries}`,
    `  Timing samples: ${summary.timingSamples}`,
    `  Sensor entries: ${summary.sensorEntries}`,
  ];

  if (summary.topLocatorMethod) {
    lines.push(`  Best locator method: ${summary.topLocatorMethod}`);
  }
  if (summary.topSensor) {
    lines.push(`  Best sensor: ${summary.topSensor}`);
  }

  lines.push("");
  lines.push("Adaptive budgets:");
  lines.push(`  Locate: ${summary.adaptiveBudget.locateMs}ms`);
  lines.push(`  Act: ${summary.adaptiveBudget.actMs}ms`);
  lines.push(`  Verify: ${summary.adaptiveBudget.verifyMs}ms`);

  const sensors = learningEngine.rankSensors(bid);
  if (sensors.length > 0) {
    lines.push("");
    lines.push("Sensor ranking:");
    for (const s of sensors) {
      lines.push(`  ${s.sourceType}: score=${s.score.toFixed(3)}, avg=${Math.round(s.avgLatencyMs)}ms`);
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// ── Perception lifecycle ──

originalTool("perception_start", "Start continuous screen monitoring — ScreenHand will constantly track what's on screen (UI changes, new dialogs, element positions) and update world_state automatically. Call BEFORE complex multi-step workflows. 3-rate loop: FAST (100ms AX events), MEDIUM (300ms full tree), SLOW (1000ms visual OCR). Call perception_stop() when done.", {
  bundleId: z.string().optional().describe("Optional: specify app bundle ID directly instead of using focused app"),
}, async ({ bundleId: overrideBundleId }: { bundleId?: string | undefined }) => {
  // Already running check
  if (perceptionManager.isRunning && !overrideBundleId) {
    const stats = perceptionManager.getStats();
    return { content: [{ type: "text" as const, text: `Perception already running (started ${stats.startedAt}). Use perception_stop first to restart, or pass bundleId to switch target.` }] };
  }

  let app = worldModel.getState().focusedApp;

  // Validate bundleId format before it touches AppleScript/exec
  if (overrideBundleId && !/^[a-zA-Z0-9._-]+$/.test(overrideBundleId)) {
    return { content: [{ type: "text" as const, text: "Error: Invalid bundleId format. Only alphanumeric characters, dots, hyphens, and underscores are allowed." }] };
  }

  // If bundleId override provided, try to resolve app info via bridge or AppleScript
  if (overrideBundleId && (!app || app.bundleId !== overrideBundleId)) {
    try {
      await ensureBridge();
      const apps = await bridge.call<any[]>("app.list", {});
      const found = apps?.find((a: any) => a.bundleId === overrideBundleId);
      if (found) {
        app = { bundleId: overrideBundleId, appName: found.name ?? overrideBundleId, pid: found.pid };
        worldModel.updateFocusedApp({ bundleId: overrideBundleId, appName: found.name ?? overrideBundleId, pid: found.pid, windowTitle: "" });
      }
    } catch { /* Bridge unavailable — fall through to AppleScript */ }

    // AppleScript fallback: bridge may not list windowless apps (e.g. freshly launched/killed TextEdit)
    if (!app || app.bundleId !== overrideBundleId) {
      try {
        const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to get unix id of (first process whose bundle identifier is "${overrideBundleId.replace(/'/g, "'\\''")}")'`, { encoding: "utf-8", timeout: 5000 });
        const pid = parseInt((stdout ?? "").trim(), 10);
        if (!isNaN(pid)) {
          app = { bundleId: overrideBundleId, appName: overrideBundleId, pid };
          worldModel.updateFocusedApp({ bundleId: overrideBundleId, appName: overrideBundleId, pid, windowTitle: "" });
        }
      } catch { /* AppleScript also failed — app truly not running */ }
    }
  }

  // If bundleId was explicitly provided but we couldn't find the app, error out
  // instead of silently falling back to the frontmost app
  if (overrideBundleId && (!app || app.bundleId !== overrideBundleId)) {
    return { content: [{ type: "text" as const, text: `Error: App with bundleId "${overrideBundleId}" is not running. Launch it first with launch(bundleId: "${overrideBundleId}").` }] };
  }

  // If still no app, try AppleScript to detect frontmost app
  if (!app) {
    try {
      const asScript = `tell application "System Events"
set fp to first process whose frontmost is true
return (bundle identifier of fp) & "|" & (name of fp) & "|" & (unix id of fp)
end tell`;
      const { stdout: asOut } = await execAsync(`osascript -e '${asScript.replace(/'/g, "'\\''")}'`, { encoding: "utf-8", timeout: 5000 });
      const result = asOut ?? "";
      const [bid, name, pidStr] = result.trim().split("|");
      const pid = parseInt(pidStr ?? "", 10);
      if (bid && !isNaN(pid)) {
        app = { bundleId: bid, appName: name ?? bid, pid };
        worldModel.updateFocusedApp({ bundleId: bid, appName: name ?? bid, pid, windowTitle: "" });
      }
    } catch { /* AppleScript fallback failed */ }
  }

  if (!app) {
    return { content: [{ type: "text" as const, text: "Error: No focused app detected. Focus an app with focus() first, or pass bundleId directly." }] };
  }

  let bridgeAvailable = false;
  try {
    await ensureBridge();
    bridgeAvailable = true;
  } catch { /* bridge unavailable — proceed without AX/vision */ }

  let windowId: number | undefined;
  if (bridgeAvailable) {
    try { windowId = await resolveWindowId(app.pid); } catch { /* best-effort */ }
  }

  const ctx = { bundleId: app.bundleId, appName: app.appName, pid: app.pid, windowTitle: "", ...(windowId != null ? { windowId } : {}) };
  await perceptionManager.ensureStarted(ctx);

  // Auto-connect CDP for browser apps — pass a connect factory so the
  // perception coordinator can reconnect when the WebSocket drops
  let cdpStatus = "skipped (not browser)";
  const isBrowser = isBrowserApp();
  console.error(`[perception_start] app=${app.bundleId} pid=${app.pid} windowId=${windowId} isBrowser=${isBrowser}`);
  if (isBrowser) {
    try {
      console.error("[perception_start] calling ensureCDP...");
      const { CDP: cdp, port } = await ensureCDP();
      console.error(`[perception_start] ensureCDP ok, port=${port}`);
      const connectFn = async () => {
        const targets = await cdp.List({ port });
        const page = targets.find((t: any) => t.type === "page");
        if (!page) throw new Error("No CDP page target");
        return cdp({ port, target: page.id });
      };
      const client = await connectFn();
      console.error(`[perception_start] CDP client created, client keys: ${Object.keys(client).slice(0, 5).join(",")}`);
      const coordinator = perceptionManager.getCoordinator();
      console.error(`[perception_start] coordinator exists: ${!!coordinator}, isRunning: ${coordinator?.isRunning}`);
      if (coordinator) {
        coordinator.activateCDP(client, connectFn);
        cdpStatus = `connected (port ${port})`;
      } else {
        cdpStatus = "no coordinator";
      }
    } catch (e: any) {
      cdpStatus = `failed: ${e?.message ?? e}`;
      console.error(`[perception_start] CDP error: ${cdpStatus}`);
    }
  }
  console.error(`[perception_start] CDP status: ${cdpStatus}`);

  // Set up Safari browser enricher (or clear it for non-Safari)
  installSafariEnricher(app.bundleId);

  return { content: [{ type: "text" as const, text: `Perception started for ${app.bundleId} (${app.appName}). CDP: ${cdpStatus}` }] };
});

originalTool("perception_stop", "Stop continuous perception loop.", {
}, async () => {
  if (!perceptionManager.isRunning) {
    return { content: [{ type: "text" as const, text: "Perception was not running." }] };
  }
  const stats = perceptionManager.getStats();
  await perceptionManager.stop();
  const lines = ["Perception stopped."];
  if (stats.started) {
    lines.push(`Processed: ${stats.axEventsProcessed} AX events, ${stats.cdpSnapshots} CDP snapshots, ${stats.visionDiffs} vision diffs, ${stats.visionOCRs} OCRs.`);
    lines.push(`Cycles: ${stats.fastCycles} fast, ${stats.mediumCycles} medium, ${stats.slowCycles} slow.`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// ── Plan lifecycle ──

originalTool("plan_cancel", "Cancel an active goal, marking it as failed.", {
  goalId: z.string().describe("Goal ID to cancel"),
}, async ({ goalId }: { goalId: string }) => {
  const goal = goalStore.get(goalId);
  if (!goal) {
    return { content: [{ type: "text" as const, text: `Goal not found: ${goalId}` }] };
  }
  goal.status = "failed";
  goal.completedAt = new Date().toISOString();
  goalStore.update(goalId, goal);
  return { content: [{ type: "text" as const, text: `Goal cancelled: ${goalId}` }] };
});

// ── Recovery status + configure ──

originalTool("recovery_status", "Check self-healing status: active cooldowns, cached recovery strategies, and learning engine connection. Recovery is automatic — when tools fail, ScreenHand tries alternative approaches (AX → CDP → OCR → coordinates). Use this to understand why recovery succeeded or failed.", {
}, async () => {
  const status = recoveryEngine.getStatus();
  const lines = [
    "Recovery Engine Status:",
    `  Active cooldowns: ${status.cooldownCount}`,
    `  Reference cache entries: ${status.referenceCacheSize}`,
    `  Learning engine connected: ${status.learningEngineConnected}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("recovery_configure", "Tune self-healing behavior: set max recovery time and max strategies to try when a tool fails. Default: tries multiple approaches within a time budget. Increase for critical actions, decrease for speed.", {
  maxRecoveryTimeMs: z.number().optional().describe("Max time for recovery attempts in ms"),
  maxStrategies: z.number().optional().describe("Max number of strategies to try"),
}, async ({ maxRecoveryTimeMs, maxStrategies }: { maxRecoveryTimeMs?: number | undefined; maxStrategies?: number | undefined }) => {
  const updates: Record<string, unknown> = {};
  if (maxRecoveryTimeMs !== undefined) updates.maxRecoveryTimeMs = maxRecoveryTimeMs;
  if (maxStrategies !== undefined) updates.maxStrategies = maxStrategies;
  recoveryEngine.configure(updates as any);
  return { content: [{ type: "text" as const, text: `Recovery config updated: ${JSON.stringify(updates)}` }] };
});

// ── Learning lifecycle ──

originalTool("learning_reset", "Clear ALL learning data (locators, recovery, timing, sensors). Requires confirm=true.", {
  confirm: z.boolean().describe("Must be true to proceed"),
}, async ({ confirm }: { confirm: boolean }) => {
  if (!confirm) {
    return { content: [{ type: "text" as const, text: "Aborted: set confirm=true to clear all learning data." }] };
  }
  learningEngine.reset();
  return { content: [{ type: "text" as const, text: "All learning data cleared and flushed to disk." }] };
});

// ═══════════════════════════════════════════════
// ORCHESTRATOR — multi-agent task routing
// ═══════════════════════════════════════════════

const ORCHESTRATOR_DAEMON_SCRIPT = path.resolve(__dirname, "scripts", "orchestrator-daemon.ts");

server.tool("orchestrator_start", "Start the multi-agent orchestrator daemon. Manages parallel worker slots: web tasks (CDP) run in parallel, native tasks (AX/keyboard) are serialized per-app. Survives restarts.", {
  webSlots: z.number().optional().describe("Number of parallel web worker slots (default: 4)"),
  nativeSlots: z.number().optional().describe("Number of native worker slots (default: 1)"),
  pollMs: z.number().optional().describe("Poll interval in ms (default: 1000)"),
}, async ({ webSlots, nativeSlots, pollMs }) => {
  const existingPid = getOrchestratorPid();
  if (existingPid !== null) {
    return { content: [{ type: "text" as const, text: `Orchestrator already running (pid=${existingPid}). Use orchestrator_stop first.` }] };
  }

  const compiledPath = fs.existsSync(path.resolve(__dirname, "scripts", "orchestrator-daemon.js"))
    ? path.resolve(__dirname, "scripts", "orchestrator-daemon.js")
    : path.resolve(__dirname, "dist", "scripts", "orchestrator-daemon.js");

  const daemonArgs: string[] = [];
  let child;
  let usedCompiled = false;

  if (fs.existsSync(compiledPath)) {
    daemonArgs.push(compiledPath);
    if (webSlots) daemonArgs.push("--web-slots", String(webSlots));
    if (nativeSlots) daemonArgs.push("--native-slots", String(nativeSlots));
    if (pollMs) daemonArgs.push("--poll", String(pollMs));
    child = spawn("node", daemonArgs, { detached: true, stdio: "ignore", cwd: __dirname });
    usedCompiled = true;
  } else {
    daemonArgs.push("tsx", ORCHESTRATOR_DAEMON_SCRIPT);
    if (webSlots) daemonArgs.push("--web-slots", String(webSlots));
    if (nativeSlots) daemonArgs.push("--native-slots", String(nativeSlots));
    if (pollMs) daemonArgs.push("--poll", String(pollMs));
    child = spawn("npx", daemonArgs, { detached: true, stdio: "ignore", cwd: __dirname });
  }
  child.unref();

  await new Promise((r) => setTimeout(r, 3000));

  const verifyPid = getOrchestratorPid();
  if (!verifyPid) {
    return { content: [{ type: "text" as const, text: `Orchestrator failed to start (mode=${usedCompiled ? "compiled" : "tsx"}).\nCheck log: ${ORCH_LOG_FILE}` }] };
  }

  return { content: [{ type: "text" as const, text: `Orchestrator started (pid=${verifyPid}).\nWeb slots: ${webSlots ?? 4} (parallel CDP) | Native slots: ${nativeSlots ?? 1} (serialized per-app)\nPoll: ${pollMs ?? 1000}ms\nLog: ${ORCH_LOG_FILE}\n\nSubmit tasks with orchestrator_submit. Web tasks run in parallel, native tasks queue per-app.` }] };
});

server.tool("orchestrator_stop", "Stop the orchestrator daemon. Running tasks finish before exit.", {}, async () => {
  const pid = getOrchestratorPid();
  if (!pid) {
    return { content: [{ type: "text" as const, text: "No orchestrator daemon running." }] };
  }
  try {
    process.kill(pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
    return { content: [{ type: "text" as const, text: `Orchestrator stopped (pid=${pid}).` }] };
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Failed to stop: ${err.message}` }] };
  }
});

server.tool("orchestrator_submit", "Submit a task to the orchestrator. Web tasks (CDP) run in parallel, native tasks queue per-app. Returns immediately — task is processed asynchronously.", {
  task: z.string().describe("What to do"),
  mode: z.enum(["web", "native", "mixed"]).optional().describe("Execution mode: web (parallel CDP), native (serialized AX/keyboard), mixed (default: auto-detect)"),
  playbookId: z.string().optional().describe("Playbook to execute"),
  bundleId: z.string().optional().describe("Target app bundle ID (required for native tasks)"),
  windowId: z.number().optional().describe("Target window ID"),
  vars: z.record(z.string(), z.string()).optional().describe("Variables for playbook substitution"),
  priority: z.number().optional().describe("Priority: lower = higher (default: 10)"),
}, async ({ task, mode, playbookId, bundleId, windowId, vars, priority }) => {
  const state = readOrchState();
  if (!state?.running) {
    return { content: [{ type: "text" as const, text: "Orchestrator not running. Use orchestrator_start first." }] };
  }

  const newTask = createOrchestratorTask(task, {
    mode: mode ?? detectMode(playbookId, bundleId),
    ...(playbookId !== undefined ? { playbookId } : {}),
    ...(bundleId !== undefined ? { bundleId } : {}),
    ...(windowId !== undefined ? { windowId } : {}),
    ...(vars ? { vars } : {}),
    ...(priority !== undefined ? { priority } : {}),
  });

  state.tasks.push(newTask);
  state.totalSubmitted++;
  writeOrchState(state);

  const slotInfo = newTask.mode === "web"
    ? `→ will run on next free web slot (${state.webSlots} available)`
    : `→ will run on native slot (serialized for ${bundleId ?? "unknown app"})`;

  return { content: [{ type: "text" as const, text: `Task submitted: ${newTask.id}\nMode: ${newTask.mode} ${slotInfo}\nPriority: ${newTask.priority}\n\nThe orchestrator will pick it up on the next poll cycle.` }] };
});

server.tool("orchestrator_status", "Get orchestrator status — worker slots, task queue, active/completed tasks.", {}, async () => {
  const state = readOrchState();
  if (!state) {
    return { content: [{ type: "text" as const, text: "Orchestrator not running. Use orchestrator_start first." }] };
  }

  const lines = [
    `Running: ${state.running}${state.pid ? ` (pid=${state.pid})` : ""}`,
    `Started: ${state.startedAt}`,
    `Slots: ${state.webSlots} web (parallel) + ${state.nativeSlots} native (per-app serial)`,
    "",
    "Workers:",
  ];

  for (const w of state.workers) {
    const status = w.busy ? `BUSY → ${w.currentTaskId}` : "idle";
    lines.push(`  [${w.id}] ${w.type} — ${status} (done: ${w.tasksCompleted}, failed: ${w.tasksFailed})`);
  }

  const queued = state.tasks.filter(t => t.status === "queued");
  const running = state.tasks.filter(t => t.status === "running" || t.status === "assigned");
  const done = state.tasks.filter(t => t.status === "done");
  const failed = state.tasks.filter(t => t.status === "failed");
  const blocked = state.tasks.filter(t => t.status === "blocked");

  lines.push("", `Tasks: ${state.totalSubmitted} submitted, ${state.totalCompleted} done, ${state.totalFailed} failed`);
  lines.push(`Queue: ${queued.length} queued, ${running.length} running, ${blocked.length} blocked`);

  if (running.length > 0) {
    lines.push("", "Running:");
    for (const t of running) {
      lines.push(`  ${t.id}: "${t.task.slice(0, 60)}" [${t.mode}] → slot ${t.assignedWorker}`);
    }
  }

  if (queued.length > 0) {
    lines.push("", `Queued (next ${Math.min(queued.length, 5)}):`);
    for (const t of queued.slice(0, 5)) {
      lines.push(`  ${t.id}: "${t.task.slice(0, 60)}" [${t.mode}] priority=${t.priority}`);
    }
  }

  if (done.length > 0) {
    lines.push("", `Recent completed (last ${Math.min(done.length, 5)}):`);
    for (const t of done.slice(-5)) {
      lines.push(`  ${t.id}: "${t.task.slice(0, 60)}" → ${t.result?.slice(0, 80) ?? "ok"}`);
    }
  }

  if (failed.length > 0) {
    lines.push("", `Recent failed (last ${Math.min(failed.length, 3)}):`);
    for (const t of failed.slice(-3)) {
      lines.push(`  ${t.id}: "${t.task.slice(0, 60)}" → ${t.error?.slice(0, 80) ?? "unknown"}`);
    }
  }

  if (Object.keys(state.nativeLocks).length > 0) {
    lines.push("", "Native app locks:");
    for (const [app, slot] of Object.entries(state.nativeLocks)) {
      lines.push(`  ${app} → slot ${slot}`);
    }
  }

  lines.push("", `Log: ${ORCH_LOG_FILE}`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// Helper aliases to keep tool code concise
import { readOrchestratorState as readOrchState, writeOrchestratorState as writeOrchState, getOrchestratorDaemonPid as getOrchestratorPid, createTask as createOrchestratorTask, detectTaskMode as detectMode } from "./src/orchestrator/state.js";
import { ORCHESTRATOR_LOG_FILE as ORCH_LOG_FILE } from "./src/orchestrator/types.js";

// ═══════════════════════════════════════════════
// OBSERVER — background app-level visual monitor
// ═══════════════════════════════════════════════

const OBSERVER_DAEMON_SCRIPT = path.resolve(__dirname, "scripts", "observer-daemon.ts");

server.tool("observer_start", "Start the observer daemon to continuously watch an app window. Captures frames via CGWindowListCreateImage, runs OCR only when pixels change, detects popups. Zero overhead on engine — reads a JSON file.", {
  bundleId: z.string().describe("Bundle ID of the app to watch (e.g. com.blackmagic-design.DaVinciResolve)"),
  windowId: z.number().describe("Window ID to capture (get from the 'windows' tool)"),
  intervalMs: z.number().optional().describe("Capture interval in ms (default: 2000). Lower = more responsive but more CPU"),
}, async ({ bundleId, windowId, intervalMs }) => {
  const existingPid = getObserverDaemonPid();
  if (existingPid !== null) {
    return { content: [{ type: "text" as const, text: `Observer daemon already running (pid=${existingPid}). Use observer_stop first.` }] };
  }

  const compiledPath = fs.existsSync(path.resolve(__dirname, "scripts", "observer-daemon.js"))
    ? path.resolve(__dirname, "scripts", "observer-daemon.js")
    : path.resolve(__dirname, "dist", "scripts", "observer-daemon.js");

  const daemonArgs: string[] = [];
  let child;
  let usedCompiled = false;

  if (fs.existsSync(compiledPath)) {
    daemonArgs.push(compiledPath, "--bundleId", bundleId, "--windowId", String(windowId));
    if (intervalMs) daemonArgs.push("--interval", String(intervalMs));
    child = spawn("node", daemonArgs, { detached: true, stdio: "ignore", cwd: __dirname });
    usedCompiled = true;
  } else {
    daemonArgs.push("tsx", OBSERVER_DAEMON_SCRIPT, "--bundleId", bundleId, "--windowId", String(windowId));
    if (intervalMs) daemonArgs.push("--interval", String(intervalMs));
    child = spawn("npx", daemonArgs, { detached: true, stdio: "ignore", cwd: __dirname });
  }
  child.unref();

  await new Promise((r) => setTimeout(r, 2000));

  const verifyPid = getObserverDaemonPid();
  if (!verifyPid) {
    return { content: [{ type: "text" as const, text: `Observer daemon failed to start (mode=${usedCompiled ? "compiled" : "tsx"}).\nCheck log: ${OBSERVER_LOG_FILE}` }] };
  }

  // Enable popup checks in the playbook engine (lazy-init if needed)
  if (!activePlaybookEngine) {
    getJobRunner(); // initializes activePlaybookEngine as a side effect
  }
  if (activePlaybookEngine) activePlaybookEngine.setPopupCheck(true);

  return { content: [{ type: "text" as const, text: `Observer daemon started (pid=${verifyPid}).\nWatching: ${bundleId} (window ${windowId})\nInterval: ${intervalMs ?? 2000}ms\nLog: ${OBSERVER_LOG_FILE}\n\nPopup auto-dismiss enabled in playbook engine.\nUse observer_status to check frames/popups.` }] };
});

server.tool("observer_stop", "Stop the observer daemon.", {}, async () => {
  const pid = getObserverDaemonPid();
  if (!pid) {
    return { content: [{ type: "text" as const, text: "No observer daemon running." }] };
  }
  try {
    process.kill(pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    if (activePlaybookEngine) activePlaybookEngine.setPopupCheck(false);
    return { content: [{ type: "text" as const, text: `Observer daemon stopped (pid=${pid}).` }] };
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Failed to stop: ${err.message}` }] };
  }
});

server.tool("observer_status", "Get observer daemon status — frames captured, OCR text, popup detection.", {}, async () => {
  const state = readObserverState();
  if (!state) {
    return { content: [{ type: "text" as const, text: "Observer not running. Use observer_start to begin watching an app." }] };
  }

  const lines = [
    `Running: ${state.running}${state.pid ? ` (pid=${state.pid})` : ""}`,
    `Watching: ${state.bundleId} (window ${state.windowId})`,
    `Interval: ${state.intervalMs}ms`,
    `Frames: ${state.framesCaptured} captured, ${state.framesChanged} changed, ${state.ocrRuns} OCR runs`,
  ];

  if (state.lastFrame) {
    lines.push(`Last frame: ${state.lastFrame.capturedAt} (changed: ${state.lastFrame.changed})`);
    const ocrPreview = state.lastFrame.ocrText.substring(0, 500);
    lines.push(`OCR text (first 500 chars):\n${ocrPreview}`);
  }

  if (state.popup) {
    lines.push(`\nPOPUP DETECTED: "${state.popup.pattern}"`);
    lines.push(`  Action: ${state.popup.dismissAction}`);
    lines.push(`  Detected: ${state.popup.detectedAt}`);
  }

  if (state.lastError) {
    lines.push(`\nLast error: ${state.lastError}`);
  }

  lines.push(`\nLog: ${OBSERVER_LOG_FILE}`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

server.tool("observer_ocr_roi", "Submit a targeted ROI OCR command to the running observer daemon. The daemon captures the window region, runs OCR, and stores the result. Non-blocking — returns a command ID you can poll with a second call.", {
  x: z.number().describe("X offset of the region (window-relative)"),
  y: z.number().describe("Y offset of the region (window-relative)"),
  width: z.number().describe("Width of the region"),
  height: z.number().describe("Height of the region"),
  windowId: z.number().optional().describe("Window ID (defaults to daemon's watched window)"),
  commandId: z.string().optional().describe("If provided, poll an existing command instead of submitting a new one"),
}, async ({ x, y, width, height, windowId, commandId }) => {
  // Poll mode — check result of a previously submitted command
  if (commandId) {
    const cmd = getObserverCommand(commandId);
    if (!cmd) {
      return { content: [{ type: "text" as const, text: `Command ${commandId} not found.` }] };
    }
    if (cmd.status === "pending" || cmd.status === "running") {
      return { content: [{ type: "text" as const, text: `Command ${commandId}: ${cmd.status} — call again to poll.` }] };
    }
    if (cmd.status === "error") {
      return { content: [{ type: "text" as const, text: `Command ${commandId} failed: ${cmd.error}` }] };
    }
    // done
    const r = cmd.result!;
    const lines = [
      `Command ${commandId}: done at ${r.completedAt}`,
      `Text: ${r.text.substring(0, 1000)}`,
      `Regions: ${r.regions.length}`,
    ];
    for (const region of r.regions.slice(0, 20)) {
      lines.push(`  "${region.text}" @ (${region.bounds.x}, ${region.bounds.y}, ${region.bounds.width}×${region.bounds.height})`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }

  // Submit mode — create a new command
  const pid = getObserverDaemonPid();
  if (!pid) {
    return { content: [{ type: "text" as const, text: "Observer daemon not running. Use observer_start first." }] };
  }

  const cmd: Omit<import("./src/observer/types.js").ObserverCommand, "id" | "status" | "createdAt"> = {
    type: "ocr_roi",
    roi: { x, y, width, height },
  };
  if (windowId !== undefined) cmd.windowId = windowId;
  const id = submitObserverCommand(cmd);

  return { content: [{ type: "text" as const, text: `ROI OCR command submitted: ${id}\nRegion: (${x}, ${y}, ${width}×${height})\nThe daemon will process this on its next cycle. Call observer_ocr_roi with commandId="${id}" to poll the result.` }] };
});

// ═══════════════════════════════════════════════
// PHASE 6: TOOL MASTERY — Ingestion + Community
// ═══════════════════════════════════════════════

server.tool("scan_menu_bar", "Scan an app's menu bar via AX tree. Extracts all menu paths, keyboard shortcuts, and enabled/disabled states. Automatically merges discovered shortcuts into the reference file.", {
  pid: z.number().describe("Process ID of the running app"),
  bundleId: z.string().describe("macOS bundle ID (e.g. com.adobe.Photoshop)"),
  appName: z.string().describe("Human-readable app name (e.g. Photoshop)"),
  mergeToReference: z.boolean().optional().describe("Merge discovered shortcuts into the reference file (default true)"),
}, async ({ pid, bundleId, appName, mergeToReference }) => {
  await ensureBridge();
  const scanner = new MenuScanner(bridge);
  const result = await scanner.scan(pid, bundleId, appName);

  // Auto-merge to reference unless explicitly disabled
  let mergeInfo = "";
  if (mergeToReference !== false) {
    const merge = referenceMerger.mergeMenuScan(result);
    mergeInfo = `\nReference updated: ${merge.filePath} (${merge.added} added, ${merge.updated} updated)`;
  }

  const lines = [
    `Menu scan: ${result.appName} (${result.bundleId})`,
    `Total menus: ${result.totalMenus}, Total items: ${result.totalItems}`,
    `Shortcuts found: ${Object.keys(result.shortcuts).length}`,
    mergeInfo,
    "",
    "Shortcuts:",
  ];

  for (const [menuPath, keys] of Object.entries(result.shortcuts)) {
    // Redact username from menu paths + catch "Log Out <name>" pattern inline
    let safePath = redactUsername(menuPath);
    safePath = safePath.replace(/Log Out [^\n:]+/g, "Log Out [USER]");
    lines.push(`  ${safePath}: ${keys}`);
  }

  // Wire #12: L6→L7 — bootstrap AppMap zones from menu scan
  let bootstrapInfo = "";
  if (appMap) {
    const bootstrapped = appMap.bootstrapFromMenuScan(bundleId, appName, result);
    // Clear hint unconditionally — the scan was attempted regardless of bootstrap outcome
    contextTracker.clearMenuScanHint();
    if (bootstrapped) {
      bootstrapInfo = `\nAppMap: bootstrapped zones from menu structure (new app)`;
    }
  }

  // Wire F8: Seed learning from menu scan shortcuts (L6→L5)
  // Use successCount=5 and score=0.6 so seeds pass recommend() thresholds
  // (minSamples=5 for locators, score > 0.5 for patterns)
  if (learningEngine && result.shortcuts) {
    for (const [menuPath, keys] of Object.entries(result.shortcuts)) {
      const key = LocatorPolicy.makeKey(bundleId, "key");
      learningEngine.locators.seedEntry({
        key, locator: keys as string, method: "ax",
        successCount: 5, failCount: 0, score: 0.6,
        lastUsed: new Date().toISOString(),
      });
      // Also seed as pattern: menu_click with the menu path
      learningEngine.patterns.seedEntry({
        key: `${bundleId}::menu_click::${menuPath}`,
        bundleId, tool: "menu_click", locator: menuPath,
        method: "ax", successCount: 3, failCount: 0, score: 0.6,
        lastSeen: new Date().toISOString(),
      });
    }
  }

  let output = lines.join("\n") + bootstrapInfo;
  output = redactUsername(output);
  output = output.replace(/Log Out [^\n:]+/g, "Log Out [USER]");
  return { content: [{ type: "text" as const, text: output }] };
});

server.tool("ingest_documentation", "Parse a documentation page (HTML, markdown, or text) and extract shortcuts, workflows, and tips. Merges extracted knowledge into the app's reference file.", {
  content: z.string().describe("The documentation content (HTML, markdown, or plain text)"),
  url: z.string().describe("Source URL of the documentation"),
  format: z.enum(["html", "markdown", "text"]).optional().describe("Content format (default html)"),
  bundleId: z.string().describe("macOS bundle ID for the app this documentation covers"),
  appName: z.string().describe("Human-readable app name"),
  mergeToReference: z.boolean().optional().describe("Merge extracted knowledge into reference file (default true)"),
}, async ({ content, url, format, bundleId, appName, mergeToReference }) => {
  const parser = new DocParser();
  const result = parser.parse(content, url, format ?? "html");

  let mergeInfo = "";
  if (mergeToReference !== false) {
    const shortcutMerge = referenceMerger.mergeDocShortcuts(result.shortcuts, bundleId, appName);
    const flowMerge = referenceMerger.mergeDocFlows(result, bundleId, appName);
    mergeInfo = `\nReference updated: ${shortcutMerge.filePath}\n  Shortcuts: ${shortcutMerge.added} added, ${shortcutMerge.updated} updated\n  Flows: ${flowMerge.added} added`;
  }

  const lines = [
    `Documentation parsed: ${result.title}`,
    `Source: ${result.url}`,
    `Shortcuts: ${result.shortcuts.length}, Flows: ${result.flows.length}, Tips: ${result.tips.length}`,
    mergeInfo,
  ];

  if (result.shortcuts.length > 0) {
    lines.push("", "Shortcuts:");
    for (const s of result.shortcuts.slice(0, 30)) {
      lines.push(`  ${s.name}: ${s.keys}${s.category ? ` (${s.category})` : ""}`);
    }
  }

  if (result.flows.length > 0) {
    lines.push("", "Workflows:");
    for (const f of result.flows.slice(0, 10)) {
      lines.push(`  ${f.name} (${f.steps.length} steps)`);
    }
  }

  if (result.tips.length > 0) {
    lines.push("", "Tips:");
    for (const t of result.tips.slice(0, 10)) {
      lines.push(`  - ${t}`);
    }
  }

  // Wire F8: Seed learning from ingested documentation flows (L6→L5)
  if (learningEngine && result.flows) {
    for (const flow of result.flows) {
      for (const step of flow.steps) {
        if (!step.tool) continue;
        const target = (step.params?.text ?? step.params?.title ?? step.params?.target ?? step.description) as string;
        if (target) {
          learningEngine.patterns.seedEntry({
            key: `${bundleId}::${step.tool}::${target}`,
            bundleId, tool: step.tool, locator: String(target),
            method: "ax", successCount: 3, failCount: 0, score: 0.6,
            lastSeen: new Date().toISOString(),
          });
        }
      }
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

server.tool("ingest_tutorial", "Extract structured playbook steps from a video transcript (e.g. YouTube captions). Converts tutorial narration into actionable automation steps with tool mappings.", {
  segments: z.array(z.object({
    text: z.string(),
    startTime: z.number(),
    duration: z.number(),
  })).describe("Transcript segments (text + timing from YouTube captions or similar)"),
  title: z.string().describe("Video title"),
  platform: z.string().describe("Target platform name (e.g. davinci-resolve, figma)"),
}, async ({ segments, title, platform }) => {
  const extractor = new TutorialExtractor();
  const result = extractor.extract(segments as TranscriptSegment[], title, platform);
  const playbookSteps = extractor.toPlaybookSteps(result);

  const lines = [
    `Tutorial extracted: ${result.title}`,
    `Platform: ${result.platform}`,
    `Raw segments: ${result.rawSegments}, Action steps: ${result.actionSegments}`,
    `Playbook-ready steps: ${playbookSteps.length}`,
    "",
    "Steps:",
  ];

  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i]!;
    lines.push(`  ${i + 1}. [${step.tool ?? "?"}] ${step.description}`);
  }

  return {
    content: [{
      type: "text" as const,
      text: lines.join("\n"),
    }],
  };
});

server.tool("coverage_report", "Generate a coverage report for an app — shows what knowledge we have (shortcuts, selectors, flows, playbooks, errors) and identifies gaps with recommendations.", {
  bundleId: z.string().describe("macOS bundle ID (e.g. com.blackmagic-design.DaVinciResolveLite)"),
  appName: z.string().describe("Human-readable app name"),
  includeLiveMenuScan: z.boolean().optional().describe("Also scan the live menu bar for comparison (requires app to be running, needs pid)"),
  pid: z.number().optional().describe("Process ID (required if includeLiveMenuScan is true)"),
}, async ({ bundleId, appName, includeLiveMenuScan, pid }) => {
  let menuScan;
  if (includeLiveMenuScan && pid) {
    await ensureBridge();
    const scanner = new MenuScanner(bridge);
    menuScan = await scanner.scan(pid, bundleId, appName);
  }

  const report = coverageAuditor.audit(bundleId, appName, menuScan);

  const lines = [
    `Coverage Report: ${report.app} (${report.bundleId})`,
    "",
    "Knowledge inventory:",
    `  Shortcuts: ${report.shortcutsKnown}`,
    `  Selectors: ${report.selectorsKnown}`,
    `  Flows: ${report.flowsKnown}`,
    `  Playbooks: ${report.playbooksAvailable}`,
    `  Error patterns: ${report.errorsDocumented}`,
  ];

  if (report.selectorStabilityScore > 0) {
    lines.push(`  Selector stability: ${(report.selectorStabilityScore * 100).toFixed(0)}%`);
  }

  if (report.highValueGaps.length > 0) {
    lines.push("", "High-value gaps:");
    for (const gap of report.highValueGaps) {
      lines.push(`  - ${gap}`);
    }
  }

  if (report.shortcutsNotInReference.length > 0) {
    lines.push("", `Undocumented shortcuts (${report.shortcutsNotInReference.length}):`);
    for (const s of report.shortcutsNotInReference.slice(0, 20)) {
      lines.push(`  ${s}`);
    }
  }

  if (report.workflowsWithNoPlaybook.length > 0) {
    lines.push("", `Missing playbooks for common workflows: ${report.workflowsWithNoPlaybook.join(", ")}`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

originalTool("community_publish", "Publish a validated local playbook to the community repository. Requires the playbook to have been executed successfully multiple times. Strips sensitive data (passwords, file paths).", {
  playbookId: z.string().describe("ID of the local playbook to publish"),
  successRate: z.number().min(0).max(1).describe("Success rate from testing (0.0-1.0)"),
  executionCount: z.number().describe("Number of times the playbook has been executed"),
  minRuns: z.number().optional().describe("Minimum successful runs required (default 3)"),
}, async ({ playbookId, successRate, executionCount }) => {
  // Look up the playbook from the store
  const playbook = _executablePlaybookStore.get(playbookId);
  if (!playbook) {
    return { content: [{ type: "text" as const, text: `Playbook "${playbookId}" not found. Use export_playbook to list available playbooks.` }] };
  }

  // Server enforces minimum of 3 runs using playbook's own tracked data — client values are ignored
  const result = communityPublisher.publish(playbook, successRate, executionCount);
  if (!result) {
    const actualRuns = playbook.successCount + playbook.failCount;
    return { content: [{ type: "text" as const, text: `Playbook not published. Requirements: at least 3 tracked executions and >50% success rate. Actual: ${actualRuns} tracked runs, ${actualRuns > 0 ? ((playbook.successCount / actualRuns) * 100).toFixed(0) : 0}% success.` }] };
  }

  communityFetcher.invalidateCache();
  return { content: [{ type: "text" as const, text: `Published to community: ${result.id}\nName: ${result.name}\nSteps: ${result.steps.length}\nSuccess rate: ${(result.metadata.successRate * 100).toFixed(0)}%` }] };
});

originalTool("community_fetch", "Search community playbooks for a platform or workflow. Returns ranked results by success rate.", {
  platform: z.string().optional().describe("Filter by platform name"),
  bundleId: z.string().optional().describe("Filter by macOS bundle ID"),
  workflow: z.string().optional().describe("Search by workflow name/description"),
  limit: z.number().optional().describe("Max results (default 20)"),
}, async ({ platform, bundleId, workflow, limit }) => {
  const query: import("./src/community/types.js").PlaybookQuery = {};
  if (platform !== undefined) query.platform = platform;
  if (bundleId !== undefined) query.bundleId = bundleId;
  if (workflow !== undefined) query.workflow = workflow;
  if (limit !== undefined) query.limit = limit;
  const results = await communityFetcher.fetchWithRemote(query);

  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: "No community playbooks found matching the query." }] };
  }

  const lines = [`Community playbooks (${results.length} results):`, ""];
  for (const pb of results) {
    lines.push(`  ${pb.id}`);
    lines.push(`    Name: ${pb.name}`);
    lines.push(`    Platform: ${pb.platform} | Steps: ${pb.steps.length}`);
    lines.push(`    Success: ${(pb.metadata.successRate * 100).toFixed(0)}% (${pb.metadata.executionCount} runs)`);
    lines.push(`    Score: ${pb.ratings.score} | By: ${pb.metadata.author}`);
    lines.push("");
  }

  // Wire F9: Import community playbooks into AppMap (L6→L7)
  if (appMap) {
    for (const pb of results) {
      if (pb.bundleId && pb.steps.length > 0) {
        appMap.importFromPlaybook(pb.bundleId, pb.name, pb.steps);
      }
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════

async function main() {
  // Flush playbook learnings on graceful shutdown
  process.on("SIGINT", () => { void perceptionManager.stop(); contextTracker.flush(); learningEngine.flush(); appMap.flush(); process.exit(0); });
  process.on("SIGTERM", () => { void perceptionManager.stop(); contextTracker.flush(); learningEngine.flush(); appMap.flush(); process.exit(0); });
  process.on("beforeExit", () => { void perceptionManager.stop(); contextTracker.flush(); learningEngine.flush(); appMap.flush(); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write("MCP server error: " + err.message + "\n");
  process.exit(1);
});
