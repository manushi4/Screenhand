#!/usr/bin/env node
/**
 * Screenshot Benchmark Suite — SHOT-01 through SHOT-14
 *
 * Usage:
 *   node scripts/bench-screenshot-suite.cjs                    # Run all tests
 *   node scripts/bench-screenshot-suite.cjs SHOT-05 SHOT-09    # Run specific tests
 *   node scripts/bench-screenshot-suite.cjs --priority         # Run top 3 priority tests
 *
 * Results saved to: ~/.screenhand/benchmarks/<timestamp>.json
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ═══════════════════════════════════════════════
// Bridge JSON-RPC Client
// ═══════════════════════════════════════════════

class BridgeClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = "";
  }

  start() {
    const binPath = path.join(__dirname, "..", "native", "macos-bridge", ".build", "release", "macos-bridge");
    if (!fs.existsSync(binPath)) {
      throw new Error("Bridge binary not found. Run: npm run build:native");
    }
    this.process = spawn(binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.process.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch {}
      }
    });
    this.process.stderr.on("data", () => {}); // suppress
  }

  async call(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  async ping() {
    await new Promise((r) => setTimeout(r, 500));
    return this.call("ping");
  }

  kill() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  restart() {
    this.kill();
    this.buffer = "";
    this.pending.clear();
    this.requestId = 0;
    this.start();
  }
}

// ═══════════════════════════════════════════════
// MCP stdio Client — speaks the real MCP protocol
// ═══════════════════════════════════════════════

class MCPClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = "";
  }

  start() {
    // Spawn the MCP server via tsx (same as `npm run dev`)
    const tsxPath = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
    const entryPath = path.join(__dirname, "..", "mcp-desktop.ts");
    this.process = spawn(tsxPath, [entryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    this.process.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } catch {}
      }
    });
    this.process.stderr.on("data", () => {}); // suppress
  }

  send(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.process.stdin.write(msg);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP Timeout: ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  async initialize() {
    await new Promise((r) => setTimeout(r, 2000)); // let tsx compile + server boot
    const result = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bench-suite", version: "1.0.0" },
    });
    // Send initialized notification (no id)
    this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await new Promise((r) => setTimeout(r, 500));
    return result;
  }

  async callTool(name, args = {}) {
    return this.send("tools/call", { name, arguments: args });
  }

  kill() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

/**
 * Run N MCP tool calls and collect latency metrics.
 */
async function runMCPCaptures(mcp, opts) {
  const { count, toolName = "screenshot_file", toolArgs = {}, quiet = false } = opts;
  const latencies = [];
  const fileSizes = [];
  let failures = 0;
  let timeouts = 0;
  const tempFiles = [];

  const cpuBefore = os.cpus().reduce((a, c) => a + c.times.user + c.times.sys, 0);
  const memBefore = process.memoryUsage().rss;
  const totalStart = Date.now();

  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    try {
      const result = await mcp.callTool(toolName, toolArgs);
      const elapsed = Date.now() - t0;
      latencies.push(elapsed);

      // Extract file path from MCP response and stat it
      if (result && result.content) {
        for (const c of result.content) {
          if (c.type === "text" && c.text && c.text.startsWith("/")) {
            try {
              const stat = fs.statSync(c.text);
              fileSizes.push(stat.size);
              tempFiles.push(c.text);
            } catch {}
          }
        }
      }

      if (!quiet && (i + 1) % Math.max(1, Math.floor(count / 10)) === 0) {
        const recent = latencies.slice(-Math.floor(count / 10));
        process.stdout.write(`   [${i + 1}/${count}] last avg: ${avg(recent).toFixed(0)}ms\n`);
      }
    } catch (e) {
      const elapsed = Date.now() - t0;
      if (e.message.includes("Timeout")) timeouts++;
      else failures++;
      latencies.push(elapsed);
    }
  }

  const totalMs = Date.now() - totalStart;
  const cpuAfter = os.cpus().reduce((a, c) => a + c.times.user + c.times.sys, 0);
  const memAfter = process.memoryUsage().rss;

  // Cleanup
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }

  const successful = count - failures - timeouts;
  const successLatencies = latencies.slice(0, successful);

  return {
    count,
    toolName,
    toolArgs,
    totalMs,
    latency: {
      avg: Math.round(avg(successLatencies)),
      p50: percentile(successLatencies, 50),
      p95: percentile(successLatencies, 95),
      p99: percentile(successLatencies, 99),
      max: successLatencies.length > 0 ? Math.max(...successLatencies) : 0,
      min: successLatencies.length > 0 ? Math.min(...successLatencies) : 0,
    },
    throughput: {
      totalSeconds: +(totalMs / 1000).toFixed(1),
      shotsPerSecond: +(count / (totalMs / 1000)).toFixed(2),
    },
    stability: {
      success: successful,
      failures,
      timeouts,
      successRate: +((successful / count) * 100).toFixed(1),
      memDeltaBytes: memAfter - memBefore,
      memDelta: formatBytes(memAfter - memBefore),
      cpuDeltaSeconds: +((cpuAfter - cpuBefore) / 1000).toFixed(1),
      largestSpikeWindow: findLargestSpikeWindow(successLatencies),
    },
    storage: fileSizes.length > 0 ? {
      avgFileSize: Math.round(avg(fileSizes)),
      avgFileSizeStr: formatBytes(avg(fileSizes)),
      minFileSize: Math.min(...fileSizes),
      maxFileSize: Math.max(...fileSizes),
      maxFileSizeStr: formatBytes(Math.max(...fileSizes)),
      totalCaptured: formatBytes(fileSizes.reduce((a, b) => a + b, 0)),
      diskGrowthPerMin: formatBytes((60000 / (totalMs / count)) * avg(fileSizes)),
      maxShots10GB: Math.floor((10 * 1024 * 1024 * 1024) / avg(fileSizes)),
    } : null,
    rawLatencies: latencies,
  };
}

