#!/usr/bin/env node
/**
 * Screenshot benchmark — measures latency, throughput, stability, storage.
 *
 * Usage:
 *   node scripts/bench-screenshot.cjs [count=100] [mode=full|window]
 *
 * Runs against the native bridge directly (spawns macos-bridge binary).
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const COUNT = parseInt(process.argv[2] || "100", 10);
const MODE = process.argv[3] || "full"; // "full", "window", or "safecli"

// ── Bridge JSON-RPC client ──

let bridge;
let requestId = 0;
const pending = new Map();
let buffer = "";

function startBridge() {
  const binPath = path.join(__dirname, "..", "native", "macos-bridge", ".build", "release", "macos-bridge");
  if (!fs.existsSync(binPath)) {
    console.error("Bridge binary not found. Run: npm run build:native");
    process.exit(1);
  }
  bridge = spawn(binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  bridge.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {}
    }
  });
  bridge.stderr.on("data", (d) => process.stderr.write(d));
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    bridge.stdin.write(msg);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }
    }, 15000);
  });
}

// ── Stats helpers ──

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

function formatBytes(b) {
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  return (b / 1024).toFixed(0) + " KB";
}

// ── Main benchmark ──

async function run() {
  console.log(`\n📸 Screenshot Benchmark`);
  console.log(`   Mode: ${MODE} | Count: ${COUNT}`);
  console.log(`   ${"-".repeat(50)}\n`);

  startBridge();

  // Wait for bridge ready
  await new Promise((r) => setTimeout(r, 500));
  try {
    await call("ping");
  } catch {
    console.error("Bridge ping failed");
    process.exit(1);
  }

  // Get window ID for window mode
  let windowId;
  if (MODE === "window" || MODE === "safecli") {
    try {
      const wins = await call("window.list");
      const safari = wins.find((w) => w.ownerName === "Safari");
      windowId = safari ? safari.windowId : wins[0]?.windowId;
      console.log(`   Window ID: ${windowId} (${safari?.ownerName || "first window"})\n`);
    } catch {
      console.log("   Could not get window list, falling back to full screen\n");
    }
  }

  const latencies = [];
  const fileSizes = [];
  let failures = 0;
  let timeouts = 0;
  const tempFiles = [];

  // Get initial memory/CPU baseline
  const cpuBefore = os.cpus().reduce((a, c) => a + c.times.user + c.times.sys, 0);
  const memBefore = process.memoryUsage().rss;

  const totalStart = Date.now();

  // ── Run captures ──
  for (let i = 0; i < COUNT; i++) {
    const t0 = Date.now();
    try {
      let result;
      if (MODE === "safecli" && windowId) {
        result = await call("cg.captureWindow", { windowId, safeCLI: true });
      } else if (MODE === "window" && windowId) {
        result = await call("cg.captureWindow", { windowId, safeCLI: false });
      } else {
        result = await call("cg.captureScreen", {});
      }

      const elapsed = Date.now() - t0;
      latencies.push(elapsed);

      // Track file size
      if (result.path) {
        try {
          const stat = fs.statSync(result.path);
          fileSizes.push(stat.size);
          tempFiles.push(result.path);
        } catch {}
      }

      // Progress every 20
      if ((i + 1) % 20 === 0) {
        const avg = latencies.slice(-20).reduce((a, b) => a + b, 0) / 20;
        console.log(`   [${i + 1}/${COUNT}] last-20 avg: ${avg.toFixed(0)}ms`);
      }
    } catch (e) {
      const elapsed = Date.now() - t0;
      if (e.message.includes("Timeout")) timeouts++;
      else failures++;
      latencies.push(elapsed);
      if ((i + 1) % 20 === 0) console.log(`   [${i + 1}/${COUNT}] (had failures)`);
    }
  }

  const totalMs = Date.now() - totalStart;
  const cpuAfter = os.cpus().reduce((a, c) => a + c.times.user + c.times.sys, 0);
  const memAfter = process.memoryUsage().rss;

  // ── Report ──
  const successful = latencies.length - failures - timeouts;
  const successLatencies = latencies.filter((_, i) => i < successful);

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  RESULTS — ${MODE} screen, ${COUNT} captures`);
  console.log(`${"=".repeat(55)}`);

  // Latency
  console.log(`\n  LATENCY`);
  if (successLatencies.length > 0) {
    const avg = successLatencies.reduce((a, b) => a + b, 0) / successLatencies.length;
    console.log(`    avg:  ${avg.toFixed(0)} ms`);
    console.log(`    p50:  ${percentile(successLatencies, 50)} ms`);
    console.log(`    p95:  ${percentile(successLatencies, 95)} ms`);
    console.log(`    max:  ${Math.max(...successLatencies)} ms`);
    console.log(`    min:  ${Math.min(...successLatencies)} ms`);
  }

  // Throughput
  console.log(`\n  THROUGHPUT`);
  console.log(`    total time:    ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`    screenshots/s: ${(COUNT / (totalMs / 1000)).toFixed(2)}`);

  // Stability
  console.log(`\n  STABILITY`);
  console.log(`    success:  ${successful}/${COUNT} (${(successful / COUNT * 100).toFixed(1)}%)`);
  console.log(`    failures: ${failures}`);
  console.log(`    timeouts: ${timeouts}`);
  console.log(`    mem delta: ${formatBytes(memAfter - memBefore)}`);
  console.log(`    CPU delta: ${((cpuAfter - cpuBefore) / 1000).toFixed(1)}s`);

  // Storage
  console.log(`\n  STORAGE`);
  if (fileSizes.length > 0) {
    const avgSize = fileSizes.reduce((a, b) => a + b, 0) / fileSizes.length;
    const totalSize = fileSizes.reduce((a, b) => a + b, 0);
    const perMin = (60000 / (totalMs / COUNT)) * avgSize;
    console.log(`    avg file size:    ${formatBytes(avgSize)}`);
    console.log(`    min file size:    ${formatBytes(Math.min(...fileSizes))}`);
    console.log(`    max file size:    ${formatBytes(Math.max(...fileSizes))}`);
    console.log(`    total captured:   ${formatBytes(totalSize)}`);
    console.log(`    disk growth/min:  ${formatBytes(perMin)}`);
    console.log(`    max screenshots:  ~${Math.floor(10 * 1024 * 1024 * 1024 / avgSize)} (10GB budget)`);
  }

  console.log(`\n${"=".repeat(55)}\n`);

  // Cleanup temp files
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }

  bridge.kill();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
