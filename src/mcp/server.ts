import type {
  ExtractFormat,
  Target,
  ToolName,
  WaitCondition,
} from "../types.js";
import type { AutomationRuntimeService } from "../runtime/service.js";

export interface ToolRequest {
  tool: ToolName;
  args: Record<string, unknown>;
}

export class MvpMcpServer {
  constructor(private readonly runtime: AutomationRuntimeService) {}

  async invoke(request: ToolRequest): Promise<unknown> {
    switch (request.tool) {
      case "session_start":
        return this.runtime.sessionStart(optionalString(request.args, "profile"));

      case "navigate": {
        const timeoutMs = optionalNumber(request.args, "timeoutMs");
        const input: {
          sessionId: string;
          url: string;
          timeoutMs?: number;
        } = {
          sessionId: requiredString(request.args, "sessionId"),
          url: requiredString(request.args, "url"),
        };
        if (typeof timeoutMs === "number") {
          input.timeoutMs = timeoutMs;
        }
        return this.runtime.navigate(input);
      }

      case "press": {
        const verify = parseOptionalWaitCondition(request.args.verify);
        const input: {
          sessionId: string;
          target: Target;
          verify?: WaitCondition;
        } = {
          sessionId: requiredString(request.args, "sessionId"),
          target: parseTarget(request.args.target),
        };
        if (verify) {
          input.verify = verify;
        }
        return this.runtime.press(input);
      }

      case "type_into": {
        const clear = optionalBoolean(request.args, "clear");
        const verify = parseOptionalWaitCondition(request.args.verify);
        const input: {
          sessionId: string;
          target: Target;
          text: string;
          clear?: boolean;
          verify?: WaitCondition;
        } = {
          sessionId: requiredString(request.args, "sessionId"),
          target: parseTarget(request.args.target),
          text: requiredString(request.args, "text"),
        };
        if (typeof clear === "boolean") {
          input.clear = clear;
        }
        if (verify) {
          input.verify = verify;
        }
        return this.runtime.typeInto(input);
      }

      case "wait_for": {
        const timeoutMs = optionalNumber(request.args, "timeoutMs");
        const input: {
          sessionId: string;
          condition: WaitCondition;
          timeoutMs?: number;
        } = {
          sessionId: requiredString(request.args, "sessionId"),
          condition: parseWaitCondition(request.args.condition),
        };
        if (typeof timeoutMs === "number") {
          input.timeoutMs = timeoutMs;
        }
        return this.runtime.waitFor(input);
      }

      case "extract":
        return this.runtime.extract({
          sessionId: requiredString(request.args, "sessionId"),
          target: parseTarget(request.args.target),
          format: parseExtractFormat(request.args.format),
        });

      case "screenshot": {
        const region = parseOptionalRegion(request.args.region);
        const input: {
          sessionId: string;
          region?: { x: number; y: number; width: number; height: number };
        } = {
          sessionId: requiredString(request.args, "sessionId"),
        };
        if (region) {
          input.region = region;
        }
        return this.runtime.screenshot(input);
      }

      // ── Desktop automation tools ──

      case "app_launch":
        return this.runtime.appLaunch({
          sessionId: requiredString(request.args, "sessionId"),
          bundleId: requiredString(request.args, "bundleId"),
        });

      case "app_focus":
        return this.runtime.appFocus({
          sessionId: requiredString(request.args, "sessionId"),
          bundleId: requiredString(request.args, "bundleId"),
        });

      case "app_list":
        return this.runtime.appList(
          requiredString(request.args, "sessionId"),
        );

      case "window_list":
        return this.runtime.windowList(
          requiredString(request.args, "sessionId"),
        );

      case "menu_click":
        return this.runtime.menuClick({
          sessionId: requiredString(request.args, "sessionId"),
          menuPath: requiredStringArray(request.args, "menuPath"),
        });

      case "key_combo":
        return this.runtime.keyCombo({
          sessionId: requiredString(request.args, "sessionId"),
          keys: requiredStringArray(request.args, "keys"),
        });

      case "element_tree": {
        const maxDepth = optionalNumber(request.args, "maxDepth");
        const root = request.args.root ? parseTarget(request.args.root) : undefined;
        const etInput: import("../types.js").ElementTreeInput = {
          sessionId: requiredString(request.args, "sessionId"),
        };
        if (typeof maxDepth === "number") etInput.maxDepth = maxDepth;
        if (root) etInput.root = root;
        return this.runtime.elementTree(etInput);
      }

      case "observe_start": {
        const events = request.args.events;
        const osInput: import("../types.js").ObserveStartInput = {
          sessionId: requiredString(request.args, "sessionId"),
        };
        if (Array.isArray(events)) {
          osInput.events = events as import("../types.js").UIEventType[];
        }
        return this.runtime.observeStart(osInput);
      }

      case "observe_stop":
        return this.runtime.observeStop({
          sessionId: requiredString(request.args, "sessionId"),
        });

      case "drag":
        return this.runtime.drag({
          sessionId: requiredString(request.args, "sessionId"),
          from: parseTarget(request.args.from),
          to: parseTarget(request.args.to),
        });

      case "scroll": {
        const scrollTarget = request.args.target ? parseTarget(request.args.target) : undefined;
        const scrollAmount = optionalNumber(request.args, "amount");
        const scrollInput: import("../types.js").ScrollInput = {
          sessionId: requiredString(request.args, "sessionId"),
          direction: requiredString(request.args, "direction") as "up" | "down" | "left" | "right",
        };
        if (scrollTarget) scrollInput.target = scrollTarget;
        if (typeof scrollAmount === "number") scrollInput.amount = scrollAmount;
        return this.runtime.scroll(scrollInput);
      }

      default:
        throw new Error(`Unsupported tool: ${String(request.tool)}`);
    }
  }
}