// ═══════════════════════════════════════════════
// Stats Helpers
// ═══════════════════════════════════════════════

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

function avg(arr) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function formatBytes(b) {
  if (b < 0) return `-${formatBytes(-b)}`;
  if (b > 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  return (b / 1024).toFixed(0) + " KB";
}

/** Find the largest consecutive spike window (latencies > threshold) */
function findLargestSpikeWindow(latencies, thresholdMs = 500) {
  let maxStart = -1, maxLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < latencies.length; i++) {
    if (latencies[i] > thresholdMs) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > maxLen) { maxLen = curLen; maxStart = curStart; }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (maxLen === 0) return null;
  const spikeLatencies = latencies.slice(maxStart, maxStart + maxLen);
  return {
    startIndex: maxStart,
    length: maxLen,
    avgMs: Math.round(avg(spikeLatencies)),
    maxMs: Math.max(...spikeLatencies),
  };
}

/** Collect machine info */
function getMachineInfo() {
  const cpus = os.cpus();
  let monitors = "unknown";
  try {
    monitors = execSync("system_profiler SPDisplaysDataType 2>/dev/null | grep Resolution", { encoding: "utf-8" }).trim();
  } catch {}
  return {
    platform: os.platform(),
    arch: os.arch(),
    osVersion: os.release(),
    cpu: cpus[0]?.model || "unknown",
    cpuCount: cpus.length,
    totalMemory: formatBytes(os.totalmem()),
    freeMemory: formatBytes(os.freemem()),
    monitors,
    timestamp: new Date().toISOString(),
  };
}

