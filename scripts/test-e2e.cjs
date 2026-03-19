// End-to-end MCP server test — tests real tool calls against live desktop
const { spawn } = require("child_process");

const server = spawn("npx", ["tsx", "mcp-desktop.ts"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
});

let buf = "";
const pending = {};
let nextId = 1;

server.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending[msg.id]) {
        pending[msg.id](msg);
        delete pending[msg.id];
      }
    } catch {}
  }
});

server.stderr.on("data", () => {});

function mcpCall(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending[id] = resolve;
    const req = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
    server.stdin.write(req);
    setTimeout(() => {
      delete pending[id];
      reject(new Error("timeout: " + method));
    }, 15000);
  });
}

function getText(result) {
  return result?.result?.content?.[0]?.text || "";
}

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}  —  ${detail || ""}`);
  }
}

(async () => {
  console.log("Starting MCP server...\n");

  // Initialize
  const init = await mcpCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  check("MCP initialize", init.result, "no result");

  // List tools
  const tools = await mcpCall("tools/list", {});
  const toolNames = (tools.result?.tools || []).map((t) => t.name);
  check("tools/list returns tools", toolNames.length >= 80, "got " + toolNames.length);

  // Check intelligence tools are registered
  const hasApps = toolNames.includes("apps");
  const hasScreenshot = toolNames.includes("screenshot");
  const hasOcr = toolNames.includes("ocr");
  const hasUiTree = toolNames.includes("ui_tree");
  const hasMemory = toolNames.includes("memory_save");
  const hasPlanGoal = toolNames.includes("plan_goal");
  check("core tools registered", hasApps && hasScreenshot && hasOcr && hasUiTree, "missing core tools");
  check("memory tools registered", hasMemory, "missing memory_save");

  // Test: apps
  console.log("\n--- Desktop Tools ---");
  const apps = await mcpCall("tools/call", { name: "apps", arguments: {} });
  const appsText = getText(apps);
  check("apps returns data", appsText.length > 10, "empty response");
  check("apps lists running apps", appsText.includes("pid"), "no pid in output");

  // Test: windows
  const wins = await mcpCall("tools/call", { name: "windows", arguments: {} });
  const winsText = getText(wins);
  check("windows returns data", winsText.length > 5, "empty response");

  // Test: screenshot
  const shot = await mcpCall("tools/call", { name: "screenshot", arguments: {} });
  const shotText = getText(shot);
  check("screenshot succeeds", shotText.includes("png") || shotText.includes("image") || shotText.length > 50, "unexpected: " + shotText.substring(0, 100));

  // Test: ocr
  const ocr = await mcpCall("tools/call", { name: "ocr", arguments: {} });
  const ocrText = getText(ocr);
  check("ocr returns text", ocrText.length > 20, "too short: " + ocrText.length);

  // Test: ui_tree on focused app
  console.log("\n--- AX / UI Tools ---");
  const tree = await mcpCall("tools/call", { name: "ui_tree", arguments: { depth: 2 } });
  const treeText = getText(tree);
  check("ui_tree returns structure", treeText.length > 20, "too short");

  // Test: platform_guide
  console.log("\n--- Intelligence Tools ---");
  const guide = await mcpCall("tools/call", {
    name: "platform_guide",
    arguments: { bundleId: "com.apple.finder", task: "copy file" },
  });
  const guideText = getText(guide);
  check("platform_guide responds", guideText.length > 10, "empty");

  // Test: memory_save + memory_recall
  console.log("\n--- Memory Tools ---");
  const save = await mcpCall("tools/call", {
    name: "memory_save",
    arguments: { key: "e2e_test", value: "integration test at " + new Date().toISOString() },
  });
  check("memory_save succeeds", getText(save).length > 0, "empty");

  const recall = await mcpCall("tools/call", {
    name: "memory_recall",
    arguments: { task: "e2e_test" },
  });
  const recallText = getText(recall);
  check("memory_recall returns results", recallText.length > 10, "empty response");

  // Test: memory_stats
  const stats = await mcpCall("tools/call", {
    name: "memory_stats",
    arguments: {},
  });
  check("memory_stats returns stats", getText(stats).length > 10, "empty");

  // Test: observer_status (should report not running)
  console.log("\n--- Observer / Perception ---");
  const obsStatus = await mcpCall("tools/call", {
    name: "observer_status",
    arguments: {},
  });
  check("observer_status responds", getText(obsStatus).length > 5, "empty");

  // Test: plan_goal (creates a goal)
  if (toolNames.includes("plan_goal")) {
    console.log("\n--- Planner ---");
    const planResult = await mcpCall("tools/call", {
      name: "plan_goal",
      arguments: { goal: "Open Finder and create a new folder" },
    });
    const planText = getText(planResult);
    check("plan_goal creates a plan", planText.length > 10, "empty: " + planText);
    check("plan_goal has subgoals or steps", planText.includes("step") || planText.includes("subgoal") || planText.includes("goal_"), planText.substring(0, 200));
  }

  // Test: coverage_report
  if (toolNames.includes("coverage_report")) {
    console.log("\n--- Ingestion ---");
    const cov = await mcpCall("tools/call", {
      name: "coverage_report",
      arguments: { bundleId: "com.apple.finder", appName: "Finder" },
    });
    check("coverage_report responds", getText(cov).length > 10, "empty");
  }

  // Test: click_text (live — will fail to find target but tests intelligence wrapper)
  console.log("\n--- Intelligence Wrapper ---");
  const clickResult = await mcpCall("tools/call", {
    name: "click_text",
    arguments: { text: "e2e_nonexistent_button_12345" },
  });
  const clickText = getText(clickResult);
  // Should fail (element not found) but the intelligence wrapper should record the failure
  check("click_text runs through wrapper", clickText.length > 0 || clickResult.result, "no response at all");

  // Test: ui_find
  const findResult = await mcpCall("tools/call", {
    name: "ui_find",
    arguments: { target: "AXButton" },
  });
  check("ui_find returns results", getText(findResult).length > 0, "empty");

  // Test: focus on Finder (live action)
  console.log("\n--- Live Actions ---");
  const focusResult = await mcpCall("tools/call", {
    name: "focus",
    arguments: { bundleId: "com.apple.finder" },
  });
  const focusText = getText(focusResult);
  check("focus Finder succeeds", focusText.toLowerCase().includes("finder") || focusText.toLowerCase().includes("focus"), focusText.substring(0, 200));

  // Take screenshot after focus to verify
  const shot2 = await mcpCall("tools/call", { name: "screenshot", arguments: {} });
  check("screenshot after focus works", getText(shot2).length > 50, "too short");

  // Switch back to VS Code
  await mcpCall("tools/call", {
    name: "focus",
    arguments: { bundleId: "com.microsoft.VSCode" },
  });

  // Test: key press
  console.log("\n--- Key Press ---");
  const keyResult = await mcpCall("tools/call", {
    name: "key",
    arguments: { key: "escape" },
  });
  check("key press escape succeeds", getText(keyResult).length > 0, "empty");

  // Test: supervisor_status
  console.log("\n--- Supervisor ---");
  const supStatus = await mcpCall("tools/call", {
    name: "supervisor_status",
    arguments: {},
  });
  check("supervisor_status responds", getText(supStatus).length > 5, "empty");

  // Test: learning_status (if exists)
  if (toolNames.includes("learning_status")) {
    console.log("\n--- Learning ---");
    const learnStatus = await mcpCall("tools/call", {
      name: "learning_status",
      arguments: { bundleId: "com.apple.finder" },
    });
    check("learning_status responds", getText(learnStatus).length > 5, "empty");
  }

  // Test: recovery_status (if exists)
  if (toolNames.includes("recovery_status")) {
    const recStatus = await mcpCall("tools/call", {
      name: "recovery_status",
      arguments: {},
    });
    check("recovery_status responds", getText(recStatus).length > 5, "empty");
  }

  // Summary
  console.log("\n========================================");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("========================================\n");

  server.kill();
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e.message);
  server.kill();
  process.exit(1);
});
