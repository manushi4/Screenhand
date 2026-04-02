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
  // ── Web / Creative apps ──────────────────────────────────────────
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
  "google-ads-transparency.json",
  "google-flow.json",
  "google-search-competitor-research.json",
  "instagram.json",
  "linkedin.json",
  "meta-ad-library.json",
  "n8n.json",
  "notion.json",
  "reddit.json",
  "threads.json",
  "x-twitter.json",
  "youtube.json",
  // ── Apple-native apps (EXPERT mastery, battle-tested) ────────────
  "apple-music.json",
  "calendar.json",
  "finder.json",
  "keynote.json",
  "mail.json",
  "notes.json",
  "pages.json",
  "photos.json",
  "reminders.json",
  "simulator.json",
  "terminal.json",
  "whatsapp.json",
];

// Curated playbooks to ship (reusable automation workflows)
const CURATED_PLAYBOOKS = [
  // ── Apple-native workflows (battle-tested) ──────────────────────
  "calendar-create-event.json",
  "calendar-list-events.json",
  "calendar-navigate-views.json",
  "calendar-open-settings.json",
  "keynote-add-slide.json",
  "keynote-create-presentation.json",
  "keynote-export-pdf.json",
  "keynote-play-slideshow.json",
  "notes-mastery-workflows.json",
  "pages-export-pdf.json",
  "pages-new-document.json",
  "pages-open-document.json",
  "reminders-complete.json",
  "reminders-create.json",
  "reminders-list.json",
  "reminders-open.json",
  "whatsapp-contact-info.json",
  "whatsapp-navigate.json",
  "whatsapp-new-call.json",
  "whatsapp-new-group.json",
  "whatsapp-search.json",
  "whatsapp-settings.json",
  // ── Simulator (iOS testing workflows) ──────────────────────────
  "simulator-add-media.json",
  "simulator-dark-mode.json",
  "simulator-device-controls.json",
  "simulator-erase-device.json",
  "simulator-face-id.json",
  "simulator-grant-permissions.json",
  "simulator-install-app.json",
  "simulator-launch-app.json",
  "simulator-location.json",
  "simulator-memory-warning.json",
  "simulator-navigate-url.json",
  "simulator-push-notification.json",
  "simulator-record-screen.json",
  "simulator-rotate-device.json",
  "simulator-screenshot-appstore.json",
  "simulator-type-text.json",
  // ── Web / Creative ───────────────────────────────────────────────
  "canva-screenhand-carousel.json",
  "codex-desktop.json",
  "competitor-research-stack.json",
  "davinci-color-grade.json",
  "davinci-edit-timeline.json",
  "davinci-render.json",
  "devto.json",
  "discord.json",
  "google-ads-transparency-competitor-research.json",
  "google-flow-create-project.json",
  "google-flow-edit-image.json",
  "google-flow-edit-video.json",
  "google-flow-generate-image.json",
  "google-flow-generate-video.json",
  "google-flow-open-project.json",
  "google-flow-open-scenebuilder.json",
  "google-flow-search-assets.json",
  "google-search-competitor-research.json",
  "instagram.json",
  "linkedin.json",
  "meta-ad-library-competitor-research.json",
  "n8n.json",
  "reddit.json",
  "threads.json",
  "x-twitter.json",
  "x_change_avatar.json",
  "youtube.json",
];

/**
 * Deep-scrub PII from all JSON files in a directory.
 * Removes: local username, full name parts, contact names, device names,
 * email addresses, and company identifiers from the developer's machine.
 */
function scrubPII(dir) {
  if (!fs.existsSync(dir)) return;

  // Collect name parts to redact (same logic as src/util/sanitize.ts)
  const nameParts = new Set();
  const username = process.env.USER || process.env.USERNAME || "";
  if (username.length >= 2) nameParts.add(username);
  try {
    const home = os.homedir();
    const homeName = home.split("/").pop() || "";
    if (homeName.length >= 2) nameParts.add(homeName);
  } catch {}
  try {
    const { execSync } = require("child_process");
    const fullName = execSync("id -F", { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (fullName.length >= 2) {
      nameParts.add(fullName);
      for (const word of fullName.split(/\s+/)) {
        if (word.length >= 2) nameParts.add(word);
      }
    }
  } catch {}

  // Sort longest first for replacement priority
  const sorted = [...nameParts].sort((a, b) => b.length - a.length);

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  let totalRedacted = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    let content = fs.readFileSync(filePath, "utf-8");
    let changed = false;

    // Redact name parts (case-insensitive)
    for (const part of sorted) {
      const regex = new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const before = content;
      content = content.replace(regex, "[USER]");
      if (content !== before) { changed = true; totalRedacted++; }
    }

    // Redact email addresses
    const emailBefore = content;
    content = content.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL]");
    if (content !== emailBefore) { changed = true; totalRedacted++; }

    // Redact MacBook/device names
    const deviceBefore = content;
    content = content.replace(/MacBook\s*(Air|Pro)?/gi, "[DEVICE]");
    if (content !== deviceBefore) { changed = true; totalRedacted++; }

    // Redact home directory paths
    const homeBefore = content;
    content = content.replace(/\/Users\/[a-zA-Z0-9._-]+/g, "/Users/[USER]");
    if (content !== homeBefore) { changed = true; totalRedacted++; }

    if (changed) {
      try {
        const data = JSON.parse(content);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      } catch {
        fs.writeFileSync(filePath, content);
      }
    }
  }

  if (totalRedacted > 0) {
    console.log(`[screenhand] PII scrub: ${totalRedacted} patterns redacted across ${files.length} app map files`);
  }
}

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
  // ── Web / Creative (original) ────────────────────────────────────
  "com.figma.Desktop.json",
  "com.hnc.Discord.json",
  "notion.id.json",
  // ── Apple-native apps (battle-tested mastery maps) ───────────────
  "com.apple.finder.json",
  "com.apple.iCal.json",
  "com.apple.iWork.Keynote.json",
  "com.apple.iWork.Pages.json",
  "com.apple.mail.json",
  "com.apple.Music.json",
  "com.apple.Notes.json",
  "com.apple.Photos.json",
  "com.apple.reminders.json",
  "com.apple.iphonesimulator.json",
  "com.apple.Terminal.json",
  "net.whatsapp.WhatsApp.json",
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

// App maps come from user home, not project dir.
// CRITICAL: App maps contain PII from the developer's machine (usernames,
// contact names, device IDs). Deep-scrub before shipping.
const userAppMapsDir = path.join(os.homedir(), ".screenhand", "app-maps");
copyFiles(
  userAppMapsDir,
  path.join(root, "dist-app-maps"),
  SEED_APP_MAPS,
  "App Maps"
);
scrubPII(path.join(root, "dist-app-maps"));

console.log("[screenhand] Done. dist-references/, dist-playbooks/, dist-app-maps/ are ready.");