/** Get a window ID for a specific app or first available */
async function getWindowId(bridge, appName) {
  try {
    const wins = await bridge.call("window.list");
    if (appName) {
      const match = wins.find((w) => w.ownerName === appName);
      if (match) return { windowId: match.windowId, ownerName: match.ownerName };
    }
    if (wins.length > 0) return { windowId: wins[0].windowId, ownerName: wins[0].ownerName };
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════
// Core Capture Runner
// ═══════════════════════════════════════════════

/**
 * Run N captures and collect all metrics.
 * @param {BridgeClient} bridge
 * @param {object} opts
 * @param {number} opts.count
 * @param {"full"|"window"} opts.mode
 * @param {number} [opts.windowId]
 * @param {boolean} [opts.safeCLI]
 * @param {number} [opts.delayMs] - delay between captures (for rate-limited tests)
 * @param {boolean} [opts.includeOCR] - also run OCR after capture
 * @param {boolean} [opts.quiet]
 */
async function runCaptures(bridge, opts) {
  const { count, mode, windowId, safeCLI = false, delayMs = 0, includeOCR = false, quiet = false } = opts;
  const latencies = [];
  const ocrLatencies = [];
  const fileSizes = [];
  let failures = 0;
  let timeouts = 0;
  const tempFiles = [];

  const cpuBefore = os.cpus().reduce((a, c) => a + c.times.user + c.times.sys, 0);
  const memBefore = process.memoryUsage().rss;
  const totalStart = Date.now();

  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    try {
      let result;
      if (mode === "window" && windowId) {
        result = await bridge.call("cg.captureWindow", { windowId, safeCLI });
      } else {
        result = await bridge.call("cg.captureScreen", {});
      }
      const elapsed = Date.now() - t0;
      latencies.push(elapsed);

      if (result.path) {
        try {
          const stat = fs.statSync(result.path);
          fileSizes.push(stat.size);
          tempFiles.push(result.path);
        } catch {}

        // OCR if requested
        if (includeOCR) {
          const ocrT0 = Date.now();
          try {
            await bridge.call("vision.ocr", { imagePath: result.path }, 20000);
            ocrLatencies.push(Date.now() - ocrT0);
          } catch {
            ocrLatencies.push(Date.now() - ocrT0);
          }
        }
      }

      if (!quiet && (i + 1) % Math.max(1, Math.floor(count / 10)) === 0) {
        const recent = latencies.slice(-Math.floor(count / 10));
        process.stdout.write(`   [${i + 1}/${count}] last avg: ${avg(recent).toFixed(0)}ms\n`);
      }

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    } catch (e) {
      const elapsed = Date.now() - t0;
      if (e.message.includes("Timeout")) timeouts++;
      else failures++;
      latencies.push(elapsed);
    }
  }

  const totalMs = Date.now() - totalStart;
  const cpuAfter = os.cpus().reduce((a, c) => a + c.times.user + c.times.sys, 0);
  const memAfter = process.memoryUsage().rss;

  // Cleanup
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }

  const successful = count - failures - timeouts;
  const successLatencies = latencies.slice(0, successful);

  return {
    count,
    mode,
    windowId: windowId || null,
    safeCLI,
    delayMs,
    totalMs,
    latency: {
      avg: Math.round(avg(successLatencies)),
      p50: percentile(successLatencies, 50),
      p95: percentile(successLatencies, 95),
      p99: percentile(successLatencies, 99),
      max: successLatencies.length > 0 ? Math.max(...successLatencies) : 0,
      min: successLatencies.length > 0 ? Math.min(...successLatencies) : 0,
    },
    throughput: {
      totalSeconds: +(totalMs / 1000).toFixed(1),
      shotsPerSecond: +(count / (totalMs / 1000)).toFixed(2),
    },
    stability: {
      success: successful,
      failures,
      timeouts,
      successRate: +((successful / count) * 100).toFixed(1),
      memDeltaBytes: memAfter - memBefore,
      memDelta: formatBytes(memAfter - memBefore),
      cpuDeltaSeconds: +((cpuAfter - cpuBefore) / 1000).toFixed(1),
      largestSpikeWindow: findLargestSpikeWindow(successLatencies),
    },
    storage: fileSizes.length > 0 ? {
      avgFileSize: Math.round(avg(fileSizes)),
      avgFileSizeStr: formatBytes(avg(fileSizes)),
      minFileSize: Math.min(...fileSizes),
      maxFileSize: Math.max(...fileSizes),
      maxFileSizeStr: formatBytes(Math.max(...fileSizes)),
      totalCaptured: formatBytes(fileSizes.reduce((a, b) => a + b, 0)),
      diskGrowthPerMin: formatBytes((60000 / (totalMs / count)) * avg(fileSizes)),
      maxShots10GB: Math.floor((10 * 1024 * 1024 * 1024) / avg(fileSizes)),
    } : null,
    ocr: ocrLatencies.length > 0 ? {
      avg: Math.round(avg(ocrLatencies)),
      p50: percentile(ocrLatencies, 50),
      p95: percentile(ocrLatencies, 95),
      max: ocrLatencies.length > 0 ? Math.max(...ocrLatencies) : 0,
    } : null,
    rawLatencies: latencies,
  };
}

// ═══════════════════════════════════════════════
// Test Cases
// ═══════════════════════════════════════════════

