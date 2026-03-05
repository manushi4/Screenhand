/**
 * Playbook Recorder v2 — event-driven + screenshot-based
 *
 * Two capture modes running in parallel:
 *
 * 1. AX Event Stream (real-time, ~0ms latency)
 *    - Listens to macOS accessibility notifications via the native bridge
 *    - Captures: focus changes, value changes, window creates, app switches
 *    - This is how we know WHAT the user clicked/typed
 *
 * 2. Periodic Screenshots (every 2s)
 *    - Captures visual state of the screen
 *    - At stop time, AI analyzes the screenshot sequence + AX events
 *    - This is how we handle things AX events miss (Chrome DOM, visual changes)
 *
 * On stop:
 *    - All AX events + screenshots sent to AI
 *    - AI produces clean PlaybookStep[] from the combined data
 *    - Saved to disk as a replayable playbook
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import type { AutomationRuntimeService } from "../runtime/service.js";
import type { AXNode, UIEvent } from "../types.js";
import { PlaybookStore } from "./store.js";
import type { Playbook, PlaybookStep } from "./types.js";

const SCREENSHOT_INTERVAL_MS = 2500;
const AX_POLL_INTERVAL_MS = 500;

interface RawEvent {
  timestamp: string;
  type: "focus_changed" | "value_changed" | "window_created" | "window_closed"
    | "title_changed" | "app_activated" | "menu_opened" | "dialog_appeared"
    | "url_changed" | "click" | "key_combo" | "text_input" | "screenshot" | "unknown";
  details: Record<string, unknown>;
}

interface ScreenshotRecord {
  path: string;
  timestamp: string;
  index: number;
}

export interface RecorderOptions {
  /** AI model for converting events to steps (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Callback for each detected event */
  onEvent?: (event: RawEvent) => void;
  /** Callback for status messages */
  onLog?: (msg: string) => void;
  /** Take screenshots during recording (default: true) */
  screenshots?: boolean;
}

export class PlaybookRecorder {
  private recording = false;
  private events: RawEvent[] = [];
  private screenshots: ScreenshotRecord[] = [];
  private screenshotTimer: ReturnType<typeof setInterval> | null = null;
  private axPollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string = "";

  // Track previous AX state for diff detection
  private prevFocused: string = "";
  private prevActiveApp: string = "";
  private prevWindowTitle: string = "";
  private prevUrl: string = "";
  private prevTextFields: Map<string, string> = new Map();

  private readonly store: PlaybookStore;
  private readonly ai: Anthropic;
  private readonly model: string;
  private readonly log: (msg: string) => void;
  private readonly onEvent: ((event: RawEvent) => void) | undefined;
  private readonly captureScreenshots: boolean;

  constructor(
    private readonly runtime: AutomationRuntimeService,
    playbookDir: string,
    private readonly options: RecorderOptions = {},
  ) {
    this.store = new PlaybookStore(playbookDir);
    this.store.load();
    this.ai = new Anthropic();
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.log = options.onLog ?? ((msg) => console.error(`[Recorder] ${msg}`));
    this.onEvent = options.onEvent;
    this.captureScreenshots = options.screenshots !== false;
  }

  /**
   * Start recording user actions.
   */
  async start(sessionId: string): Promise<void> {
    if (this.recording) {
      this.log("Already recording");
      return;
    }

    this.recording = true;
    this.sessionId = sessionId;
    this.events = [];
    this.screenshots = [];
    this.prevFocused = "";
    this.prevActiveApp = "";
    this.prevWindowTitle = "";
    this.prevUrl = "";
    this.prevTextFields.clear();

    // Take initial state snapshot
    await this.captureState("initial");
    this.log("Recording started — watching for AX events + taking screenshots");

    // Start AX event polling (fast — every 500ms)
    this.axPollTimer = setInterval(async () => {
      if (!this.recording) return;
      try {
        await this.pollAXState();
      } catch { /* non-fatal */ }
    }, AX_POLL_INTERVAL_MS);

    // Start screenshot capture (slower — every 2.5s)
    if (this.captureScreenshots) {
      this.screenshotTimer = setInterval(async () => {
        if (!this.recording) return;
        try {
          await this.takeScreenshot();
        } catch { /* non-fatal */ }
      }, SCREENSHOT_INTERVAL_MS);
    }
  }

