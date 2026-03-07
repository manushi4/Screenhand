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
 * ScreenHand Agent CLI
 *
 * Run a desktop task autonomously:
 *   npx tsx src/agent/cli.ts "Open Safari and go to github.com"
 *   npx tsx src/agent/cli.ts "Create a new file in TextEdit called notes.txt"
 */

import type { AppAdapter } from "../runtime/app-adapter.js";
import { TimelineLogger } from "../logging/timeline-logger.js";
import { AutomationRuntimeService } from "../runtime/service.js";
import { runAgentLoop } from "./loop.js";

const task = process.argv.slice(2).join(" ");
if (!task) {
  console.error("Usage: screenhand-agent <task description>");
  console.error("Example: screenhand-agent \"Open Safari and search for MCP protocol\"");
  process.exit(1);
}

async function createAdapter(): Promise<AppAdapter> {
  const adapterType = process.env.SCREENHAND_ADAPTER ?? "accessibility";
  switch (adapterType) {
    case "placeholder": {
      const { PlaceholderAppAdapter } = await import("../runtime/app-adapter.js");
      return new PlaceholderAppAdapter();
    }
    case "cdp": {
      const { CdpChromeAdapter } = await import("../runtime/cdp-chrome-adapter.js");
      return new CdpChromeAdapter({ headless: process.env.SCREENHAND_HEADLESS === "1" });
    }
    case "composite": {
      const { BridgeClient } = await import("../native/bridge-client.js");
      const { CompositeAdapter } = await import("../runtime/composite-adapter.js");
      return new CompositeAdapter(new BridgeClient(), { headless: process.env.SCREENHAND_HEADLESS === "1" });
    }
    default: {
      const { BridgeClient } = await import("../native/bridge-client.js");
      const { AccessibilityAdapter } = await import("../runtime/accessibility-adapter.js");
      return new AccessibilityAdapter(new BridgeClient());
    }
  }
}

try {
  const adapter = await createAdapter();
  const runtime = new AutomationRuntimeService(adapter, new TimelineLogger());
  const session = await runtime.sessionStart();

  console.log(`\n🔄 Task: ${task}`);
  console.log(`   Session: ${session.sessionId}`);
  console.log(`   Model: ${process.env.SCREENHAND_MODEL ?? "claude-sonnet-4-20250514"}\n`);

  const cliModel = process.env.SCREENHAND_MODEL;
  const result = await runAgentLoop(runtime, session.sessionId, task, {
    maxSteps: parseInt(process.env.SCREENHAND_MAX_STEPS ?? "50", 10),
    ...(cliModel ? { model: cliModel } : {}),
    onStep: (step) => {
      const icon = step.done ? "✅" : step.action ? "→" : "⚠️";
      console.log(`  ${icon} [${step.index}] ${step.reasoning.slice(0, 100)}`);
      if (step.action && step.action.tool !== "done") {
        console.log(`     ${step.action.tool}: ${JSON.stringify(step.action).slice(0, 120)}`);
      }
      if (step.result) {
        console.log(`     Result: ${step.result.slice(0, 100)}`);
      }
      console.log(`     (${step.durationMs}ms)\n`);
    },
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${result.success ? "✅ SUCCESS" : "❌ INCOMPLETE"}: ${result.summary}`);
  console.log(`Steps: ${result.steps.length} | Total: ${result.totalMs}ms`);
  console.log(`${"=".repeat(60)}\n`);

  process.exit(result.success ? 0 : 1);
} catch (e) {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
