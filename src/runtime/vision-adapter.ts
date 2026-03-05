import type {
  AXNode,
  AppContext,
  ExtractFormat,
  LocatedElement,
  PageMeta,
  SessionInfo,
  Target,
  WaitCondition,
} from "../types.js";
import type { AppAdapter } from "./app-adapter.js";
import type { MacOSBridgeClient } from "../native/macos-bridge-client.js";

const POLL_INTERVAL_MS = 200;

interface VisionSessionState {
  info: SessionInfo;
  pid: number;
  bundleId: string;
  appName: string;
  lastScreenshotPath?: string;
}

interface OCRResult {
  text: string;
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Vision-based adapter for apps with poor/no accessibility support.
 * Uses screenshots + OCR to locate elements and CG events to interact.
 */
export class VisionAdapter implements AppAdapter {
  private readonly sessions = new Map<string, VisionSessionState>();
  private readonly sessionsByProfile = new Map<string, VisionSessionState>();

  constructor(private readonly bridge: MacOSBridgeClient) {}

  async attach(profile: string): Promise<SessionInfo> {
    const existing = this.sessionsByProfile.get(profile);
    if (existing) return existing.info;

    await this.bridge.start();

    const frontmost = await this.bridge.call<{ bundleId: string; name: string; pid: number }>(
      "app.frontmost",
    );

    const info: SessionInfo = {
      sessionId: `vision_session_${profile}_${Date.now()}`,
      profile,
      createdAt: new Date().toISOString(),
      adapterType: "vision",
    };

    const state: VisionSessionState = {
      info,
      pid: frontmost.pid,
      bundleId: frontmost.bundleId,
      appName: frontmost.name,
    };

    this.sessions.set(info.sessionId, state);
    this.sessionsByProfile.set(profile, state);
    return info;
  }

  async getAppContext(sessionId: string): Promise<AppContext> {
    const state = this.requireSession(sessionId);
    return {
      bundleId: state.bundleId,
      appName: state.appName,
      pid: state.pid,
      windowTitle: state.appName,
    };
  }

  async getPageMeta(sessionId: string): Promise<PageMeta> {
    const ctx = await this.getAppContext(sessionId);
    return {
      url: `app://${ctx.bundleId}`,
      title: ctx.appName,
    };
  }

  async navigate(sessionId: string, url: string, _timeoutMs: number): Promise<PageMeta> {
    if (url.startsWith("app://")) {
      const bundleId = url.slice(6);
      const result = await this.bridge.call<{ bundleId: string; appName: string; pid: number }>(
        "app.launch",
        { bundleId },
      );
      const state = this.requireSession(sessionId);
      state.pid = result.pid;
      state.bundleId = result.bundleId;
      state.appName = result.appName;
    }
    return this.getPageMeta(sessionId);
  }

  async locate(sessionId: string, target: Target, timeoutMs: number): Promise<LocatedElement | null> {
    const state = this.requireSession(sessionId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Take a screenshot
      const screenshotResult = await this.bridge.call<{ path: string }>(
        "cg.captureScreen",
        {},
      );
      state.lastScreenshotPath = screenshotResult.path;

      const searchText = this.getSearchText(target);
      if (!searchText) {
        // For coordinate targets, just return coordinates directly
        if (target.type === "coordinates") {
          return {
            handleId: `vision_coords_${target.x}_${target.y}`,
            locatorUsed: "vision:coordinates",
            coordinates: { x: target.x, y: target.y, width: 1, height: 1 },
          };
        }
        return null;
      }

      // OCR the screenshot
      const matches = await this.bridge.call<OCRResult[]>("vision.findText", {
        imagePath: screenshotResult.path,
        searchText,
      });

      if (matches.length > 0) {
        const best = matches.reduce((a, b) => (a.confidence > b.confidence ? a : b));
        return {
          handleId: `vision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          locatorUsed: `vision:text:${searchText}`,
          label: best.text,
          coordinates: best.bounds,
        };
      }

      await sleep(POLL_INTERVAL_MS);
    }

    return null;
  }

  async click(_sessionId: string, element: LocatedElement): Promise<void> {
    if (!element.coordinates) {
      throw new Error("Vision adapter requires coordinates to click");
    }
    const cx = element.coordinates.x + element.coordinates.width / 2;
    const cy = element.coordinates.y + element.coordinates.height / 2;
    await this.bridge.call("cg.mouseClick", { x: cx, y: cy });
  }

  async setValue(_sessionId: string, element: LocatedElement, text: string, clear: boolean): Promise<void> {
    // Click to focus
    await this.click(_sessionId, element);
    await sleep(100);

    if (clear) {
      await this.bridge.call("cg.keyCombo", { keys: ["cmd", "a"] });
      await sleep(50);
    }

    await this.bridge.call("cg.typeText", { text });
  }

  async getValue(_sessionId: string, element: LocatedElement): Promise<string> {
    // Vision can't reliably read values; return label if available
    return element.label ?? "";
  }

  async waitFor(sessionId: string, condition: WaitCondition, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (condition.type === "text_appears") {
        const found = await this.locate(
          sessionId,
          { type: "text", value: condition.text },
          200,
        );
        if (found) return true;
      } else if (condition.type === "element_exists") {
        const found = await this.locate(sessionId, condition.target, 200);
        if (found) return true;
      } else if (condition.type === "element_gone") {
        const found = await this.locate(sessionId, condition.target, 200);
        if (!found) return true;
      } else {
        // Unsupported condition types
        return false;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }

  async extract(sessionId: string, _target: Target, format: ExtractFormat): Promise<unknown> {
    const state = this.requireSession(sessionId);

    // Take a fresh screenshot and OCR it
    const screenshotResult = await this.bridge.call<{ path: string }>("cg.captureScreen", {});
    state.lastScreenshotPath = screenshotResult.path;

    const ocrResult = await this.bridge.call<{ text: string; regions: OCRResult[] }>(
      "vision.ocr",
      { imagePath: screenshotResult.path },
    );

    if (format === "text") {
      return ocrResult.text;
    }

    if (format === "json") {
      return ocrResult;
    }

    // table format
    return {
      headers: ["text", "confidence", "x", "y", "width", "height"],
      rows: ocrResult.regions.map((r) => [
        r.text,
        r.confidence,
        r.bounds.x,
        r.bounds.y,
        r.bounds.width,
        r.bounds.height,
      ]),
    };
  }

  async screenshot(_sessionId: string, region?: { x: number; y: number; width: number; height: number }): Promise<string> {
    const result = await this.bridge.call<{ path: string }>(
      "cg.captureScreen",
      region ? { region } : {},
    );
    return result.path;
  }

  async keyCombo(_sessionId: string, keys: string[]): Promise<void> {
    await this.bridge.call("cg.keyCombo", { keys });
  }

  async elementTree(_sessionId: string, _maxDepth?: number, _root?: Target): Promise<AXNode> {
    throw new Error("Vision adapter does not support elementTree — use accessibility adapter");
  }

  // ── Private ──

  private requireSession(sessionId: string): VisionSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    return state;
  }

  private getSearchText(target: Target): string | null {
    switch (target.type) {
      case "text":
        return target.value;
      case "role":
        return target.name;
      case "selector":
        return target.value;
      case "ax_attribute":
        return target.value;
      case "image":
      case "coordinates":
      case "ax_path":
        return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
