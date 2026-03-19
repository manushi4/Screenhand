#!/usr/bin/env node
/**
 * Benchmark: measure raw cg.captureWindow + vision.ocr speeds
 * to determine achievable VisionSource cycle time.
 *
 * Usage: node scripts/bench-vision-cycle.cjs [windowId=6430] [iterations=20]
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const WINDOW_ID = parseInt(process.argv[2] || "6430", 10);
const ITERS = parseInt(process.argv[3] || "20", 10);

const BIN = path.join(__dirname, "..", "native", "macos-bridge", ".build", "release", "macos-bridge");
if (!fs.existsSync(BIN)) { console.error("Build native first: npm run build:native"); process.exit(1); }

let bridge, reqId = 0, pending = new Map(), buf = "";

function start() {
  bridge = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
  bridge.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); }
      } catch {}
    }
  });
  bridge.stderr.on("data", () => {});
}

function call(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++reqId;
    pending.set(id, { res, rej });
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout")); } }, 15000);
  });
}

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return { avg: avg.toFixed(1), min: sorted[0], max: sorted[sorted.length - 1], p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)] };
}

async function bench(label, fn) {
  const times = [];
  let firstInfo = "";
  for (let i = 0; i < ITERS; i++) {
    const t0 = Date.now();
    const info = await fn(i);
    times.push(Date.now() - t0);
    if (i === 0) firstInfo = info || "";
  }
  const s = stats(times);
  console.log(`  ${label}`);
  console.log(`    avg=${s.avg}ms  min=${s.min}ms  max=${s.max}ms  p50=${s.p50}ms  p95=${s.p95}ms`);
  if (firstInfo) console.log(`    ${firstInfo}`);
  console.log();
  return times;
}

async function run() {
  console.log(`\n=== Vision Cycle Benchmark ===`);
  console.log(`Window: ${WINDOW_ID}  Iterations: ${ITERS}\n`);

  start();
  await new Promise(r => setTimeout(r, 500));
  await call("ping");

  // 1. Raw CG capture (base64 PNG)
  const capTimes = await bench("cg.captureWindow (base64 PNG)", async (i) => {
    const r = await call("cg.captureWindow", { windowId: WINDOW_ID });
    if (i === 0) return `size: ${((r.base64 || "").length / 1024).toFixed(0)}KB base64`;
  });

  // 2. Raw CG capture buffer
  const bufTimes = await bench("cg.captureWindowBuffer (in-memory)", async (i) => {
    const r = await call("cg.captureWindowBuffer", { windowId: WINDOW_ID });
    if (i === 0) return `size: ${((r.base64 || "").length / 1024).toFixed(0)}KB`;
  });

  // 3. Safe CLI capture
  const cliTimes = await bench("cg.captureWindow safeCLI=true (screencapture CLI)", async (i) => {
    const r = await call("cg.captureWindow", { windowId: WINDOW_ID, safeCLI: true });
    if (i === 0) return `path: ${r.path || "n/a"}`;
  });

  // 4. Capture to file + vision.ocr (full OCR pipeline)
  const ocrViaCLITimes = await bench("safeCLI capture → vision.ocr (full OCR pipeline)", async (i) => {
    const cap = await call("cg.captureWindow", { windowId: WINDOW_ID, safeCLI: true });
    const r = await call("vision.ocr", { imagePath: cap.path });
    if (i === 0) return `text: "${(r.text || "").slice(0, 60)}"`;
  });

  // 5. CG buffer capture + vision.ocr on saved file (hybrid)
  // First capture with safeCLI for the file path, then OCR it
  const hybridTimes = await bench("captureWindowBuffer + safeCLI→vision.ocr", async (i) => {
    // Buffer capture (for diff/hash) + CLI capture (for OCR file)
    await call("cg.captureWindowBuffer", { windowId: WINDOW_ID });
    const cap = await call("cg.captureWindow", { windowId: WINDOW_ID, safeCLI: true });
    const r = await call("vision.ocr", { imagePath: cap.path });
    if (i === 0) return `text: "${(r.text || "").slice(0, 60)}"`;
  });

  // 6. Just vision.ocr on a pre-captured file (OCR-only latency)
  const preCap = await call("cg.captureWindow", { windowId: WINDOW_ID, safeCLI: true });
  const ocrOnlyTimes = await bench("vision.ocr only (pre-captured file)", async (i) => {
    const r = await call("vision.ocr", { imagePath: preCap.path });
    if (i === 0) return `text: "${(r.text || "").slice(0, 60)}"`;
  });

  // 7. End-to-end: what VisionSource CURRENTLY does (safeCLI + OCR)
  const combinedTimes = await bench("COMBINED: safeCLI + vision.ocr (current VisionSource)", async () => {
    const cap = await call("cg.captureWindow", { windowId: WINDOW_ID, safeCLI: true });
    await call("vision.ocr", { imagePath: cap.path });
  });

  // Summary
  const sa = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0);
  console.log("=== SUMMARY ===");
  console.log(`  cg.captureWindow:           ${sa(capTimes)}ms avg`);
  console.log(`  cg.captureWindowBuffer:     ${sa(bufTimes)}ms avg`);
  console.log(`  cg.captureWindow safeCLI:   ${sa(cliTimes)}ms avg`);
  console.log(`  vision.ocr only (no cap):   ${sa(ocrOnlyTimes)}ms avg`);
  console.log(`  safeCLI + vision.ocr:       ${sa(ocrViaCLITimes)}ms avg`);
  console.log(`  buffer + CLI + ocr:         ${sa(hybridTimes)}ms avg`);
  console.log(`  Combined (current path):    ${sa(combinedTimes)}ms avg`);
  console.log(`  Achievable rate:            ~${(1000 / parseFloat(sa(combinedTimes))).toFixed(1)} cycles/sec`);
  console.log(`\n  Current VisionSource:       ~1300ms/cycle (CLI screencapture + perceptual hash + OCR)`);
  console.log(`  Baseline CLI capture:       ~111ms (from earlier test)\n`);

  bridge.kill();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