  /**
   * Stop recording and generate a playbook.
   */
  async stop(name: string, description: string, platform: string): Promise<Playbook> {
    this.recording = false;
    this.clearTimers();

    // Take final screenshot
    if (this.captureScreenshots) {
      try { await this.takeScreenshot(); } catch { /* ignore */ }
    }

    this.log(`Recording stopped. ${this.events.length} events, ${this.screenshots.length} screenshots captured.`);

    // Convert raw events + screenshots to playbook steps via AI
    const steps = await this.eventsToSteps(this.events, this.screenshots, name, platform);

    // Save as playbook
    const id = `rec_${platform}_${Date.now()}`;
    const playbook: Playbook = {
      id,
      name,
      description,
      platform,
      steps,
      version: "1.0.0",
      tags: [
        platform,
        ...name.toLowerCase().split(/\W+/).filter((w) => w.length >= 3),
      ],
      successCount: 0,
      failCount: 0,
      lastRun: new Date().toISOString(),
    };

    this.store.save(playbook);
    this.log(`Playbook saved: ${id} (${steps.length} steps)`);

    return playbook;
  }

  /**
   * Cancel recording without saving.
   */
  cancel(): void {
    this.recording = false;
    this.clearTimers();
    this.events = [];
    this.screenshots = [];
    this.log("Recording cancelled");
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get eventCount(): number {
    return this.events.length;
  }

  getEvents(): RawEvent[] {
    return [...this.events];
  }

  // ── AX State Polling (fast, event-driven feel) ──

  private async pollAXState(): Promise<void> {
    // 1. Check which app is active
    try {
      const apps = await this.runtime.appList(this.sessionId);
      if (apps.ok) {
        const active = apps.data.find((a) => a.isActive);
        if (active && active.bundleId !== this.prevActiveApp) {
          if (this.prevActiveApp) {
            this.addEvent({
              type: "app_activated",
              details: {
                from: this.prevActiveApp,
                to: active.bundleId,
                appName: active.name,
              },
            });
          }
          this.prevActiveApp = active.bundleId;
        }
      }
    } catch { /* ignore */ }

    // 2. Get accessibility tree — find focused element and text field values
    try {
      const tree = await this.runtime.elementTree({ sessionId: this.sessionId, maxDepth: 4 });
      if (!tree.ok) return;

      // Detect focus change
      const focused = findFocused(tree.data);
      if (focused && focused !== this.prevFocused) {
        this.addEvent({
          type: "focus_changed",
          details: {
            from: this.prevFocused,
            to: focused,
            element: describeFocused(tree.data),
          },
        });
        this.prevFocused = focused;
      }

      // Detect text field value changes (typing detection)
      const currentFields = collectTextFields(tree.data);
      for (const [fieldId, value] of currentFields) {
        const prev = this.prevTextFields.get(fieldId);
        if (prev !== undefined && prev !== value) {
          this.addEvent({
            type: "value_changed",
            details: {
              field: fieldId,
              from: prev.slice(-50),
              to: value.slice(-50),
              typed: value.slice(prev.length),
            },
          });
        }
      }
      this.prevTextFields = currentFields;

      // Detect window title change (navigation in browser)
      const title = tree.data.title ?? "";
      if (title && title !== this.prevWindowTitle) {
        if (this.prevWindowTitle) {
          this.addEvent({
            type: "title_changed",
            details: { from: this.prevWindowTitle, to: title },
          });
        }
        this.prevWindowTitle = title;
      }
    } catch { /* ignore */ }
  }

  // ── Screenshot Capture ──

  private async takeScreenshot(): Promise<void> {
    try {
      const result = await this.runtime.screenshot({ sessionId: this.sessionId });
      if (result.ok) {
        const record: ScreenshotRecord = {
          path: result.data.path,
          timestamp: new Date().toISOString(),
          index: this.screenshots.length,
        };
        this.screenshots.push(record);
      }
    } catch { /* non-fatal */ }
  }

  // ── State Capture ──

  private async captureState(label: string): Promise<void> {
    // Capture initial app state
    try {
      const apps = await this.runtime.appList(this.sessionId);
      if (apps.ok) {
        const active = apps.data.find((a) => a.isActive);
        if (active) {
          this.prevActiveApp = active.bundleId;
          this.addEvent({
            type: "app_activated",
            details: { to: active.bundleId, appName: active.name, label },
          });
        }
      }
    } catch { /* ignore */ }

    // Capture initial tree state
    try {
      const tree = await this.runtime.elementTree({ sessionId: this.sessionId, maxDepth: 4 });
      if (tree.ok) {
        this.prevFocused = findFocused(tree.data);
        this.prevWindowTitle = tree.data.title ?? "";
        this.prevTextFields = collectTextFields(tree.data);
      }
    } catch { /* ignore */ }

    // Take initial screenshot
    if (this.captureScreenshots) {
      await this.takeScreenshot();
    }
  }

  // ── Event Management ──

  private addEvent(partial: Omit<RawEvent, "timestamp">): void {
    const event: RawEvent = {
      ...partial,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    this.log(`Event: ${event.type} — ${JSON.stringify(event.details).slice(0, 120)}`);
    if (this.onEvent) this.onEvent(event);
  }

  private clearTimers(): void {
    if (this.axPollTimer) {
      clearInterval(this.axPollTimer);
      this.axPollTimer = null;
    }
    if (this.screenshotTimer) {
      clearInterval(this.screenshotTimer);
      this.screenshotTimer = null;
    }
  }

  // ── AI Conversion ──

  /**
   * Convert raw events + screenshots into clean playbook steps.
   * Sends first + last screenshot as images so AI can see what happened visually.
   */
  private async eventsToSteps(
    events: RawEvent[],
    screenshots: ScreenshotRecord[],
    taskName: string,
    platform: string,
  ): Promise<PlaybookStep[]> {
    if (events.length === 0) return [];

    // Build the content array — text + optional images
    const content: Anthropic.Messages.ContentBlockParam[] = [];

    // Add text prompt
    content.push({
      type: "text",
      text: `Convert these recorded user events into a clean, replayable automation playbook.

Task: ${taskName}
Platform: ${platform}

Raw events recorded (in chronological order):
${events.map((e, i) => `${i + 1}. [${e.timestamp}] ${e.type}: ${JSON.stringify(e.details)}`).join("\n")}

${screenshots.length > 0 ? `\n${screenshots.length} screenshots were taken during recording. The first and last are attached below for visual context.\n` : ""}
Convert these into a JSON array of playbook steps. Each step:
{
  "action": "navigate" | "press" | "type_into" | "key_combo" | "scroll" | "wait" | "screenshot",
  "target": "CSS selector, text label, or {\"selector\": \"...\"}",
  "url": "for navigate",
  "text": "for type_into",
  "keys": ["for", "key_combo"],
  "ms": 1000,
  "description": "human-readable description of what this step does",
  "verify": "optional CSS selector or text to verify success",
  "optional": false
}

Rules:
- Infer the user's INTENT from events, not just mirror them mechanically
- focus_changed events usually mean a click — convert to "press" with the element label
- value_changed events mean typing — convert to "type_into" with the field and text
- title_changed often means navigation — add appropriate navigate or wait steps
- app_activated means switching apps — use app_focus or app_launch
- Use stable selectors: data-testid, aria-label, role+name over fragile CSS
- Merge rapid consecutive events into single meaningful steps
- Add wait steps (500-2000ms) after navigation/page loads
- Add verify conditions for critical steps (modal opened, page loaded, etc.)
- Skip noise (duplicate events, layout thrash, irrelevant focus changes)

Respond with ONLY a valid JSON array, no markdown fences, no explanation.`,
    });

    // Attach first and last screenshots as images (if available)
    if (screenshots.length > 0) {
      const toAttach = [screenshots[0]!];
      if (screenshots.length > 1) {
        toAttach.push(screenshots[screenshots.length - 1]!);
      }

      for (const shot of toAttach) {
        try {
          const imageData = fs.readFileSync(shot.path);
          const base64 = imageData.toString("base64");
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: base64,
            },
          });
          content.push({
            type: "text",
            text: `Screenshot ${shot.index + 1} taken at ${shot.timestamp}`,
          });
        } catch {
          // Skip unreadable screenshots
        }
      }
    }

