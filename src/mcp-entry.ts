#!/usr/bin/env node
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
 * ScreenHand MCP Server — MODULAR entry point (alternative).
 *
 * NOTE: The primary/canonical MCP server is `mcp-desktop.ts` at the project root.
 * It has the full 40+ tool set (desktop, browser, memory, playbooks, codex monitor).
 *
 * This modular entrypoint exposes a smaller subset of tools via the runtime service
 * abstraction. It exists for adapter experimentation and future refactoring.
 *
 * For production use, prefer: npx tsx mcp-desktop.ts
 *
 * Environment variables:
 *   SCREENHAND_ADAPTER  - "accessibility" (default), "composite", "cdp", "placeholder"
 *   SCREENHAND_HEADLESS - "1" to run browser in headless mode
 */

import type { AppAdapter } from "./runtime/app-adapter.js";
import { PlaceholderAppAdapter } from "./runtime/app-adapter.js";
import { CdpChromeAdapter } from "./runtime/cdp-chrome-adapter.js";
import { TimelineLogger } from "./logging/timeline-logger.js";
import { AutomationRuntimeService } from "./runtime/service.js";
import { startMcpStdioServer } from "./mcp/mcp-stdio-server.js";

async function createAdapter(): Promise<AppAdapter> {
  const adapterType = process.env.SCREENHAND_ADAPTER ?? process.env.AUTOMATOR_ADAPTER ?? "accessibility";

  switch (adapterType) {
    case "placeholder":
      return new PlaceholderAppAdapter();

    case "cdp":
      return new CdpChromeAdapter({
        headless: process.env.SCREENHAND_HEADLESS === "1" || process.env.AUTOMATOR_HEADLESS === "1",
      });

    case "composite": {
      const { BridgeClient } = await import("./native/bridge-client.js");
      const { CompositeAdapter } = await import("./runtime/composite-adapter.js");
      const bridge = new BridgeClient();
      return new CompositeAdapter(bridge, {
        headless: process.env.SCREENHAND_HEADLESS === "1" || process.env.AUTOMATOR_HEADLESS === "1",
      });
    }

    case "accessibility":
    default: {
      const { BridgeClient } = await import("./native/bridge-client.js");
      const { AccessibilityAdapter } = await import("./runtime/accessibility-adapter.js");
      const bridge = new BridgeClient();
      return new AccessibilityAdapter(bridge);
    }
  }
}

try {
  const adapter = await createAdapter();
  const logger = new TimelineLogger();
  const runtime = new AutomationRuntimeService(adapter, logger);

  process.stderr.write("ScreenHand MCP server starting...\n");
  await startMcpStdioServer(runtime);
  process.stderr.write("ScreenHand MCP server connected.\n");
} catch (e) {
  process.stderr.write(`ScreenHand startup error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
