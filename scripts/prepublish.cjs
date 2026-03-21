#!/usr/bin/env node
"use strict";

/**
 * prepublish script — copies curated references and playbooks into
 * dist-references/ and dist-playbooks/ for npm distribution.
 *
 * Only ships platform knowledge that benefits all users.
 * Excludes: *-learned, *-explore, *-smoke-test, *-competitor-research,
 * session-specific playbooks (mm* IDs), .bak files, test files.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");

// Curated reference files to ship (platform knowledge useful to everyone)
const CURATED_REFERENCES = [
  "canva.json",
  "codex-desktop.json",
  "davinci-resolve-keyboard.json",
  "davinci-resolve-menu-map.json",
  "davinci-resolve-menus-batch1.json",
  "davinci-resolve-menus-batch2.json",
  "davinci-resolve-menus-batch3.json",
  "davinci-resolve-menus-batch4.json",
  "davinci-resolve-shortcuts.json",
  "devpost.json",
  "devto.json",
  "discord.json",
  "figma.json",
  "finder.json",
  "google-ads-transparency.json",
  "google-flow.json",
  "instagram.json",
  "linkedin.json",
  "meta-ad-library.json",
  "n8n.json",
  "notes.json",
  "notion.json",
  "reddit.json",
  "threads.json",
  "x-twitter.json",
  "youtube.json",
];

// Curated playbooks to ship (reusable automation workflows)
const CURATED_PLAYBOOKS = [
  "canva-screenhand-carousel.json",
  "codex-desktop.json",
  "competitor-research-stack.json",
  "davinci-color-grade.json",
  "davinci-edit-timeline.json",
  "davinci-render.json",
  "devto.json",
  "discord.json",
  "google-flow-create-project.json",
  "google-flow-edit-image.json",
  "google-flow-edit-video.json",
  "google-flow-generate-image.json",
  "google-flow-generate-video.json",
  "google-flow-open-project.json",
  "google-flow-open-scenebuilder.json",
  "google-flow-search-assets.json",
  "instagram.json",
  "linkedin.json",
  "n8n.json",
  "reddit.json",
  "threads.json",
  "x-twitter.json",
  "youtube.json",
];

function copyFiles(srcDir, destDir, fileList, label) {
  // Clean and recreate
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  let copied = 0;
  let skipped = 0;

  for (const file of fileList) {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      copied++;
    } else {
      console.log(`  [skip] ${file} (not found)`);
      skipped++;
    }
  }

  console.log(`[screenhand] ${label}: ${copied} files copied, ${skipped} skipped`);
}

// Seed app maps — structural UI knowledge (zones, nav graph, elements) for popular apps.
// Sourced from ~/.screenhand/app-maps/. Only ship maps, not .bak or .ladder files.
const SEED_APP_MAPS = [
  "com.figma.Desktop.json",
  "com.hnc.Discord.json",
  "notion.id.json",
];

// Main
console.log("[screenhand] Preparing curated data for publish...");

copyFiles(
  path.join(root, "references"),
  path.join(root, "dist-references"),
  CURATED_REFERENCES,
  "References"
);

copyFiles(
  path.join(root, "playbooks"),
  path.join(root, "dist-playbooks"),
  CURATED_PLAYBOOKS,
  "Playbooks"
);

// App maps come from user home, not project dir
const userAppMapsDir = path.join(os.homedir(), ".screenhand", "app-maps");
copyFiles(
  userAppMapsDir,
  path.join(root, "dist-app-maps"),
  SEED_APP_MAPS,
  "App Maps"
);

console.log("[screenhand] Done. dist-references/, dist-playbooks/, dist-app-maps/ are ready.");
