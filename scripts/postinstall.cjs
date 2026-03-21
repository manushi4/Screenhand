#!/usr/bin/env node
"use strict";

/**
 * postinstall script — copies the correct prebuilt native bridge binary
 * into bin/ so the MCP server can find it at runtime.
 *
 * If no prebuilt binary exists for this platform+arch, falls back to
 * building from source (requires Swift on macOS / .NET on Windows).
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const platform = process.platform; // "darwin" | "win32" | "linux"
const arch = process.arch; // "arm64" | "x64"
const root = path.resolve(__dirname, "..");

// Where prebuilt binaries live in the npm package
const prebuiltDir = path.join(root, "bin", `${platform}-${arch}`);

// Where the bridge-client expects to find the binary at runtime
const runtimeDir = path.join(root, "bin");

function log(msg) {
  console.log(`[screenhand] ${msg}`);
}

function hasBinary() {
  if (platform === "win32") {
    return fs.existsSync(path.join(prebuiltDir, "windows-bridge.exe"));
  }
  return fs.existsSync(path.join(prebuiltDir, "macos-bridge"));
}

function buildFromSource() {
  if (platform === "darwin") {
    const swiftProject = path.join(root, "native", "macos-bridge");
    if (!fs.existsSync(path.join(swiftProject, "Package.swift"))) {
      log("No Swift source found — skipping native build.");
      log("Desktop automation tools will not be available.");
      return false;
    }
    log("Building native bridge from source (Swift)...");
    try {
      execSync("swift build -c release", {
        cwd: swiftProject,
        stdio: "inherit",
        timeout: 120_000,
      });
      // Copy built binary to bin/
      const built = path.join(
        swiftProject,
        ".build",
        `${arch}-apple-macosx`,
        "release",
        "macos-bridge"
      );
      if (!fs.existsSync(built)) {
        // Try the generic release path
        const genericBuilt = path.join(swiftProject, ".build", "release", "macos-bridge");
        if (fs.existsSync(genericBuilt)) {
          fs.mkdirSync(prebuiltDir, { recursive: true });
          fs.copyFileSync(genericBuilt, path.join(prebuiltDir, "macos-bridge"));
          return true;
        }
        log("Build succeeded but binary not found at expected path.");
        return false;
      }
      fs.mkdirSync(prebuiltDir, { recursive: true });
      fs.copyFileSync(built, path.join(prebuiltDir, "macos-bridge"));
      return true;
    } catch {
      log("Swift build failed. Install Xcode Command Line Tools: xcode-select --install");
      return false;
    }
  }

  if (platform === "win32") {
    const dotnetProject = path.join(root, "native", "windows-bridge");
    if (!fs.existsSync(path.join(dotnetProject, "windows-bridge.csproj"))) {
      log("No .NET source found — skipping native build.");
      return false;
    }
    log("Building native bridge from source (.NET)...");
    try {
      execSync("dotnet build -c Release", {
        cwd: dotnetProject,
        stdio: "inherit",
        timeout: 120_000,
      });
      const built = path.join(
        dotnetProject,
        "bin",
        "Release",
        "net8.0-windows",
        "windows-bridge.exe"
      );
      if (fs.existsSync(built)) {
        fs.mkdirSync(prebuiltDir, { recursive: true });
        fs.copyFileSync(built, path.join(prebuiltDir, "windows-bridge.exe"));
        return true;
      }
      return false;
    } catch {
      log(".NET build failed. Install .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0");
      return false;
    }
  }

  log(`Unsupported platform: ${platform}. ScreenHand supports macOS and Windows.`);
  return false;
}

// Main
if (hasBinary()) {
  log(`Prebuilt binary found for ${platform}-${arch}.`);
} else {
  log(`No prebuilt binary for ${platform}-${arch}. Attempting build from source...`);
  if (buildFromSource()) {
    log("Native bridge built successfully.");
  } else {
    log("Could not build native bridge. Some tools will be unavailable.");
    log("You can build manually: npm run build:native");
  }
}
