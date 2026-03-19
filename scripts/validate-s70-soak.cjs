#!/usr/bin/env node
// S70 Validation: 30-Minute Mixed Reality Soak Test
// Run: node scripts/validate-s70-soak.cjs
//
// This script documents the exact MCP tool sequence for a 30-min soak.
// An operator runs it alongside the MCP client, following the prompts.
// For automated execution, use the MCP tools directly in sequence.

const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const DURATION_MIN = 30;
const INTERVAL_SEC = 30;
const TOTAL_ITERATIONS = Math.floor((DURATION_MIN * 60) / INTERVAL_SEC);

const APPS = [
  "com.apple.finder",
  "com.apple.TextEdit",
  "com.apple.Notes",
  "com.google.Chrome",
  "com.microsoft.VSCode",
];

const ACTIONS = [
  "focus → random app",
  "type_text → 'Soak-{i}-{ts}' into current app",
  "screenshot",
  "browser_navigate → https://example.com + browser_page_info",
  "ocr on current window",
  "job_create + job_run",
  "memory_save",
  "world_state",
  "key → cmd+tab",
  "perception_status (if running)",
];

async function main() {
  console.log("=== S70: 30-Minute Mixed Reality Soak Test ===");
  console.log(`Duration: ${DURATION_MIN} min | Interval: ${INTERVAL_SEC}s | Iterations: ${TOTAL_ITERATIONS}\n`);

  console.log("PRE-SOAK SETUP:");
  console.log("  1. Ensure running: Finder, TextEdit, Notes, Chrome, VS Code");
  console.log("  2. Run these MCP commands:");
  console.log("     perception_start({ bundleId: 'com.apple.Notes' })");
  console.log("     observer_start({ bundleId: 'com.apple.Notes', windowId: <notes_window_id> })");
  console.log("     memory_stats()  — record baseline");
  console.log("");
  console.log("  Record baseline values:");

  const baselineActions = await ask("    Baseline action count: ");
  const baselineDisk = await ask("    Baseline disk usage (KB): ");

  console.log(`\nStarting soak: ${TOTAL_ITERATIONS} iterations, ${INTERVAL_SEC}s apart`);
  console.log("Each iteration, run ONE action from the cycle:\n");

  const failures = [];
  let successCount = 0;

  for (let i = 1; i <= TOTAL_ITERATIONS; i++) {
    const actionIdx = (i - 1) % ACTIONS.length;
    const app = APPS[(i - 1) % APPS.length];
    const action = ACTIONS[actionIdx];

    console.log(`  [${i}/${TOTAL_ITERATIONS}] ${action} (app: ${app})`);

    if (i % 10 === 0) {
      const status = await ask(`    (checkpoint ${i}) Still healthy? (y/n/skip): `);
      if (status.toLowerCase() === "n") {
        failures.push({ iteration: i, action, reason: "operator reported failure" });
      } else {
        successCount += 10; // count the batch
      }
    }
  }

  // If operator skipped checkpoints, count remaining
  if (successCount < TOTAL_ITERATIONS) {
    successCount = TOTAL_ITERATIONS - failures.length;
  }

  console.log("\nPOST-SOAK CHECKS:");
  console.log("  Run these MCP commands and record results:");
  console.log("  1. perception_status() — still running? no crash?");
  console.log("  2. observer_status() — frames captured? no stall?");
  console.log("  3. memory_stats() — compare to baseline:");
  console.log(`     Expected: actions > ${baselineActions}, disk < ${Number(baselineDisk) + 5000} KB`);
  console.log("  4. world_state() — bounded control count (< 1000)?");
  console.log("  5. apps() + windows() — bridge responsive (< 500ms)?");
  console.log("  6. ls -la ~/.screenhand/ — no runaway log files?\n");

  const postActions = await ask("  Post-soak action count: ");
  const postDisk = await ask("  Post-soak disk usage (KB): ");
  const perceptionAlive = await ask("  Perception still running? (y/n): ");
  const observerAlive = await ask("  Observer still running? (y/n): ");
  const bridgeHealthy = await ask("  Bridge responsive (< 500ms)? (y/n): ");
  const worldBounded = await ask("  World model < 1000 controls? (y/n): ");

  const diskGrowth = Number(postDisk) - Number(baselineDisk);
  const actionGrowth = Number(postActions) - Number(baselineActions);

  console.log("\n=== S70 Results ===");
  console.log(`  Duration: ${DURATION_MIN} min`);
  console.log(`  Iterations: ${TOTAL_ITERATIONS}`);
  console.log(`  Failures: ${failures.length}`);
  console.log(`  Success rate: ${((successCount / TOTAL_ITERATIONS) * 100).toFixed(1)}%`);
  console.log(`  Actions recorded: +${actionGrowth}`);
  console.log(`  Disk growth: +${diskGrowth} KB`);
  console.log(`  Perception alive: ${perceptionAlive}`);
  console.log(`  Observer alive: ${observerAlive}`);
  console.log(`  Bridge healthy: ${bridgeHealthy}`);
  console.log(`  World bounded: ${worldBounded}`);

  const pass =
    successCount / TOTAL_ITERATIONS >= 0.95 &&
    diskGrowth < 5000 &&
    perceptionAlive.toLowerCase() === "y" &&
    bridgeHealthy.toLowerCase() === "y" &&
    worldBounded.toLowerCase() === "y";

  console.log(`\nVERDICT: S70 ${pass ? "PASS" : "FAIL"}`);
  if (!pass) {
    if (successCount / TOTAL_ITERATIONS < 0.95) console.log("  - Success rate below 95%");
    if (diskGrowth >= 5000) console.log("  - Disk growth exceeded 5MB");
    if (perceptionAlive.toLowerCase() !== "y") console.log("  - Perception crashed");
    if (bridgeHealthy.toLowerCase() !== "y") console.log("  - Bridge unresponsive");
    if (worldBounded.toLowerCase() !== "y") console.log("  - World model unbounded");
  }

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