const TEST_CASES = {
  "SHOT-01": {
    name: "Raw Fullscreen Cold",
    description: "100 full-screen raw bridge captures on static screen",
    run: async (bridge) => runCaptures(bridge, { count: 100, mode: "full" }),
  },

  "SHOT-02": {
    name: "Raw Window Cold",
    description: "100 raw bridge captures of one fixed window",
    run: async (bridge) => {
      const win = await getWindowId(bridge);
      if (!win) return { error: "No windows available" };
      return runCaptures(bridge, { count: 100, mode: "window", windowId: win.windowId });
    },
  },

  "SHOT-03": {
    name: "Raw Fullscreen Endurance",
    description: "500 full-screen raw bridge captures",
    run: async (bridge) => runCaptures(bridge, { count: 500, mode: "full" }),
  },

  "SHOT-04": {
    name: "Raw Window Endurance",
    description: "500 window captures on one fixed window",
    run: async (bridge) => {
      const win = await getWindowId(bridge);
      if (!win) return { error: "No windows available" };
      return runCaptures(bridge, { count: 500, mode: "window", windowId: win.windowId });
    },
  },

  "SHOT-05": {
    name: "MCP Fullscreen Cold",
    description: "100 captures through real MCP stdio screenshot_file tool (measures full MCP overhead)",
    run: async (bridge) => {
      // First get raw bridge baseline for comparison
      console.log("   Phase 1: Raw bridge baseline (100 captures)...");
      const raw = await runCaptures(bridge, { count: 100, mode: "full", quiet: true });

      // Now run through real MCP stdio server
      console.log("   Phase 2: MCP stdio screenshot_file (100 captures)...");
      const mcp = new MCPClient();
      mcp.start();
      try {
        await mcp.initialize();
        const mcpResult = await runMCPCaptures(mcp, { count: 100, toolName: "screenshot_file" });

        return {
          rawBridge: { latency: raw.latency, throughput: raw.throughput, stability: raw.stability, storage: raw.storage },
          mcpStdio: { latency: mcpResult.latency, throughput: mcpResult.throughput, stability: mcpResult.stability, storage: mcpResult.storage },
          overhead: {
            avgMs: mcpResult.latency.avg - raw.latency.avg,
            p50Ms: mcpResult.latency.p50 - raw.latency.p50,
            p95Ms: mcpResult.latency.p95 - raw.latency.p95,
            throughputLoss: +(raw.throughput.shotsPerSecond - mcpResult.throughput.shotsPerSecond).toFixed(2),
            overheadPercent: +((mcpResult.latency.avg / raw.latency.avg - 1) * 100).toFixed(1),
          },
          // For gate evaluation, expose top-level latency/throughput/stability from MCP path
          latency: mcpResult.latency,
          throughput: mcpResult.throughput,
          stability: mcpResult.stability,
        };
      } finally {
        mcp.kill();
      }
    },
  },

  "SHOT-06": {
    name: "MCP Window Cold",
    description: "100 window captures through real MCP stdio screenshot_file tool",
    run: async (bridge) => {
      // Get a window ID via raw bridge first
      const win = await getWindowId(bridge);

      // Raw bridge window baseline
      console.log("   Phase 1: Raw bridge window baseline (100 captures)...");
      const raw = win
        ? await runCaptures(bridge, { count: 100, mode: "window", windowId: win.windowId, quiet: true })
        : await runCaptures(bridge, { count: 100, mode: "full", quiet: true });

      // MCP stdio window capture
      console.log("   Phase 2: MCP stdio screenshot_file with windowId (100 captures)...");
      const mcp = new MCPClient();
      mcp.start();
      try {
        await mcp.initialize();
        const toolArgs = win ? { windowId: win.windowId } : {};
        const mcpResult = await runMCPCaptures(mcp, { count: 100, toolName: "screenshot_file", toolArgs });

        return {
          windowId: win?.windowId || null,
          windowOwner: win?.ownerName || null,
          rawBridge: { latency: raw.latency, throughput: raw.throughput, stability: raw.stability },
          mcpStdio: { latency: mcpResult.latency, throughput: mcpResult.throughput, stability: mcpResult.stability },
          overhead: {
            avgMs: mcpResult.latency.avg - raw.latency.avg,
            overheadPercent: +((mcpResult.latency.avg / raw.latency.avg - 1) * 100).toFixed(1),
          },
        };
      } finally {
        mcp.kill();
      }
    },
  },

  "SHOT-07": {
    name: "Static vs Dynamic",
    description: "Compare captures on static vs rapidly changing content",
    run: async (bridge) => {
      console.log("   Phase 1: Static screen (50 captures)...");
      const staticResult = await runCaptures(bridge, { count: 50, mode: "full", quiet: true });

      // Trigger dynamic content — open a fast-updating page
      console.log("   Phase 2: Opening dynamic content...");
      try {
        execSync('osascript -e \'tell application "Safari" to activate\' 2>/dev/null', { timeout: 3000 });
        execSync('osascript -e \'tell application "Safari" to set URL of current tab of front window to "https://www.canva.com/templates"\' 2>/dev/null', { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 4000));
      } catch {}

      console.log("   Phase 3: Dynamic screen (50 captures)...");
      const dynamicResult = await runCaptures(bridge, { count: 50, mode: "full", quiet: true });

      return {
        static: { latency: staticResult.latency, storage: staticResult.storage, stability: staticResult.stability },
        dynamic: { latency: dynamicResult.latency, storage: dynamicResult.storage, stability: dynamicResult.stability },
        comparison: {
          latencyDiffMs: dynamicResult.latency.avg - staticResult.latency.avg,
          fileSizeDiffKB: staticResult.storage && dynamicResult.storage
            ? Math.round((dynamicResult.storage.avgFileSize - staticResult.storage.avgFileSize) / 1024)
            : null,
        },
      };
    },
  },

  "SHOT-08": {
    name: "Browser Stress",
    description: "Capture on Safari simple vs GPU-heavy page",
    run: async (bridge) => {
      const results = {};
      const pages = [
        { name: "Safari Start Page", url: "favorites://" },
        { name: "Safari Canva (GPU-heavy)", url: "https://www.canva.com/templates" },
      ];

      for (const page of pages) {
        console.log(`   Testing: ${page.name}...`);
        try {
          execSync('osascript -e \'tell application "Safari" to activate\' 2>/dev/null', { timeout: 3000 });
          execSync(`osascript -e 'tell application "Safari" to set URL of current tab of front window to "${page.url}"' 2>/dev/null`, { timeout: 5000 });
          await new Promise((r) => setTimeout(r, 4000));
        } catch {}

        const win = await getWindowId(bridge, "Safari");
        if (win) {
          // Test both CG API and safeCLI
          const cgResult = await runCaptures(bridge, { count: 30, mode: "window", windowId: win.windowId, safeCLI: false, quiet: true });
          const cliResult = await runCaptures(bridge, { count: 30, mode: "window", windowId: win.windowId, safeCLI: true, quiet: true });

          results[page.name] = {
            cgAPI: { latency: cgResult.latency, stability: cgResult.stability },
            safeCLI: { latency: cliResult.latency, stability: cliResult.stability },
          };
        } else {
          results[page.name] = { error: "Could not get Safari window" };
        }
      }
      return results;
    },
  },

  "SHOT-09": {
    name: "Perception Off vs On",
    description: "Compare capture performance with perception disabled then enabled",
    run: async (bridge) => {
      // Perception off = just raw captures, nothing else running
      console.log("   Phase 1: Perception OFF (100 captures)...");
      const offResult = await runCaptures(bridge, { count: 100, mode: "full" });

      // Perception on = AX polling + vision diff running concurrently
      // We simulate by running AX polls in parallel
      console.log("   Phase 2: Perception ON (simulated AX + captures)...");
      let axPollCount = 0;
      const axInterval = setInterval(async () => {
        try {
          const wins = await bridge.call("window.list", {}, 3000);
          if (wins && wins[0]) {
            await bridge.call("ax.getElementTree", { pid: wins[0].pid || 1, maxDepth: 5 }, 5000);
            axPollCount++;
          }
        } catch {}
      }, 500);

      const onResult = await runCaptures(bridge, { count: 100, mode: "full" });
      clearInterval(axInterval);

      return {
        perceptionOff: { latency: offResult.latency, throughput: offResult.throughput, stability: offResult.stability },
        perceptionOn: { latency: onResult.latency, throughput: onResult.throughput, stability: onResult.stability, axPollsDuringTest: axPollCount },
        interference: {
          avgLatencyDiffMs: onResult.latency.avg - offResult.latency.avg,
          p95LatencyDiffMs: onResult.latency.p95 - offResult.latency.p95,
          throughputDiffSps: +(onResult.throughput.shotsPerSecond - offResult.throughput.shotsPerSecond).toFixed(2),
        },
      };
    },
  },

  "SHOT-10": {
    name: "OCR Coupling",
    description: "Compare screenshot_file vs screenshot (with OCR) vs OCR-only",
    run: async (bridge) => {
      console.log("   Phase 1: Capture only (50 shots)...");
      const captureOnly = await runCaptures(bridge, { count: 50, mode: "full", quiet: true });

      console.log("   Phase 2: Capture + OCR (50 shots)...");
      const captureOCR = await runCaptures(bridge, { count: 50, mode: "full", includeOCR: true, quiet: true });

      return {
        captureOnly: { latency: captureOnly.latency },
        captureWithOCR: { latency: captureOCR.latency, ocrLatency: captureOCR.ocr },
        ocrOverhead: {
          avgMs: captureOCR.ocr ? captureOCR.ocr.avg : null,
          totalOverheadMs: captureOCR.latency.avg + (captureOCR.ocr?.avg || 0) - captureOnly.latency.avg,
          note: "OCR overhead = (capture+OCR avg) - (capture-only avg)",
        },
      };
    },
  },

  "SHOT-11": {
    name: "Sustained Rate Sweep",
    description: "5min sustained capture at different rates to find stable max",
    run: async (bridge) => {
      const rates = [10, 5, 2, 1]; // shots per second
      const durationSec = 60; // 1 min per rate (reduced from 5 for practicality)
      const results = {};

      for (const rate of rates) {
        const delayMs = Math.max(0, Math.round(1000 / rate) - 65); // subtract avg capture time
        const count = rate * durationSec;
        console.log(`   Rate: ${rate}/s (${count} captures, ~${durationSec}s)...`);
        const result = await runCaptures(bridge, { count, mode: "full", delayMs, quiet: true });
        results[`${rate}_per_sec`] = {
          targetRate: rate,
          actualRate: result.throughput.shotsPerSecond,
          latency: result.latency,
          stability: result.stability,
          spike: result.stability.largestSpikeWindow,
        };
      }

      // Find highest stable rate (p95 < 500ms, no spike > 5 consecutive)
      let bestRate = null;
      for (const [key, r] of Object.entries(results)) {
        const spike = r.spike;
        if (r.latency.p95 < 500 && (!spike || spike.length < 5)) {
          if (!bestRate || r.targetRate > bestRate.targetRate) bestRate = r;
        }
      }

      return { rates: results, recommendedMaxRate: bestRate?.targetRate || 1 };
    },
  },

  "SHOT-12": {
    name: "Restart Stability",
    description: "Capture, restart bridge, resume capture — check for degradation",
    run: async (bridge) => {
      console.log("   Phase 1: Pre-restart (50 captures)...");
      const before = await runCaptures(bridge, { count: 50, mode: "full", quiet: true });

      console.log("   Restarting bridge...");
      bridge.restart();
      await bridge.ping();

      console.log("   Phase 2: Post-restart (50 captures)...");
      const after = await runCaptures(bridge, { count: 50, mode: "full", quiet: true });

      return {
        beforeRestart: { latency: before.latency, stability: before.stability },
        afterRestart: { latency: after.latency, stability: after.stability },
        degradation: {
          avgLatencyDiffMs: after.latency.avg - before.latency.avg,
          successRateDiff: after.stability.successRate - before.stability.successRate,
          verdict: Math.abs(after.latency.avg - before.latency.avg) < 50 ? "PASS" : "DEGRADED",
        },
      };
    },
  },

  "SHOT-13": {
    name: "Multi-Monitor",
    description: "Full-screen capture — file size and latency for current monitor setup",
    run: async (bridge) => {
      let monitors = "unknown";
      try {
        monitors = execSync("system_profiler SPDisplaysDataType 2>/dev/null | grep -E 'Resolution|Display Type'", { encoding: "utf-8" }).trim();
      } catch {}

      const result = await runCaptures(bridge, { count: 50, mode: "full", quiet: true });
      return {
        monitors,
        latency: result.latency,
        storage: result.storage,
        note: "Compare file size against single-monitor baseline. Multi-monitor captures include all screens.",
      };
    },
  },

  "SHOT-14": {
    name: "Long-Run Storage Limit",
    description: "Estimate storage budgets from measured file sizes",
    run: async (bridge) => {
      console.log("   Sampling 50 captures for file size distribution...");
      const result = await runCaptures(bridge, { count: 50, mode: "full", quiet: true });
      if (!result.storage) return { error: "No file size data" };

      const avgBytes = result.storage.avgFileSize;
      const maxBytes = result.storage.maxFileSize;
      const captureMs = result.latency.avg;
      const capturesPerMin = 60000 / captureMs;

      return {
        avgFileSizeKB: Math.round(avgBytes / 1024),
        maxFileSizeKB: Math.round(maxBytes / 1024),
        maxCaptureRatePerMin: Math.round(capturesPerMin),
        budgets: {
          "1GB": { maxShots: Math.floor((1024 * 1024 * 1024) / avgBytes), atMaxRate: `${Math.round((1024 * 1024 * 1024) / avgBytes / capturesPerMin)} min` },
          "10GB": { maxShots: Math.floor((10 * 1024 * 1024 * 1024) / avgBytes), atMaxRate: `${Math.round((10 * 1024 * 1024 * 1024) / avgBytes / capturesPerMin)} min` },
          "50GB": { maxShots: Math.floor((50 * 1024 * 1024 * 1024) / avgBytes), atMaxRate: `${Math.round((50 * 1024 * 1024 * 1024) / avgBytes / capturesPerMin)} min` },
        },
        perMinAtMaxRate: formatBytes(capturesPerMin * avgBytes),
        perHourAtMaxRate: formatBytes(capturesPerMin * avgBytes * 60),
        perMinAt2PerSec: formatBytes(120 * avgBytes),
        perHourAt2PerSec: formatBytes(120 * avgBytes * 60),
      };
    },
  },
};

