#!/usr/bin/env node
// S08 Validation: Restart Mid-Session Edit Flow
// Run: node scripts/validate-s08-restart.cjs
//
// OPERATOR PLAYBOOK — requires manual MCP restart mid-run.
// This script uses the MCP CLI to drive the test and prompts the operator.

const { execSync } = require("child_process");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const RUNS = 3;

async function main() {
  console.log("=== S08: Restart Mid-Session Edit Flow ===");
  console.log(`Runs: ${RUNS}\n`);

  const results = [];

  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n--- Run ${run}/${RUNS} ---`);

    // Step 1-2: Create doc and type pre-restart marker
    const marker = `S08-BEFORE-RESTART-${run}-${Date.now()}`;
    console.log(`1. Launch TextEdit and type marker: "${marker}"`);
    console.log("   MCP commands to run:");
    console.log(`   launch({ bundleId: "com.apple.TextEdit" })`);
    console.log(`   key({ combo: "cmd+n" })`);
    console.log(`   type_text({ text: "${marker}" })`);

    await ask("\n   Press ENTER after typing the marker...");

    // Step 3: Kill MCP
    console.log("\n2. *** RESTART MCP SERVER NOW ***");
    console.log("   - Press Ctrl+C in the MCP terminal");
    console.log("   - Run: npm run dev");

    await ask("\n   Press ENTER after MCP is restarted and tools are reconnected...");

    // Step 4-5: Verify recovery
    const afterMarker = `S08-AFTER-RESTART-${run}-${Date.now()}`;
    console.log(`\n3. Type post-restart marker: "${afterMarker}"`);
    console.log("   MCP commands to run:");
    console.log(`   apps()  — verify TextEdit still listed`);
    console.log(`   windows()  — verify document window present`);
    console.log(`   focus({ bundleId: "com.apple.TextEdit" })`);
    console.log(`   type_text({ text: " ${afterMarker}" })`);
    console.log(`   ocr()  — verify BOTH markers visible`);

    await ask("\n   Press ENTER after verification...");

    const passed = await ask("   Did BOTH markers appear in OCR? (y/n): ");
    results.push({ run, marker, afterMarker, passed: passed.toLowerCase() === "y" });
  }

  // Summary
  console.log("\n=== S08 Results ===");
  const passCount = results.filter((r) => r.passed).length;
  for (const r of results) {
    console.log(`  Run ${r.run}: ${r.passed ? "PASS" : "FAIL"}`);
  }
  console.log(`\nTotal: ${passCount}/${RUNS} passed`);
  console.log(passCount === RUNS ? "VERDICT: S08 PASS" : "VERDICT: S08 FAIL");

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
