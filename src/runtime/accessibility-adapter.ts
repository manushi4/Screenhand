import type {
  AXNode,
  AppContext,
  ExtractFormat,
  LocatedElement,
  PageMeta,
  RunningApp,
  SessionInfo,
  Target,
  WaitCondition,
  WindowInfo,
} from "../types.js";
import type { AppAdapter } from "./app-adapter.js";
import type { MacOSBridgeClient } from "../native/macos-bridge-client.js";
import { toAXRole } from "./ax-role-map.js";

const POLL_INTERVAL_MS = 100;

interface AXSessionState {
  info: SessionInfo;
  pid: number;
  bundleId: string;
  appName: string;
}

interface BridgeElement {
  handleId: string;
  role: string;
  title: string;
  elementPath: number[];
  value?: string;
  identifier?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export class AccessibilityAdapter implements AppAdapter {
  private readonly sessions = new Map<string, AXSessionState>();
  private readonly sessionsByProfile = new Map<string, AXSessionState>();

  constructor(private readonly bridge: MacOSBridgeClient) {}

  async attach(profile: string): Promise<SessionInfo> {
    const existing = this.sessionsByProfile.get(profile);
    if (existing) return existing.info;

    // Ensure bridge is started
    await this.bridge.start();

    // Check accessibility permissions
    const perms = await this.bridge.checkPermissions();
    if (!perms.trusted) {
      throw new Error(
        "Accessibility permission not granted. Go to System Settings → Privacy & Security → Accessibility and enable this app.",
      );
    }

    const info: SessionInfo = {
      sessionId: `ax_session_${profile}_${Date.now()}`,
      profile,
      createdAt: new Date().toISOString(),
      adapterType: "accessibility",
    };

    // Default to frontmost app
    const frontmost = await this.bridge.call<{ bundleId: string; name: string; pid: number }>(
      "app.frontmost",
    );

    const state: AXSessionState = {
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
    // Get window title from AX tree
    let windowTitle = "";
    try {
      const tree = await this.bridge.call<AXNode>("ax.getElementTree", {
        pid: state.pid,
        maxDepth: 1,
      });
      const window = tree.children?.find((c) => c.role === "AXWindow");
      windowTitle = window?.title ?? "";
    } catch {
      // Ignore tree errors
    }

    return {
      bundleId: state.bundleId,
      appName: state.appName,
      pid: state.pid,
      windowTitle,
    };
  }

  async getPageMeta(sessionId: string): Promise<PageMeta> {
    const ctx = await this.getAppContext(sessionId);
    return {
      url: ctx.url ?? `app://${ctx.bundleId}`,
      title: ctx.windowTitle || ctx.appName,
    };
  }

  async navigate(sessionId: string, url: string, _timeoutMs: number): Promise<PageMeta> {
    // For desktop apps, "navigate" means launching/focusing an app by bundle ID
    const state = this.requireSession(sessionId);
    if (url.startsWith("app://")) {
      const bundleId = url.slice(6);
      const result = await this.bridge.call<{ pid: number; appName: string; bundleId: string }>(
        "app.launch",
        { bundleId },
      );
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
      try {
        const params = this.buildFindParams(target, state.pid);
        const result = await this.bridge.call<BridgeElement>("ax.findElement", params);
        if (result) {
          const located: LocatedElement = {
            handleId: result.handleId,
            locatorUsed: `ax:${target.type}`,
            role: result.role,
            label: result.title,
          };
          if (result.bounds) {
            located.coordinates = result.bounds;
          }
          return located;
        }
      } catch {
        // Element not found yet, keep polling
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  async click(sessionId: string, element: LocatedElement): Promise<void> {
    const state = this.requireSession(sessionId);
    const elementPath = this.parseElementPath(element.handleId);

    if (elementPath) {
      await this.bridge.call("ax.performAction", {
        pid: state.pid,
        elementPath,
        action: "AXPress",
      });
    } else if (element.coordinates) {
      // Fallback to coordinate click
      const cx = element.coordinates.x + element.coordinates.width / 2;
      const cy = element.coordinates.y + element.coordinates.height / 2;
      await this.bridge.call("cg.mouseClick", { x: cx, y: cy });
    } else {
      throw new Error("Cannot click: no element path or coordinates");
    }
  }

  async setValue(sessionId: string, element: LocatedElement, text: string, clear: boolean): Promise<void> {
    const state = this.requireSession(sessionId);
    const elementPath = this.parseElementPath(element.handleId);

    if (clear && elementPath) {
      // Try AX value set first
      try {
        await this.bridge.call("ax.setElementValue", {
          pid: state.pid,
          elementPath,
          value: text,
        });
        return;
      } catch {
        // Fallback: click, select all, type
      }
    }

    // Fallback: click to focus, select all if clearing, then type
    await this.click(sessionId, element);
    await sleep(50);
    if (clear) {
      await this.bridge.call("cg.keyCombo", { keys: ["cmd", "a"] });
      await sleep(50);
    }
    await this.bridge.call("cg.typeText", { text });
  }

  async getValue(sessionId: string, element: LocatedElement): Promise<string> {
    const state = this.requireSession(sessionId);
    const elementPath = this.parseElementPath(element.handleId);
    if (!elementPath) return "";

    const result = await this.bridge.call<{ value: string }>("ax.getElementValue", {
      pid: state.pid,
      elementPath,
    });
    return result.value;
  }

  async waitFor(sessionId: string, condition: WaitCondition, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const met = await this.checkCondition(sessionId, condition);
      if (met) return true;
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }

  async extract(sessionId: string, target: Target, format: ExtractFormat): Promise<unknown> {
    const state = this.requireSession(sessionId);

    if (format === "text") {
      // Get element tree and extract text content
      const element = await this.locate(sessionId, target, 1500);
      if (!element) throw new Error("Extract target not found");
      const result = await this.getValue(sessionId, element);
      return result || element.label || "";
    }

    if (format === "json") {
      // Return the AX tree as JSON
      const tree = await this.bridge.call<AXNode>("ax.getElementTree", {
        pid: state.pid,
        maxDepth: 3,
      });
      return tree;
    }

    // table format: return element tree in tabular form
    const tree = await this.bridge.call<AXNode>("ax.getElementTree", {
      pid: state.pid,
      maxDepth: 2,
    });
    return {
      headers: ["role", "title", "value"],
      rows: this.flattenTree(tree).map((n) => [n.role, n.title ?? "", n.value ?? ""]),
    };
  }

  async screenshot(sessionId: string, region?: { x: number; y: number; width: number; height: number }): Promise<string> {
    const state = this.requireSession(sessionId);
    // Get window list to find the window ID for the app
    const windows = await this.bridge.call<WindowInfo[]>("app.windows");
    const appWindow = windows.find((w) => w.pid === state.pid);

    if (appWindow) {
      const result = await this.bridge.call<{ path: string }>(
        "cg.captureWindow",
        { windowId: appWindow.windowId },
      );
      return result.path;
    }

    // Fallback to screen capture with region
    const result = await this.bridge.call<{ path: string }>(
      "cg.captureScreen",
      region ? { region } : {},
    );
    return result.path;
  }

  // ── Desktop-specific methods ──

  async launchApp(sessionId: string, bundleId: string): Promise<AppContext> {
    const state = this.requireSession(sessionId);
    const result = await this.bridge.call<{ bundleId: string; appName: string; pid: number }>(
      "app.launch",
      { bundleId },
    );
    // Update session to track new app
    state.pid = result.pid;
    state.bundleId = result.bundleId;
    state.appName = result.appName;

    return {
      bundleId: result.bundleId,
      appName: result.appName,
      pid: result.pid,
      windowTitle: "",
    };
  }

  async focusApp(sessionId: string, bundleId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    await this.bridge.call("app.focus", { bundleId });
    // Update PID if different app
    if (bundleId !== state.bundleId) {
      const apps = await this.bridge.call<RunningApp[]>("app.list");
      const app = apps.find((a) => a.bundleId === bundleId);
      if (app) {
        state.pid = app.pid;
        state.bundleId = bundleId;
        state.appName = app.name;
      }
    }
  }

  async listApps(_sessionId: string): Promise<RunningApp[]> {
    return this.bridge.call<RunningApp[]>("app.list");
  }

  async listWindows(_sessionId: string): Promise<WindowInfo[]> {
    return this.bridge.call<WindowInfo[]>("app.windows");
  }

  async menuClick(sessionId: string, menuPath: string[]): Promise<void> {
    const state = this.requireSession(sessionId);
    await this.bridge.call("ax.menuClick", { pid: state.pid, menuPath });
  }

  async keyCombo(_sessionId: string, keys: string[]): Promise<void> {
    await this.bridge.call("cg.keyCombo", { keys });
  }

  async elementTree(sessionId: string, maxDepth?: number, _root?: Target): Promise<AXNode> {
    const state = this.requireSession(sessionId);
    return this.bridge.call<AXNode>("ax.getElementTree", {
      pid: state.pid,
      maxDepth: maxDepth ?? 5,
    });
  }

  async drag(sessionId: string, from: LocatedElement, to: LocatedElement): Promise<void> {
    if (!from.coordinates || !to.coordinates) {
      throw new Error("Drag requires elements with coordinates");
    }
    const fromX = from.coordinates.x + from.coordinates.width / 2;
    const fromY = from.coordinates.y + from.coordinates.height / 2;
    const toX = to.coordinates.x + to.coordinates.width / 2;
    const toY = to.coordinates.y + to.coordinates.height / 2;

    await this.bridge.call("cg.mouseDrag", { fromX, fromY, toX, toY });
  }

  async scroll(_sessionId: string, direction: "up" | "down" | "left" | "right", amount: number, element?: LocatedElement): Promise<void> {
    let x = 500;
    let y = 400;

    if (element?.coordinates) {
      x = element.coordinates.x + element.coordinates.width / 2;
      y = element.coordinates.y + element.coordinates.height / 2;
    }

    const deltaMap = {
      up: { deltaX: 0, deltaY: -amount },
      down: { deltaX: 0, deltaY: amount },
      left: { deltaX: -amount, deltaY: 0 },
      right: { deltaX: amount, deltaY: 0 },
    };

    const delta = deltaMap[direction];
    await this.bridge.call("cg.scroll", { x, y, ...delta });
  }

  // ── Private helpers ──

  private requireSession(sessionId: string): AXSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    return state;
  }

  private buildFindParams(target: Target, pid: number): Record<string, unknown> {
    const params: Record<string, unknown> = { pid };

    switch (target.type) {
      case "role":
        params.role = toAXRole(target.role);
        params.title = target.name;
        params.exact = target.exact ?? true;
        break;
      case "text":
        params.title = target.value;
        params.exact = target.exact ?? true;
        break;
      case "selector":
        // For AX, treat selector as an identifier
        params.identifier = target.value;
        break;
      case "ax_path":
        // Direct path resolution handled differently
        params.role = target.path[target.path.length - 1];
        break;
      case "ax_attribute":
        params[target.attribute] = target.value;
        break;
      case "coordinates":
        // Can't find by coordinates via AX, will fallback to vision
        throw new Error("Cannot locate by coordinates using accessibility adapter");
      case "image":
        throw new Error("Cannot locate by image using accessibility adapter");
    }

    return params;
  }

  private parseElementPath(handleId: string): number[] | null {
    // Handle IDs from the bridge are formatted as "ax_0_1_2"
    if (!handleId.startsWith("ax_")) return null;
    const parts = handleId.slice(3).split("_");
    const indices = parts.map(Number).filter((n) => !isNaN(n));
    return indices.length > 0 ? indices : null;
  }

  private async checkCondition(sessionId: string, condition: WaitCondition): Promise<boolean> {
    switch (condition.type) {
      case "element_exists": {
        const found = await this.locate(sessionId, condition.target, 100);
        return found !== null;
      }
      case "element_gone": {
        const found = await this.locate(sessionId, condition.target, 100);
        return found === null;
      }
      case "window_title_matches": {
        const ctx = await this.getAppContext(sessionId);
        return new RegExp(condition.regex).test(ctx.windowTitle);
      }
      case "text_appears": {
        const found = await this.locate(
          sessionId,
          { type: "text", value: condition.text },
          100,
        );
        return found !== null;
      }
      case "app_idle":
        // Simplified: always return true after a short delay
        return true;
      case "selector_visible":
      case "selector_hidden":
      case "url_matches":
      case "spinner_disappears":
        // Browser-specific conditions not fully supported
        return false;
    }
  }

  private flattenTree(node: AXNode): AXNode[] {
    const result: AXNode[] = [node];
    if (node.children) {
      for (const child of node.children) {
        result.push(...this.flattenTree(child));
      }
    }
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