function parseTarget(input: unknown): Target {
  if (typeof input === "string") {
    if (input.startsWith("css=")) {
      return { type: "selector", value: input.slice(4) };
    }
    if (input.startsWith("text=")) {
      return { type: "text", value: input.slice(5), exact: true };
    }
    if (input.startsWith("ax_id=")) {
      return { type: "ax_attribute", attribute: "identifier", value: input.slice(6) };
    }
    return { type: "text", value: input };
  }

  if (!isRecord(input)) {
    throw new Error("target must be a string or object");
  }

  if (typeof input.selector === "string") {
    return { type: "selector", value: input.selector };
  }
  if (typeof input.text === "string") {
    return {
      type: "text",
      value: input.text,
      exact: input.exact === true,
    };
  }
  if (typeof input.role === "string" && typeof input.name === "string") {
    return {
      type: "role",
      role: input.role,
      name: input.name,
      exact: input.exact === true,
    };
  }
  if (Array.isArray(input.path)) {
    return { type: "ax_path", path: input.path as string[] };
  }
  if (typeof input.attribute === "string" && typeof input.value === "string") {
    return { type: "ax_attribute", attribute: input.attribute, value: input.value };
  }
  if (typeof input.x === "number" && typeof input.y === "number") {
    return { type: "coordinates", x: input.x, y: input.y };
  }
  if (typeof input.base64 === "string") {
    const target: Target = { type: "image", base64: input.base64 };
    if (typeof input.confidence === "number") {
      (target as { type: "image"; base64: string; confidence: number }).confidence = input.confidence;
    }
    return target;
  }

  throw new Error("target object must contain selector, text, role+name, path, attribute+value, x+y, or base64");
}

function parseWaitCondition(input: unknown): WaitCondition {
  if (!isRecord(input) || typeof input.type !== "string") {
    throw new Error("condition must be an object with a type");
  }

  switch (input.type) {
    case "selector_visible":
      return {
        type: "selector_visible",
        selector: requiredObjectString(input, "selector"),
      };
    case "selector_hidden":
      return {
        type: "selector_hidden",
        selector: requiredObjectString(input, "selector"),
      };
    case "url_matches":
      return {
        type: "url_matches",
        regex: requiredObjectString(input, "regex"),
      };
    case "text_appears":
      return {
        type: "text_appears",
        text: requiredObjectString(input, "text"),
      };
    case "spinner_disappears":
      return {
        type: "spinner_disappears",
        selector: requiredObjectString(input, "selector"),
      };
    case "element_exists":
      return {
        type: "element_exists",
        target: parseTarget(input.target),
      };
    case "element_gone":
      return {
        type: "element_gone",
        target: parseTarget(input.target),
      };
    case "window_title_matches":
      return {
        type: "window_title_matches",
        regex: requiredObjectString(input, "regex"),
      };
    case "app_idle": {
      const cond: WaitCondition = {
        type: "app_idle",
        bundleId: requiredObjectString(input, "bundleId"),
      };
      if (typeof input.timeoutMs === "number") {
        (cond as { type: "app_idle"; bundleId: string; timeoutMs: number }).timeoutMs = input.timeoutMs;
      }
      return cond;
    }
    default:
      throw new Error(`Unsupported condition type: ${input.type}`);
  }
}

function parseOptionalWaitCondition(input: unknown): WaitCondition | undefined {
  if (typeof input === "undefined") {
    return undefined;
  }
  return parseWaitCondition(input);
}

function parseExtractFormat(input: unknown): ExtractFormat {
  if (input === "text" || input === "table" || input === "json") {
    return input;
  }
  throw new Error("format must be one of: text, table, json");
}

function parseOptionalRegion(
  input: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
  if (typeof input === "undefined") {
    return undefined;
  }
  if (!isRecord(input)) {
    throw new Error("region must be an object");
  }
  return {
    x: requiredObjectNumber(input, "x"),
    y: requiredObjectNumber(input, "y"),
    width: requiredObjectNumber(input, "width"),
    height: requiredObjectNumber(input, "height"),
  };
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function requiredStringArray(
  input: Record<string, unknown>,
  key: string,
): string[] {
  const value = input[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function requiredObjectString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function requiredObjectNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number") {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
