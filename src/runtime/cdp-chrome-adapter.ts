import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getChromePath, launch } from "chrome-launcher";
import type { LaunchedChrome } from "chrome-launcher";
import CDP from "chrome-remote-interface";
import type {
  AppContext,
  ExtractFormat,
  LocatedElement,
  PageMeta,
  SessionInfo,
  Target,
  WaitCondition,
} from "../types.js";
import type { AppAdapter } from "./app-adapter.js";

const HANDLE_ATTR = "data-automator-handle";
const POLL_INTERVAL_MS = 100;

type CdpClient = Awaited<ReturnType<typeof CDP>>;

interface SessionState {
  info: SessionInfo;
  profileDir: string;
  chrome: LaunchedChrome;
  client: CdpClient;
}

export interface CdpChromeAdapterOptions {
  profileRootDir?: string;
  screenshotDir?: string;
  chromePath?: string;
  headless?: boolean;
}

export class CdpChromeAdapter implements AppAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionsByProfile = new Map<string, SessionState>();

  constructor(private readonly options: CdpChromeAdapterOptions = {}) {}

  async attach(profile: string): Promise<SessionInfo> {
    const existing = this.sessionsByProfile.get(profile);
    if (existing) {
      return existing.info;
    }

    const profileDir = path.resolve(
      this.options.profileRootDir ?? path.join(process.cwd(), ".profiles"),
      profile,
    );
    await mkdir(profileDir, { recursive: true });

    const chromePath = this.options.chromePath ?? resolveChromePath();
    const chrome = await launch({
      chromePath,
      startingUrl: "about:blank",
      userDataDir: profileDir,
      chromeFlags: this.buildChromeFlags(),
    });

    const targetId = await this.resolveTargetId(chrome.port);
    const client = await CDP({ port: chrome.port, target: targetId });
    await Promise.all([client.Page.enable(), client.Runtime.enable()]);

    const info: SessionInfo = {
      sessionId: `session_${profile}_${Date.now()}`,
      profile,
      createdAt: new Date().toISOString(),
      adapterType: "cdp",
    };

    const state: SessionState = { info, profileDir, chrome, client };
    this.sessions.set(info.sessionId, state);
    this.sessionsByProfile.set(profile, state);
    return info;
  }

  /** Backward-compatible alias. */
  async connect(profile: string): Promise<SessionInfo> {
    return this.attach(profile);
  }

  async getAppContext(sessionId: string): Promise<AppContext> {
    const page = await this.getPageMeta(sessionId);
    return {
      bundleId: "com.google.Chrome",
      appName: "Google Chrome",
      pid: this.requireSession(sessionId).chrome.pid,
      windowTitle: page.title,
      url: page.url,
    };
  }

  async getPageMeta(sessionId: string): Promise<PageMeta> {
    const state = this.requireSession(sessionId);
    const page = await this.evaluateJson<PageMeta>(
      state,
      "(() => ({ url: String(window.location.href), title: String(document.title || '') }))()",
    );
    return page;
  }

  async navigate(
    sessionId: string,
    url: string,
    timeoutMs: number,
  ): Promise<PageMeta> {
    const state = this.requireSession(sessionId);
    await state.client.Page.navigate({ url });

    const ready = await this.waitUntil(timeoutMs, async () => {
      const readyState = await this.evaluateJson<string>(
        state,
        "(() => String(document.readyState))()",
      );
      return readyState === "interactive" || readyState === "complete";
    });

    if (!ready) {
      throw new Error(`Navigation timeout after ${timeoutMs}ms for ${url}`);
    }

    return this.getPageMeta(sessionId);
  }

  async locate(
    sessionId: string,
    target: Target,
    timeoutMs: number,
  ): Promise<LocatedElement | null> {
    const state = this.requireSession(sessionId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.evaluateJson<LocatedElement | null>(
        state,
        buildLocateExpression(target),
      );
      if (result) {
        return result;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  async click(sessionId: string, element: LocatedElement): Promise<void> {
    const state = this.requireSession(sessionId);
    const response = await this.evaluateJson<{ ok: boolean; reason?: string }>(
      state,
      buildClickExpression(element.handleId),
    );
    if (!response.ok) {
      throw new Error(response.reason ?? "Click failed");
    }
  }

  async setValue(
    sessionId: string,
    element: LocatedElement,
    text: string,
    clear: boolean,
  ): Promise<void> {
    const state = this.requireSession(sessionId);
    const response = await this.evaluateJson<{ ok: boolean; reason?: string }>(
      state,
      buildSetValueExpression(element.handleId, text, clear),
    );
    if (!response.ok) {
      throw new Error(response.reason ?? "setValue failed");
    }
  }

  async getValue(sessionId: string, element: LocatedElement): Promise<string> {
    const state = this.requireSession(sessionId);
    return this.evaluateJson<string>(state, buildGetValueExpression(element.handleId));
  }

  async waitFor(
    sessionId: string,
    condition: WaitCondition,
    timeoutMs: number,
  ): Promise<boolean> {
    const state = this.requireSession(sessionId);
    return this.waitUntil(timeoutMs, async () =>
      this.checkCondition(state, condition),
    );
  }

  async extract(
    sessionId: string,
    target: Target,
    format: ExtractFormat,
  ): Promise<unknown> {
    const state = this.requireSession(sessionId);
    const element = await this.locate(sessionId, target, 1500);
    if (!element) {
      throw new Error("Extract target not found");
    }
    return this.evaluateJson<unknown>(
      state,
      buildExtractExpression(element.handleId, format),
    );
  }

  async screenshot(
    sessionId: string,
    region?: { x: number; y: number; width: number; height: number },
  ): Promise<string> {
    const state = this.requireSession(sessionId);
    const screenshotDir = path.resolve(
      this.options.screenshotDir ?? path.join(process.cwd(), ".artifacts", "screenshots"),
    );
    await mkdir(screenshotDir, { recursive: true });

    const captureParams: {
      format: "png";
      captureBeyondViewport: boolean;
      clip?: { x: number; y: number; width: number; height: number; scale: number };
    } = {
      format: "png",
      captureBeyondViewport: true,
    };

    if (region) {
      captureParams.clip = {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        scale: 1,
      };
    }

    const shot = await state.client.Page.captureScreenshot(captureParams);
    if (!shot.data) {
      throw new Error("Screenshot capture returned empty data");
    }

    const filePath = path.join(
      screenshotDir,
      `shot_${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}.png`,
    );
    await writeFile(filePath, Buffer.from(shot.data, "base64"));
    return filePath;
  }

  private async checkCondition(
    state: SessionState,
    condition: WaitCondition,
  ): Promise<boolean> {
    switch (condition.type) {
      case "selector_visible":
        return this.evaluateJson<boolean>(
          state,
          buildSelectorVisibilityExpression(condition.selector, true),
        );
      case "selector_hidden":
      case "spinner_disappears":
        return this.evaluateJson<boolean>(
          state,
          buildSelectorVisibilityExpression(condition.selector, false),
        );
      case "text_appears":
        return this.evaluateJson<boolean>(
          state,
          buildTextAppearsExpression(condition.text),
        );
      case "url_matches": {
        const page = await this.getPageMeta(state.info.sessionId);
        let regex: RegExp;
        try {
          regex = new RegExp(condition.regex);
        } catch (error) {
          throw new Error(
            `Invalid regex "${condition.regex}": ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        }
        return regex.test(page.url);
      }
      case "element_exists":
      case "element_gone":
      case "window_title_matches":
      case "app_idle":
        // Desktop-specific conditions not supported by CDP adapter
        throw new Error(`Condition type "${condition.type}" not supported by CDP adapter`);
    }
  }

  private async waitUntil(
    timeoutMs: number,
    predicate: () => Promise<boolean>,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return true;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }

  private async evaluateJson<T>(state: SessionState, expression: string): Promise<T> {
    const result = await state.client.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description;
      throw new Error(description ?? "Runtime.evaluate exception");
    }

    return result.result.value as T;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private buildChromeFlags(): string[] {
    const flags = [
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ];
    if (this.options.headless) {
      flags.push("--headless=new");
    }
    return flags;
  }

  private async resolveTargetId(port: number): Promise<string> {
    const targets = await CDP.List({ port });
    const pageTarget = targets.find((target) => target.type === "page");
    if (pageTarget?.id) {
      return pageTarget.id;
    }

    const created = await CDP.New({ port });
    if (typeof created === "string") {
      return created;
    }
    if (created && typeof created.id === "string") {
      return created.id;
    }
    throw new Error("Could not create a page target for CDP");
  }
}

function resolveChromePath(): string {
  const envPath = process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  try {
    const discovered = getChromePath();
    if (discovered && existsSync(discovered)) {
      return discovered;
    }
  } catch {
    // Fall through to fixed-path probes below.
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Chrome executable not found. Set CHROME_PATH or install Google Chrome.",
  );
}

function escapeForAttribute(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function buildLocateExpression(target: Target): string {
  const encodedTarget = JSON.stringify(target);
  return `
(() => {
  const HANDLE_ATTR = "${HANDLE_ATTR}";
  const target = ${encodedTarget};
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const lower = (value) => normalize(value).toLowerCase();
  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const implicitRole = (element) => {
    if (!(element instanceof Element)) return "";
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "";
  };
  const nameFor = (element) => {
    if (!(element instanceof Element)) return "";
    const aria = element.getAttribute("aria-label");
    if (aria) return aria;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value || element.placeholder || "";
    }
    return element.textContent || "";
  };
  const assignHandle = (element, locatorUsed) => {
    let handle = element.getAttribute(HANDLE_ATTR);
    if (!handle) {
      handle = "ah_" + Math.random().toString(36).slice(2, 10);
      element.setAttribute(HANDLE_ATTR, handle);
    }
    return { handleId: handle, locatorUsed };
  };

  if (target.type === "selector") {
    const element = document.querySelector(target.value);
    if (element && isVisible(element)) return assignHandle(element, target.value);
    return null;
  }

  const pool = Array.from(
    document.querySelectorAll("button,a,input,textarea,select,[role],label,[aria-label],span,div")
  );

  if (target.type === "text") {
    const wanted = lower(target.value);
    for (const element of pool) {
      if (!isVisible(element)) continue;
      const text = lower(nameFor(element));
      if (!text) continue;
      const matched = target.exact ? text === wanted : text.includes(wanted);
      if (matched) return assignHandle(element, "text:" + target.value);
    }
    return null;
  }

  const wantedRole = lower(target.role);
  const wantedName = lower(target.name);
  for (const element of pool) {
    if (!isVisible(element)) continue;
    if (lower(implicitRole(element)) !== wantedRole) continue;
    const elementName = lower(nameFor(element));
    if (!elementName) continue;
    const matched = target.exact ? elementName === wantedName : elementName.includes(wantedName);
    if (matched) return assignHandle(element, "role:" + target.role + "|name:" + target.name);
  }
  return null;
})()
`.trim();
}

function buildClickExpression(handleId: string): string {
  const safeHandle = escapeForAttribute(handleId);
  return `
(() => {
  const selector = '[${HANDLE_ATTR}="${safeHandle}"]';
  const element = document.querySelector(selector);
  if (!(element instanceof Element)) {
    return { ok: false, reason: "ELEMENT_NOT_FOUND" };
  }
  element.scrollIntoView({ block: "center", inline: "center" });
  if (element instanceof HTMLElement) {
    element.click();
  } else {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }
  return { ok: true };
})()
`.trim();
}

function buildSetValueExpression(handleId: string, text: string, clear: boolean): string {
  const safeHandle = escapeForAttribute(handleId);
  const safeText = JSON.stringify(text);
  return `
(() => {
  const selector = '[${HANDLE_ATTR}="${safeHandle}"]';
  const element = document.querySelector(selector);
  if (!(element instanceof Element)) {
    return { ok: false, reason: "ELEMENT_NOT_FOUND" };
  }
  const text = ${safeText};
  const clear = ${clear ? "true" : "false"};
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    if (clear) element.value = "";
    element.value = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    if (clear) element.textContent = "";
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  return { ok: false, reason: "UNSUPPORTED_ELEMENT_FOR_SET_VALUE" };
})()
`.trim();
}

function buildGetValueExpression(handleId: string): string {
  const safeHandle = escapeForAttribute(handleId);
  return `
(() => {
  const selector = '[${HANDLE_ATTR}="${safeHandle}"]';
  const element = document.querySelector(selector);
  if (!(element instanceof Element)) {
    throw new Error("ELEMENT_NOT_FOUND");
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return String(element.value ?? "");
  }
  return String(element.textContent ?? "");
})()
`.trim();
}

function buildSelectorVisibilityExpression(
  selector: string,
  shouldBeVisible: boolean,
): string {
  const safeSelector = JSON.stringify(selector);
  return `
(() => {
  const selector = ${safeSelector};
  const element = document.querySelector(selector);
  const isVisible = (node) => {
    if (!(node instanceof Element)) return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const visible = isVisible(element);
  return ${shouldBeVisible ? "visible" : "!visible || !element"};
})()
`.trim();
}

function buildTextAppearsExpression(text: string): string {
  const safeText = JSON.stringify(text);
  return `
(() => {
  const wanted = String(${safeText}).toLowerCase();
  const pageText = String(document.body?.innerText || "").toLowerCase();
  return pageText.includes(wanted);
})()
`.trim();
}

function buildExtractExpression(handleId: string, format: ExtractFormat): string {
  const safeHandle = escapeForAttribute(handleId);
  if (format === "text") {
    return `
(() => {
  const selector = '[${HANDLE_ATTR}="${safeHandle}"]';
  const element = document.querySelector(selector);
  if (!(element instanceof Element)) {
    throw new Error("ELEMENT_NOT_FOUND");
  }
  return String(element.textContent || "").trim();
})()
`.trim();
  }

  if (format === "table") {
    return `
(() => {
  const selector = '[${HANDLE_ATTR}="${safeHandle}"]';
  const element = document.querySelector(selector);
  if (!(element instanceof Element)) {
    throw new Error("ELEMENT_NOT_FOUND");
  }
  const table = element.tagName.toLowerCase() === "table" ? element : element.closest("table");
  if (!(table instanceof HTMLTableElement)) {
    throw new Error("TARGET_IS_NOT_A_TABLE");
  }
  const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
    String(th.textContent || "").trim()
  );
  const rows = Array.from(table.querySelectorAll("tbody tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        String(cell.textContent || "").trim()
      )
    )
    .filter((row) => row.length > 0);
  return { headers, rows };
})()
`.trim();
  }

  return `
(() => {
  const selector = '[${HANDLE_ATTR}="${safeHandle}"]';
  const element = document.querySelector(selector);
  if (!(element instanceof Element)) {
    throw new Error("ELEMENT_NOT_FOUND");
  }
  const raw = String(element.textContent || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
})()
`.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
