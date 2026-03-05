import { TimelineLogger } from "./logging/timeline-logger.js";
import { MvpMcpServer } from "./mcp/server.js";
import {
  type AppAdapter,
  PlaceholderAppAdapter,
} from "./runtime/app-adapter.js";
import { CdpChromeAdapter } from "./runtime/cdp-chrome-adapter.js";
import { AutomationRuntimeService } from "./runtime/service.js";

// Re-export types and adapters for external use
export type { AppAdapter } from "./runtime/app-adapter.js";
export { PlaceholderAppAdapter } from "./runtime/app-adapter.js";
export { CdpChromeAdapter } from "./runtime/cdp-chrome-adapter.js";
export { AccessibilityAdapter } from "./runtime/accessibility-adapter.js";
export { AppleScriptAdapter } from "./runtime/applescript-adapter.js";
export { VisionAdapter } from "./runtime/vision-adapter.js";
export { CompositeAdapter } from "./runtime/composite-adapter.js";
export { MacOSBridgeClient } from "./native/macos-bridge-client.js";
export { StateObserver } from "./runtime/state-observer.js";
export { PlanningLoop } from "./runtime/planning-loop.js";
export { AutomationRuntimeService } from "./runtime/service.js";
export { MvpMcpServer } from "./mcp/server.js";

export interface RuntimeApp {
  runtime: AutomationRuntimeService;
  mcp: MvpMcpServer;
}

export function createRuntimeApp(adapter: AppAdapter): RuntimeApp {
  const logger = new TimelineLogger();
  const runtime = new AutomationRuntimeService(adapter, logger);
  const mcp = new MvpMcpServer(runtime);
  return { runtime, mcp };
}

async function createDefaultAdapter(): Promise<AppAdapter> {
  if (process.env.AUTOMATOR_ADAPTER === "placeholder") {
    return new PlaceholderAppAdapter();
  }
  if (process.env.AUTOMATOR_ADAPTER === "composite") {
    // Lazy import to avoid requiring Swift bridge for CDP-only usage
    const { MacOSBridgeClient } = await import("./native/macos-bridge-client.js");
    const { CompositeAdapter } = await import("./runtime/composite-adapter.js");
    const bridge = new MacOSBridgeClient();
    return new CompositeAdapter(bridge, {
      headless: process.env.AUTOMATOR_HEADLESS === "1",
    });
  }
  if (process.env.AUTOMATOR_ADAPTER === "accessibility") {
    const { MacOSBridgeClient } = await import("./native/macos-bridge-client.js");
    const { AccessibilityAdapter } = await import("./runtime/accessibility-adapter.js");
    const bridge = new MacOSBridgeClient();
    return new AccessibilityAdapter(bridge);
  }
  return new CdpChromeAdapter({
    headless: process.env.AUTOMATOR_HEADLESS === "1",
  });
}

const app = createRuntimeApp(await createDefaultAdapter());

if (process.argv.includes("--healthcheck")) {
  const session = await app.runtime.sessionStart("automation");
  console.log(
    JSON.stringify(
      {
        status: "ok",
        session,
        note: "Runtime loaded with universal adapter support.",
      },
      null,
      2,
    ),
  );
}