    try {
      const resp = await this.ai.messages.create({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      });

      const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const steps = JSON.parse(jsonMatch[0]) as PlaybookStep[];
        this.log(`AI generated ${steps.length} playbook steps`);
        return steps;
      }
    } catch (err) {
      this.log(`AI conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Fallback without AI
    return this.eventsToStepsFallback(events);
  }

  private eventsToStepsFallback(events: RawEvent[]): PlaybookStep[] {
    const steps: PlaybookStep[] = [];

    for (const event of events) {
      switch (event.type) {
        case "app_activated":
          if (event.details.label === "initial") break;
          steps.push({
            action: "wait",
            ms: 500,
            description: `Switched to ${event.details.appName ?? event.details.to}`,
          });
          break;

        case "focus_changed": {
          const target = String(event.details.to ?? "");
          if (!target || target === this.prevFocused) break;
          steps.push({
            action: "press",
            target,
            description: `Click on ${event.details.element ?? target}`,
          });
          break;
        }

        case "value_changed": {
          const typed = String(event.details.typed ?? "");
          const field = String(event.details.field ?? "");
          if (typed) {
            steps.push({
              action: "type_into",
              target: field,
              text: typed,
              description: `Type "${typed.slice(0, 30)}" into ${field}`,
            });
          }
          break;
        }

        case "title_changed":
          steps.push({
            action: "wait",
            ms: 1500,
            description: `Page changed to: ${event.details.to}`,
          });
          break;

        case "url_changed":
          steps.push({
            action: "navigate",
            url: event.details.to as string,
            description: `Navigate to ${event.details.to}`,
          });
          break;

        case "menu_opened":
        case "dialog_appeared":
          steps.push({
            action: "wait",
            ms: 1000,
            description: `${event.type}: ${JSON.stringify(event.details).slice(0, 50)}`,
          });
          break;
      }
    }

    return steps;
  }
}

// ── AX Tree Helpers ──

/** Find the focused element and return a stable identifier. */
function findFocused(node: AXNode, depth = 0): string {
  if (depth > 6) return "";
  if (node.focused === true) {
    const role = node.role?.replace("AX", "") ?? "";
    const label = node.title ?? node.description ?? node.identifier ?? "";
    return `${role}:${label}`;
  }
  if (node.children) {
    for (const child of node.children) {
      const found = findFocused(child, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

/** Get a human-readable description of the focused element + context. */
function describeFocused(node: AXNode, depth = 0): string {
  if (depth > 6) return "";
  if (node.focused === true) {
    const parts = [node.role?.replace("AX", "")];
    if (node.title) parts.push(`"${node.title}"`);
    if (node.description) parts.push(`desc="${node.description}"`);
    if (node.value) parts.push(`val="${node.value.slice(0, 30)}"`);
    if (node.position) parts.push(`@${Math.round(node.position.x)},${Math.round(node.position.y)}`);
    return parts.filter(Boolean).join(" ");
  }
  if (node.children) {
    for (const child of node.children) {
      const found = describeFocused(child, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

/** Collect all text field values from the tree for typing detection. */
function collectTextFields(node: AXNode, depth = 0): Map<string, string> {
  const fields = new Map<string, string>();
  if (depth > 5) return fields;

  const role = node.role?.replace("AX", "").toLowerCase() ?? "";
  const isTextField = role === "textfield" || role === "textarea" || role === "combobox" || role === "searchfield";

  if (isTextField && node.value !== undefined) {
    const id = node.identifier ?? node.title ?? node.description ?? `field_${depth}`;
    fields.set(id, node.value);
  }

  if (node.children) {
    for (const child of node.children) {
      for (const [k, v] of collectTextFields(child, depth + 1)) {
        fields.set(k, v);
      }
    }
  }

  return fields;
}
