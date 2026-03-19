#!/usr/bin/env node
// S69 Validation: Multiple MCP Clients in Parallel
// Run: node scripts/validate-s69-multiclient.cjs
//
// OPERATOR PLAYBOOK — requires 3 terminal windows with MCP servers.
// Each terminal runs a separate MCP client instance.

const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const RUNS = 3;

async function main() {
  console.log("=== S69: Multiple MCP Clients in Parallel ===");
  console.log(`Runs: ${RUNS}\n`);

  console.log("SETUP:");
  console.log("  Open 3 terminal windows. In each, run: npm run dev");
  console.log("  Also ensure Chrome, TextEdit, and Finder are running.\n");
  await ask("Press ENTER when all 3 MCP servers are running...");

  const results = [];

  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n--- Run ${run}/${RUNS} ---`);
    const ts = Date.now();

    console.log("\nFire these commands within 2 seconds of each other:");
    console.log(`  Client 1: focus({ bundleId: "com.apple.TextEdit" })`);
    console.log(`            type_text({ text: "CLIENT-1-${ts}" })`);
    console.log(`  Client 2: focus({ bundleId: "com.apple.finder" })`);
    console.log(`            windows()`);
    console.log(`            screenshot()`);
    console.log(`  Client 3: browser_navigate({ url: "https://example.com" })`);
    console.log(`            browser_page_info()`);

    await ask("\n  Press ENTER after all 3 clients have completed...");

    console.log("\nVerification commands:");
    console.log(`  Client 1: ocr() on TextEdit — should contain "CLIENT-1-${ts}"`);
    console.log(`  Client 2: apps() — should list all apps correctly`);
    console.log(`  Client 3: browser_dom({ selector: "h1" }) — should return "Example Domain"`);
    console.log(`  All 3:    memory_stats() — should return valid JSON`);

    await ask("\n  Press ENTER after verification...");

    console.log("\nRace test:");
    console.log("  All 3 clients: job_create({ task: 'race-test-" + run + "' }) simultaneously");
    console.log("  Then: job_list() — verify 3 distinct jobs, no duplicate IDs");

    await ask("\n  Press ENTER after race test...");

    const checks = {
      textLanded: await ask("  Did CLIENT-1 text land ONLY in TextEdit? (y/n): "),
      appsCorrect: await ask("  Did apps() return correct list? (y/n): "),
      browserCorrect: await ask("  Did browser_dom return 'Example Domain'? (y/n): "),
      noDeadlock: await ask("  Did all 3 clients complete without hanging? (y/n): "),
      noDuplicateJobs: await ask("  Were 3 distinct jobs created (no duplicate IDs)? (y/n): "),
    };

    const allPass = Object.values(checks).every((v) => v.toLowerCase() === "y");
    results.push({ run, ...checks, passed: allPass });
  }

  console.log("\n=== S69 Results ===");
  const passCount = results.filter((r) => r.passed).length;
  for (const r of results) {
    console.log(`  Run ${r.run}: ${r.passed ? "PASS" : "FAIL"}`);
    if (!r.passed) {
      for (const [k, v] of Object.entries(r)) {
        if (k !== "run" && k !== "passed" && v.toLowerCase() !== "y") {
          console.log(`    FAILED: ${k}`);
        }
      }
    }
  }
  console.log(`\nTotal: ${passCount}/${RUNS} passed`);
  console.log(passCount >= 2 ? "VERDICT: S69 PASS (>= 2/3)" : "VERDICT: S69 FAIL");

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