// ═══════════════════════════════════════════════
// Pass/Fail Gates
// ═══════════════════════════════════════════════

function evaluateGates(results) {
  const gates = [];

  // P1: No crashes in 500 endurance
  const shot03 = results["SHOT-03"];
  if (shot03 && !shot03.error) {
    gates.push({
      id: "P1-endurance-stability",
      pass: shot03.stability.failures === 0 && shot03.stability.timeouts === 0,
      detail: `${shot03.stability.failures} failures, ${shot03.stability.timeouts} timeouts in 500 captures`,
    });
  }

  // P1: >=99% success in cold and endurance
  for (const id of ["SHOT-01", "SHOT-03"]) {
    const r = results[id];
    if (r && !r.error) {
      gates.push({
        id: `P1-success-rate-${id}`,
        pass: r.stability.successRate >= 99,
        detail: `${r.stability.successRate}% success`,
      });
    }
  }

  // P1: No unbounded memory growth
  const shot03mem = results["SHOT-03"];
  if (shot03mem && !shot03mem.error) {
    gates.push({
      id: "P1-memory-bounded",
      pass: shot03mem.stability.memDeltaBytes < 50 * 1024 * 1024, // < 50MB
      detail: shot03mem.stability.memDelta,
    });
  }

  // P2: MCP overhead quantified
  const shot05 = results["SHOT-05"];
  if (shot05 && !shot05.error && shot05.overhead) {
    gates.push({
      id: "P2-mcp-overhead-quantified",
      pass: true,
      detail: `Raw: ${shot05.rawBridge.latency.avg}ms → MCP: ${shot05.mcpStdio.latency.avg}ms (+${shot05.overhead.overheadPercent}%)`,
    });
  }

  // P2: Perception interference quantified
  const shot09 = results["SHOT-09"];
  if (shot09 && !shot09.error && shot09.interference) {
    gates.push({
      id: "P2-perception-interference",
      pass: shot09.interference.avgLatencyDiffMs < 100,
      detail: `+${shot09.interference.avgLatencyDiffMs}ms avg with perception`,
    });
  }

  // P2: OCR overhead quantified
  const shot10 = results["SHOT-10"];
  if (shot10 && !shot10.error && shot10.ocrOverhead) {
    gates.push({
      id: "P2-ocr-overhead",
      pass: true,
      detail: `OCR adds ~${shot10.ocrOverhead.avgMs || "?"}ms per capture`,
    });
  }

  return gates;
}

// ═══════════════════════════════════════════════
// Main Runner
// ═══════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  let testsToRun;

  if (args.includes("--priority")) {
    testsToRun = ["SHOT-05", "SHOT-09", "SHOT-11"];
  } else if (args.length > 0 && args[0].startsWith("SHOT-")) {
    testsToRun = args.filter((a) => a.startsWith("SHOT-"));
  } else {
    testsToRun = Object.keys(TEST_CASES);
  }

  const machine = getMachineInfo();
  console.log("\n" + "=".repeat(60));
  console.log("  SCREENSHOT BENCHMARK SUITE");
  console.log("=".repeat(60));
  console.log(`  Machine: ${machine.cpu}`);
  console.log(`  OS: ${machine.platform} ${machine.osVersion}`);
  console.log(`  CPUs: ${machine.cpuCount} | RAM: ${machine.totalMemory}`);
  console.log(`  Monitors: ${machine.monitors.split("\n")[0]?.trim() || "unknown"}`);
  console.log(`  Tests: ${testsToRun.join(", ")}`);
  console.log("=".repeat(60) + "\n");

  const bridge = new BridgeClient();
  bridge.start();
  await bridge.ping();

  const results = {};
  const timings = {};

  for (const testId of testsToRun) {
    const test = TEST_CASES[testId];
    if (!test) {
      console.log(`  [SKIP] ${testId} — unknown test\n`);
      continue;
    }

    console.log(`\n${"─".repeat(55)}`);
    console.log(`  ${testId}: ${test.name}`);
    console.log(`  ${test.description}`);
    console.log(`${"─".repeat(55)}`);

    const t0 = Date.now();
    try {
      results[testId] = await test.run(bridge);
      timings[testId] = Date.now() - t0;
      console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      // Print quick summary
      const r = results[testId];
      // MCP overhead tests (SHOT-05, SHOT-06) — show both raw and MCP
      if (r.rawBridge && r.mcpStdio && r.overhead) {
        console.log(`  Raw bridge:  avg=${r.rawBridge.latency.avg}ms p50=${r.rawBridge.latency.p50}ms p95=${r.rawBridge.latency.p95}ms | ${r.rawBridge.throughput.shotsPerSecond} shots/s`);
        console.log(`  MCP stdio:   avg=${r.mcpStdio.latency.avg}ms p50=${r.mcpStdio.latency.p50}ms p95=${r.mcpStdio.latency.p95}ms | ${r.mcpStdio.throughput.shotsPerSecond} shots/s`);
        console.log(`  Overhead:    +${r.overhead.avgMs}ms avg (+${r.overhead.overheadPercent}%) | throughput loss: ${r.overhead.throughputLoss} shots/s`);
      } else if (r.latency) {
        console.log(`  avg=${r.latency.avg}ms p50=${r.latency.p50}ms p95=${r.latency.p95}ms p99=${r.latency.p99}ms max=${r.latency.max}ms`);
      }
      if (!r.rawBridge && r.throughput) {
        console.log(`  ${r.throughput.shotsPerSecond} shots/s | success: ${r.stability?.successRate}%`);
      }
      if (r.stability?.largestSpikeWindow) {
        const s = r.stability.largestSpikeWindow;
        console.log(`  SPIKE: ${s.length} consecutive captures >500ms (avg ${s.avgMs}ms, max ${s.maxMs}ms) starting at #${s.startIndex}`);
      }
    } catch (e) {
      results[testId] = { error: e.message };
      timings[testId] = Date.now() - t0;
      console.log(`  ERROR: ${e.message}`);
    }
  }

  // ── Pass/Fail Gates ──
  const gates = evaluateGates(results);
  if (gates.length > 0) {
    console.log(`\n${"=".repeat(55)}`);
    console.log("  PASS/FAIL GATES");
    console.log(`${"=".repeat(55)}`);
    for (const g of gates) {
      console.log(`  ${g.pass ? "PASS" : "FAIL"} ${g.id}: ${g.detail}`);
    }
  }

  // ── Save results ──
  const outDir = path.join(os.homedir(), ".screenhand", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  // Strip rawLatencies to keep file small
  const saveResults = JSON.parse(JSON.stringify(results));
  for (const r of Object.values(saveResults)) {
    if (r.rawLatencies) delete r.rawLatencies;
  }

  fs.writeFileSync(outFile, JSON.stringify({ machine, tests: saveResults, timings, gates, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\n  Results saved: ${outFile}`);
  console.log(`${"=".repeat(55)}\n`);

  bridge.kill();
  process.exit(gates.some((g) => !g.pass) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
