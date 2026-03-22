// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileAtomicSync, readJsonWithRecovery } from "../util/atomic-write.js";
import { redactPII } from "../util/sanitize.js";
import type {
  AppMapData,
  AppMapConfig,
  MapZone,
  MapElement,
  NavNode,
  NavEdge,
  MasteryLevel,
  FeatureTier,
  MasteryMetrics,
  RelativePosition,
  FeatureDefinition,
  FeatureMastery,
  Rating,
  RatingFactors,
  RatingGrade,
  RatingSubTier,
  ElementHierarchy,
  ElementContract,
  ContractOutcome,
  VisibilityCondition,
  StateDimension,
  StateTransition,
  TimingProfile,
  ReadySignal,
} from "./app-map-types.js";
import { DEFAULT_APP_MAP_CONFIG, GRADE_THRESHOLDS, RATING_FACTOR_WEIGHTS, ratingToString } from "./app-map-types.js";
import { generateLadderFromReference, type ReferenceData, type GeneratedLadder } from "./ladder-generator.js";
import type { TopologyPolicy } from "../learning/topology-policy.js";

// ── Built-in Feature Ladders ───────────────────────────────────────
// Define what real users do at each level. Used to measure honest mastery.

const BUILTIN_LADDERS: Record<string, FeatureDefinition[]> = {
  "com.hnc.Discord": [
    // ── Beginner: basic consumer actions (weight 1) ──
    { id: "browse_channels", description: "Join servers and browse channels", level: "beginner", weight: 1, critical: false },
    { id: "send_message", description: "Send messages, replies, emojis, and reactions", level: "beginner", weight: 1, critical: false },
    { id: "direct_messages", description: "Direct messages and group chats", level: "beginner", weight: 1, critical: false },
    { id: "voice_video", description: "Voice channels, video calls, and screen share", level: "beginner", weight: 1, critical: false },
    // ── Pro: operational features (weight 2) ──
    { id: "threads_forums", description: "Create and manage threads and forum channels", level: "pro", weight: 2, critical: false },
    { id: "roles_permissions", description: "Configure roles, overrides, inheritance, hidden channels", level: "pro", weight: 2, critical: true },
    { id: "events_stage", description: "Schedule events, run Stage channels, manage speakers", level: "pro", weight: 2, critical: false },
    { id: "onboarding_funnel", description: "Build join flows: rules screening, role assignment, starter channels", level: "pro", weight: 2, critical: true },
    { id: "notification_control", description: "Channel overrides, mention control, suppression settings", level: "pro", weight: 1, critical: false },
    // ── Expert: system-level features (weight 2-3) ──
    { id: "moderation_system", description: "Configure AutoMod, mod bots, alert flows, ban appeals, raid defense", level: "expert", weight: 3, critical: true },
    { id: "bot_ecosystem", description: "Combine bots, slash commands, webhooks into coherent server OS", level: "expert", weight: 3, critical: true },
    { id: "server_architecture", description: "Design categories, channel taxonomy, permissions, escalation paths", level: "expert", weight: 3, critical: true },
    { id: "community_growth", description: "Events, role rewards, content loops, announcements, retention mechanics", level: "expert", weight: 2, critical: false },
    { id: "analytics_health", description: "Track activity patterns, onboarding drop-off, channel usage, retention", level: "expert", weight: 2, critical: true },
    // ── Grandmaster: mastery-level operations (weight 3) ──
    { id: "monetization_membership", description: "Premium roles, gated channels, supporter tiers, creator monetization", level: "grandmaster", weight: 2, critical: false },
    { id: "crisis_handling", description: "Handle raids, harassment, spam, leaks, impersonation, conflicts", level: "grandmaster", weight: 3, critical: true },
    { id: "cross_platform", description: "Connect Discord with GitHub, Notion, Twitch, Stripe, Zapier, tools", level: "grandmaster", weight: 2, critical: false },
    { id: "staff_system", description: "Structure mod roles, escalation, internal channels, review processes", level: "grandmaster", weight: 3, critical: true },
    { id: "brand_culture", description: "Shape tone, rituals, norms, recognition systems, community identity", level: "grandmaster", weight: 2, critical: false },
    { id: "governance_policy", description: "Define rules, enforcement, appeals, social boundaries that hold up", level: "grandmaster", weight: 3, critical: true },
  ],
  "com.apple.Safari": [
    { id: "browse_navigate", description: "Open URLs and navigate pages", level: "beginner", weight: 1, critical: false },
    { id: "tabs_windows", description: "Manage tabs and windows", level: "beginner", weight: 1, critical: false },
    { id: "bookmarks", description: "Bookmarks and reading list", level: "beginner", weight: 1, critical: false },
    { id: "history_search", description: "History and search", level: "beginner", weight: 1, critical: false },
    { id: "tab_groups", description: "Tab groups and profiles", level: "pro", weight: 2, critical: false },
    { id: "extensions", description: "Install and use extensions", level: "pro", weight: 2, critical: false },
    { id: "dev_tools", description: "Web Inspector and developer tools", level: "expert", weight: 2, critical: true },
    { id: "privacy_settings", description: "Privacy, cookies, and content blockers", level: "expert", weight: 2, critical: false },
    { id: "web_apps", description: "Add to Dock, web apps, notifications", level: "grandmaster", weight: 2, critical: false },
  ],
  "com.apple.finder": [
    { id: "browse_files", description: "Browse and open files/folders", level: "beginner", weight: 1, critical: false },
    { id: "copy_move", description: "Copy, move, rename, delete files", level: "beginner", weight: 1, critical: false },
    { id: "search", description: "Spotlight and Finder search", level: "beginner", weight: 1, critical: false },
    { id: "views_sort", description: "Change views, sort, and organize", level: "pro", weight: 2, critical: false },
    { id: "tags_favorites", description: "Tags, favorites, and sidebar", level: "pro", weight: 2, critical: false },
    { id: "quick_actions", description: "Quick Look, Quick Actions, and Services", level: "expert", weight: 2, critical: true },
    { id: "automator_scripts", description: "Automator, terminal, and scripting", level: "grandmaster", weight: 2, critical: false },
  ],
};

/** Generic fallback ladder — used when no builtin AND no reference-generated ladder exists. */
const GENERIC_LADDER: FeatureDefinition[] = [
  { id: "basic_navigation", description: "Open, navigate, and browse the app", level: "beginner", weight: 1, critical: false },
  { id: "core_action", description: "Perform the app's primary action", level: "beginner", weight: 1, critical: false },
  { id: "settings", description: "Configure settings and preferences", level: "pro", weight: 2, critical: false },
  { id: "advanced_features", description: "Use advanced/power-user features", level: "expert", weight: 2, critical: true },
  { id: "automation", description: "Automate or customize workflows", level: "grandmaster", weight: 3, critical: true },
];

/** Redact an array of user-facing strings in place, returning a new array. */
function redactStrings(strings: string[]): string[] {
  return strings.map((s) => redactPII(s));
}

/**
 * AppMap — persistent spatial understanding of application UIs.
 *
 * One JSON file per app at `~/.screenhand/app-maps/{bundleId}.json`.
 * Stores zones, elements with relative positions, navigation graph,
 * and game-style ratings (F → E → D → C → B → A → S → SS → SSS → 0).
 *
 * Uses full JSON (not JSONL) because the map is a structured document.
 * Atomic writes via writeFileAtomicSync + readJsonWithRecovery for
 * crash safety.
 */
// Max page:: zones per app (separate from maxZonesPerApp to prevent title explosion)
const MAX_PAGE_ZONES = 20;

/**
 * Normalize dynamic page context strings to prevent zone explosion.
 * Collapses UUIDs, timestamps, numeric IDs, file extensions, and hashes
 * into stable placeholders so similar pages share a zone.
 */
function normalizePageContext(ctx: string): string {
  return ctx
    // UUIDs: 8-4-4-4-12 hex
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    // Long hex hashes (8+ chars)
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hash>")
    // ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/g, "<time>")
    // Date-like patterns
    .replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, "<date>")
    // Standalone numeric IDs (3+ digits)
    .replace(/\b\d{3,}\b/g, "<num>")
    // File extensions at the end
    .replace(/\.\w{1,5}$/, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

export class AppMap {
  private readonly config: AppMapConfig;
  private readonly cache = new Map<string, AppMapData>();
  private readonly dirty = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cache of auto-generated ladders (from reference files) */
  private readonly generatedLadderCache = new Map<string, GeneratedLadder>();
  /** Wire #11: TopologyPolicy reference for Bayesian edge scoring */
  private topologyPolicy: TopologyPolicy | null = null;

  constructor(config?: Partial<AppMapConfig>) {
    this.config = {
      ...DEFAULT_APP_MAP_CONFIG,
      mapsDir:
        config?.mapsDir ??
        path.join(os.homedir(), ".screenhand", "app-maps"),
      ...config,
    };
  }

  init(): void {
    fs.mkdirSync(this.config.mapsDir, { recursive: true });
  }

  /** Wire #11: Connect TopologyPolicy for Bayesian edge scoring */
  setTopologyPolicy(tp: TopologyPolicy): void {
    this.topologyPolicy = tp;
  }

  // ── Load / Save ───────────────────────────────────────────────────

  load(bundleId: string): AppMapData | null {
    const cached = this.cache.get(bundleId);
    if (cached) return cached;

    // 1. Check user's own maps
    const filePath = this.filePath(bundleId);
    let data = readJsonWithRecovery<AppMapData>(filePath);

    // 2. Fall back to seed maps shipped with the package
    if (!data && this.config.seedDir) {
      const safe = bundleId.replace(/\.\./g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
      const seedPath = path.join(this.config.seedDir, `${safe}.json`);
      data = readJsonWithRecovery<AppMapData>(seedPath);
    }

    if (data) {
      this.cache.set(bundleId, data);
    }
    return data;
  }

  getLoaded(bundleId: string): AppMapData | null {
    return this.cache.get(bundleId) ?? null;
  }

  save(data: AppMapData, recompute = false): void {
    if (recompute) this.recomputeTier(data);
    this.cache.set(data.app, data);
    this.dirty.add(data.app);
    this.scheduleSave();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeDirty();
  }

  // ── Feature Ladder ──────────────────────────────────────────────────

  /**
   * Get the feature ladder for an app. Priority:
   * 1. BUILTIN_LADDERS (handcrafted, e.g., Discord)
   * 2. Auto-generated from reference file (cached in memory + disk)
   * 3. Generic 5-item fallback
   */
  getFeatureLadder(bundleId: string): FeatureDefinition[] {
    // 1. Handcrafted builtin
    if (BUILTIN_LADDERS[bundleId]) return BUILTIN_LADDERS[bundleId]!;

    // 2. In-memory cache of generated ladder
    const cached = this.generatedLadderCache.get(bundleId);
    if (cached && cached.ladder.length > 0) return cached.ladder;

    // 3. Persisted generated ladder on disk
    const persisted = this.loadGeneratedLadder(bundleId);
    if (persisted && persisted.ladder.length > 0) {
      this.generatedLadderCache.set(bundleId, persisted);
      return persisted.ladder;
    }

    // 4. Generic fallback
    return GENERIC_LADDER;
  }

  /**
   * Get the feature signal keywords for an app's auto-generated ladder.
   * Returns null if no generated signals exist (caller should use hardcoded signals).
   */
  getGeneratedSignals(bundleId: string): Record<string, string[]> | null {
    const cached = this.generatedLadderCache.get(bundleId);
    if (cached) return cached.signals;
    const persisted = this.loadGeneratedLadder(bundleId);
    if (persisted) {
      this.generatedLadderCache.set(bundleId, persisted);
      return persisted.signals;
    }
    return null;
  }

  /**
   * Auto-generate a feature ladder from a reference file and cache it.
   * Called when we encounter an app with a reference but no builtin ladder.
   * Returns true if a new ladder was generated (false if already exists or reference too sparse).
   */
  generateLadderFromRef(bundleId: string, ref: ReferenceData): boolean {
    // Don't override builtin ladders
    if (BUILTIN_LADDERS[bundleId]) return false;

    // Check if already generated with same hash
    const existing = this.generatedLadderCache.get(bundleId) ?? this.loadGeneratedLadder(bundleId);
    const result = generateLadderFromReference(ref);
    if (result.ladder.length === 0) return false;

    if (existing && existing.hash === result.hash) {
      // Same reference, no regeneration needed
      this.generatedLadderCache.set(bundleId, existing);
      return false;
    }

    // Cache and persist
    this.generatedLadderCache.set(bundleId, result);
    this.saveGeneratedLadder(bundleId, result);

    // Update existing AppMapData if loaded
    const mapData = this.cache.get(bundleId);
    if (mapData) {
      mapData.featureLadder = result.ladder;
      this.save(mapData);
    }

    return true;
  }

  /** Check if a generated ladder exists for this bundleId. */
  hasGeneratedLadder(bundleId: string): boolean {
    if (BUILTIN_LADDERS[bundleId]) return true;
    if (this.generatedLadderCache.has(bundleId)) return true;
    return this.loadGeneratedLadder(bundleId) !== null;
  }

  /**
   * Set a custom feature ladder for an app. Useful for apps without built-in ladders.
   */
  setFeatureLadder(bundleId: string, ladder: FeatureDefinition[]): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;
    data.featureLadder = ladder;
    this.save(data);
  }

  // ── Generated ladder persistence ─────────────────────────────────

  private ladderFilePath(bundleId: string): string {
    // Sanitize bundleId for filesystem safety — strip path traversal sequences first
    const safe = bundleId.replace(/\.\./g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.config.mapsDir, `${safe}.ladder.json`);
  }

  private loadGeneratedLadder(bundleId: string): GeneratedLadder | null {
    try {
      const filePath = this.ladderFilePath(bundleId);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as GeneratedLadder;
    } catch {
      return null;
    }
  }

  private saveGeneratedLadder(bundleId: string, data: GeneratedLadder): void {
    try {
      fs.mkdirSync(this.config.mapsDir, { recursive: true });
      writeFileAtomicSync(this.ladderFilePath(bundleId), JSON.stringify(data, null, 2));
    } catch { /* non-critical */ }
  }

  // ── Create ────────────────────────────────────────────────────────

  createEmpty(bundleId: string, appName: string, version = "unknown"): AppMapData {
    const data: AppMapData = {
      app: bundleId,
      appName,
      version,
      masteryLevel: "beginner",
      rating: { grade: "F", subTier: 1 },
      ratingFactors: this.emptyRatingFactors(),
      confidence: 0,
      lastValidated: new Date().toISOString(),
      mapVersion: 1,
      uiArchitecture: {
        type: "other",
        rendering: "native",
        axSupport: "partial",
        bestMethod: "ax",
        menuStyle: "standard",
        dragDropHeavy: false,
        hasCanvas: false,
      },
      zones: {},
      navigationGraph: { nodes: {}, edges: [] },
      masteryHistory: [],
      totalTasksCompleted: 0,
      sessionCount: 0,
      featureLadder: this.getFeatureLadder(bundleId),
      featureMastery: {},
      masteryMetrics: this.emptyMetrics(),
      crossFeatureWorkflows: 0,
      actionSuccessCount: 0,
      actionFailCount: 0,
      shortcutsUsed: 0,
      playbooksExported: 0,
      edgeCasesHandled: 0,
    };
    this.save(data);
    return data;
  }

  /**
   * Wire #12: L6→L7 — Bootstrap pre-built zones from a MenuScanner result.
   * Creates toolbar zone + per-menu sub-zones so new apps start with structure.
   * Only bootstraps if no map exists yet — never overwrites existing data.
   * Capped at 10 zones to prevent menu-heavy apps from flooding.
   */
  bootstrapFromMenuScan(
    bundleId: string,
    appName: string,
    scanResult: { menuTree: Array<{ title: string; shortcut: string | null; enabled?: boolean; children: Array<{ title: string; shortcut: string | null; enabled?: boolean }> }>; shortcuts: Record<string, string> },
  ): boolean {
    // Only bootstrap if no menu_bar zone exists yet — perception may have
    // auto-created other zones, but menu structure is separate
    const existing = this.load(bundleId);
    if (existing?.zones["menu_bar"]) return false;

    const data = existing ?? this.createEmpty(bundleId, appName);
    const now = new Date().toISOString();
    // Filter out Apple menu, empty titles, and disabled items
    const topMenus = scanResult.menuTree.filter(
      (m) => m.title && m.title !== "Apple" && m.enabled !== false,
    );
    let zoneCount = 0;

    // Sanitize a menu title for use as zone key or element label
    const sanitize = (title: string): string =>
      redactPII(title)
        .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
        .slice(0, 100);

    // 1. Create toolbar zone with top-level menu names as elements
    const toolbarElements: MapElement[] = [];
    for (let i = 0; i < topMenus.length && i < 15; i++) {
      const menu = topMenus[i]!;
      const safeTitle = sanitize(menu.title);
      if (!safeTitle) continue;
      toolbarElements.push({
        label: safeTitle,
        relativeX: Math.min(0.95, 0.02 + i * 0.08),
        relativeY: 0.02,
        anchor: "top-left",
        ocrBackup: safeTitle,
        successCount: 0,
        failCount: 0,
        lastInteracted: now,
        sessionsSinceUse: 0,
      });
    }

    data.zones["menu_bar"] = {
      relativePosition: { top: 0, left: 0, width: 1, height: 0.04 },
      type: "toolbar",
      elements: toolbarElements,
      verified: false,
      lastSeen: now,
    };
    zoneCount++;

    // 2. Create per-menu sub-zones with child items as elements
    const seenZoneKeys = new Set<string>();
    for (let i = 0; i < topMenus.length && zoneCount < 10; i++) {
      const menu = topMenus[i]!;
      if (!menu.children || menu.children.length === 0) continue;

      // Filter disabled children
      const enabledChildren = menu.children.filter(
        (c) => c.title && c.enabled !== false,
      );
      if (enabledChildren.length === 0) continue;

      const menuElements: MapElement[] = [];
      for (let j = 0; j < enabledChildren.length && j < 20; j++) {
        const child = enabledChildren[j]!;
        const safeChildTitle = sanitize(child.title);
        if (!safeChildTitle) continue;
        menuElements.push({
          label: safeChildTitle,
          relativeX: Math.min(0.95, 0.02 + i * 0.08),
          relativeY: Math.min(0.95, 0.06 + j * 0.03),
          anchor: "top-left",
          ocrBackup: safeChildTitle,
          successCount: 0,
          failCount: 0,
          lastInteracted: now,
          sessionsSinceUse: 0,
        });
      }

      // Sanitize zone key and deduplicate
      const baseKey = `menu::${sanitize(menu.title).toLowerCase().replace(/\s+/g, "_")}`;
      let zoneKey = baseKey;
      if (seenZoneKeys.has(zoneKey)) {
        zoneKey = `${baseKey}_${i}`;
      }
      seenZoneKeys.add(zoneKey);

      // Skip if zone already exists (perception may have built it with verified data)
      if (data.zones[zoneKey]) {
        seenZoneKeys.add(zoneKey);
        continue;
      }
      data.zones[zoneKey] = {
        relativePosition: {
          top: 0.04,
          left: Math.min(0.9, i * 0.08),
          width: 0.15,
          height: Math.min(0.5, enabledChildren.length * 0.03 + 0.02),
        },
        type: "menu",
        elements: menuElements,
        verified: false,
        lastSeen: now,
      };
      zoneCount++;
    }

    // 3. Record initial feature mastery at depth 2 for menu-derived features
    const featureMap: Record<string, string> = {
      file: "file_management", edit: "editing", view: "view_control",
      window: "window_management", help: "help_usage",
    };
    for (const menu of topMenus) {
      const featureId = featureMap[menu.title.toLowerCase()];
      if (featureId && !data.featureMastery[featureId]) {
        data.featureMastery[featureId] = {
          depth: 2,
          confidence: 0.3,
          repeatCount: 0,
          workflowCount: 0,
          healingCount: 0,
          failCount: 0,
          lastSeen: now,
          lastVerified: null,
        };
      }
    }

    this.save(data);
    return true;
  }

  // ── Zone Operations ───────────────────────────────────────────────

  addZone(bundleId: string, zoneKey: string, zone: MapZone): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    const zoneCount = Object.keys(data.zones).length;
    if (zoneCount >= this.config.maxZonesPerApp) return;

    data.zones[zoneKey] = zone;
    this.save(data);
  }

  updateZonePosition(bundleId: string, zoneKey: string, position: RelativePosition): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;
    const zone = data.zones[zoneKey];
    if (!zone) return;

    zone.relativePosition = position;
    zone.lastSeen = new Date().toISOString();
    this.save(data);
  }

  // ── Element Operations ────────────────────────────────────────────

  addElement(bundleId: string, zoneKey: string, element: MapElement): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;
    const zone = data.zones[zoneKey];
    if (!zone) return;

    if (zone.elements.length >= this.config.maxElementsPerZone) return;

    // V2: Redact PII from user-facing element text before persistence
    element.label = redactPII(element.label);
    element.ocrBackup = redactPII(element.ocrBackup);

    // Deduplicate by label
    const existing = zone.elements.findIndex((e) => e.label === element.label);
    if (existing >= 0) {
      zone.elements[existing] = element;
    } else {
      zone.elements.push(element);
    }
    this.save(data);
  }

  updateElementPosition(
    bundleId: string,
    zoneKey: string,
    label: string,
    relX: number,
    relY: number,
  ): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    // Find the element — it may be in the specified zone or any zone (page-aware routing)
    let sourceZone = data.zones[zoneKey];
    let el = sourceZone?.elements.find((e) => e.label === label);
    let sourceZoneKey = zoneKey;

    // If not found in the specified zone, search all zones
    if (!el) {
      for (const [key, z] of Object.entries(data.zones)) {
        const found = z.elements.find((e) => e.label === label);
        if (found) {
          el = found;
          sourceZone = z;
          sourceZoneKey = key;
          break;
        }
      }
    }
    if (!el || !sourceZone) return;

    el.relativeX = relX;
    el.relativeY = relY;
    el.lastInteracted = new Date().toISOString();
    el.sessionsSinceUse = 0;

    // ── Global zone migration based on position ──
    // Elements in the sidebar region (left 15%) → global::sidebar
    // Elements in the toolbar region (top 8%) → global::toolbar
    // Only migrate from page-specific or auto_discovered zones, not from
    // zones that are already correctly classified.
    const isPageOrAuto = sourceZoneKey.startsWith("page::") || sourceZoneKey === "auto_discovered";
    if (isPageOrAuto) {
      let globalTarget: string | null = null;
      if (relX < 0.15 && relY > 0.08) {
        globalTarget = "global::sidebar";
      } else if (relY < 0.08) {
        globalTarget = "global::toolbar";
      }

      if (globalTarget && globalTarget !== sourceZoneKey) {
        // Move element from source zone to global zone
        const idx = sourceZone.elements.indexOf(el);
        if (idx >= 0) sourceZone.elements.splice(idx, 1);

        let targetZone = data.zones[globalTarget];
        if (!targetZone) {
          targetZone = {
            relativePosition: globalTarget === "global::toolbar"
              ? { top: 0, left: 0, width: 1, height: 0.08 }
              : { top: 0.08, left: 0, width: 0.15, height: 0.92 },
            type: globalTarget === "global::toolbar" ? "toolbar" : "sidebar",
            elements: [],
            verified: false,
            lastSeen: new Date().toISOString(),
          };
          data.zones[globalTarget] = targetZone;
        }

        // Don't duplicate — check if already in target
        const existing = targetZone.elements.find((e) => e.label === label);
        if (existing) {
          existing.relativeX = relX;
          existing.relativeY = relY;
          existing.lastInteracted = el.lastInteracted;
          existing.sessionsSinceUse = 0;
          existing.successCount += el.successCount;
          existing.failCount += el.failCount;
        } else {
          if (targetZone.elements.length < this.config.maxElementsPerZone) {
            targetZone.elements.push(el);
          }
        }
      }
    }

    this.save(data);
  }

  recordElementOutcome(
    bundleId: string,
    zoneKey: string,
    label: string,
    success: boolean,
    pageContext?: string,
  ): void {
    // V2: Redact PII from label before persistence
    label = redactPII(label);

    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    // Search across all zones if zoneKey is "auto"
    let zone = data.zones[zoneKey];
    if (!zone && zoneKey === "auto") {
      const targetZoneKey = pageContext
        ? `page::${normalizePageContext(pageContext)}`
        : "auto_discovered";

      // When page context is known, prefer the page-specific zone
      // This ensures elements migrate OUT of auto_discovered into proper page zones
      if (pageContext) {
        // First check if element already exists in the target page zone
        const pageZone = data.zones[targetZoneKey];
        if (pageZone) {
          zone = pageZone;
        } else {
          // Check page:: zone count separately to prevent title explosion
          const pageZoneCount = Object.keys(data.zones).filter((k) => k.startsWith("page::")).length;
          if (Object.keys(data.zones).length >= this.config.maxZonesPerApp || pageZoneCount >= MAX_PAGE_ZONES) {
            // At zone limit — fall back to auto_discovered
            zone = data.zones["auto_discovered"];
            if (!zone) {
              zone = {
                relativePosition: { top: 0, left: 0, width: 1, height: 1 },
                type: "other",
                elements: [],
                verified: false,
                lastSeen: new Date().toISOString(),
              };
              data.zones["auto_discovered"] = zone;
            }
          } else {
            zone = {
              relativePosition: { top: 0, left: 0, width: 1, height: 1 },
              type: "other",
              elements: [],
              verified: false,
              lastSeen: new Date().toISOString(),
            };
            data.zones[targetZoneKey] = zone;
          }
        }
      } else {
        // No page context — search all zones for existing element
        for (const [, z] of Object.entries(data.zones)) {
          const found = z.elements.find((e) => e.label === label);
          if (found) {
            zone = z;
            break;
          }
        }
        // Not found — use auto_discovered
        if (!zone) {
          zone = data.zones["auto_discovered"];
          if (!zone) {
            zone = {
              relativePosition: { top: 0, left: 0, width: 1, height: 1 },
              type: "other",
              elements: [],
              verified: false,
              lastSeen: new Date().toISOString(),
            };
            data.zones["auto_discovered"] = zone;
          }
        }
      }
    }
    if (!zone) {
      // Non-auto zoneKey that doesn't exist — nothing to do
      return;
    }

    let el = zone.elements.find((e) => e.label === label);
    if (!el) {
      if (zone.elements.length >= this.config.maxElementsPerZone) return;
      el = {
        label,
        relativeX: -1,
        relativeY: -1,
        anchor: "top-left",
        ocrBackup: label,
        successCount: 0,
        failCount: 0,
        lastInteracted: new Date().toISOString(),
        sessionsSinceUse: 0,
      };
      zone.elements.push(el);
    }

    if (success) {
      el.successCount++;
    } else {
      el.failCount++;
    }
    el.lastInteracted = new Date().toISOString();
    el.sessionsSinceUse = 0;
    this.save(data);
  }

  // ── Input/Output Contracts ──────────────────────────────────────────

  /**
   * Record what an element DOES when interacted with.
   * If a contract for the same element+action already exists, merge outcomes:
   * increment seenCount for known outcomes, add new ones.
   * Mark outcomes as reliable when seenCount >= 3.
   */
  recordContract(
    bundleId: string,
    zoneKey: string,
    elementLabel: string,
    action: string,
    outcomes: string[],
    preconditions?: string[],
  ): void {
    // M3: Reject empty string labels/actions
    if (!elementLabel || !action) return;

    // V2: Redact PII from user-facing strings before persistence
    elementLabel = redactPII(elementLabel);
    action = redactPII(action);
    outcomes = redactStrings(outcomes);
    if (preconditions) preconditions = redactStrings(preconditions);

    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    // Find the zone — search all zones if zoneKey is "auto"
    let zone: MapZone | undefined;
    let resolvedZoneKey = zoneKey;
    if (zoneKey === "auto") {
      // Search across all zones for this element
      for (const [key, z] of Object.entries(data.zones)) {
        if (z.elements.some((e) => e.label === elementLabel)) {
          zone = z;
          resolvedZoneKey = key;
          break;
        }
      }
      // Fall back to auto_discovered — create it if it doesn't exist
      if (!zone) {
        zone = data.zones["auto_discovered"];
        if (!zone) {
          zone = {
            relativePosition: { top: 0, left: 0, width: 1, height: 1 },
            type: "other",
            elements: [],
            verified: false,
            lastSeen: new Date().toISOString(),
          };
          data.zones["auto_discovered"] = zone;
        }
        resolvedZoneKey = "auto_discovered";
      }
    } else {
      zone = data.zones[zoneKey];
    }
    if (!zone) return;

    // Initialize contracts array if needed
    if (!zone.contracts) zone.contracts = [];

    // Find existing contract for same element+action
    let contract = zone.contracts.find(
      (c) => c.elementLabel === elementLabel && c.action === action,
    );

    if (contract) {
      // Merge outcomes
      for (const desc of outcomes) {
        const existing = contract.outcomes.find((o) => o.description === desc);
        if (existing) {
          existing.seenCount++;
          if (existing.seenCount >= 3) existing.reliable = true;
        } else {
          if (contract.outcomes.length < this.config.maxOutcomesPerContract) {
            contract.outcomes.push({ description: desc, reliable: false, seenCount: 1 });
          }
        }
      }
      // Merge preconditions (deduplicate, cap at 50)
      if (preconditions) {
        for (const pc of preconditions) {
          if (contract.preconditions.length >= 50) break;
          if (!contract.preconditions.includes(pc)) {
            contract.preconditions.push(pc);
          }
        }
      }
      contract.validationCount++;
      contract.lastValidated = new Date().toISOString();
    } else {
      // Enforce contract limit
      if (zone.contracts.length >= this.config.maxContractsPerZone) return;

      contract = {
        elementLabel,
        action,
        preconditions: preconditions ?? [],
        outcomes: outcomes.slice(0, this.config.maxOutcomesPerContract).map((desc) => ({
          description: desc,
          reliable: false,
          seenCount: 1,
        })),
        validationCount: 1,
        lastValidated: new Date().toISOString(),
      };
      zone.contracts.push(contract);
    }

    this.save(data);
  }

  /**
   * Find the contract for an element across all zones.
   * When action is provided, only returns contracts matching that action type.
   * Falls back to any-action match when action is omitted.
   */
  getContract(
    bundleId: string,
    elementLabel: string,
    action?: string,
  ): { zone: string; contract: ElementContract } | null {
    const data = this.ensureLoaded(bundleId);
    if (!data) return null;

    for (const [zoneKey, zone] of Object.entries(data.zones)) {
      if (!zone.contracts) continue;
      const contract = zone.contracts.find((c) =>
        c.elementLabel === elementLabel && (action == null || c.action === action),
      );
      if (contract) return { zone: zoneKey, contract };
    }
    return null;
  }

  /**
   * Record an action tool outcome (type, set_value, menu_click, key, drag — not navigation).
   * These represent actually DOING something, not just clicking around.
   */
  recordActionOutcome(bundleId: string, success: boolean): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    // Migrate old data
    this.migrateToWeighted(data);
    if (data.actionSuccessCount == null) data.actionSuccessCount = 0;
    if (data.actionFailCount == null) data.actionFailCount = 0;

    if (success) {
      data.actionSuccessCount++;
    } else {
      data.actionFailCount++;
    }
    this.save(data);
  }

  /**
   * Record a feature interaction at a given depth.
   * Depth: 1=navigated, 2=basic action, 3=multi-step workflow, 4=verified outcome.
   * Depth only goes UP — you can't lose depth. Confidence grows with repeats.
   */
  recordFeatureSignal(
    bundleId: string,
    featureKey: string,
    depth: 1 | 2 | 3 | 4,
    success: boolean,
  ): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;
    this.migrateToWeighted(data);

    let fm = data.featureMastery[featureKey];
    if (!fm) {
      fm = {
        depth: 0,
        confidence: 0,
        repeatCount: 0,
        workflowCount: 0,
        healingCount: 0,
        failCount: 0,
        lastSeen: new Date().toISOString(),
        lastVerified: null,
      };
      data.featureMastery[featureKey] = fm;
    }

    fm.lastSeen = new Date().toISOString();

    if (success) {
      // Depth only goes up
      if (depth > fm.depth) {
        fm.depth = depth as FeatureMastery["depth"];
      }
      fm.repeatCount++;
      if (depth >= 3) fm.workflowCount++;
      if (depth === 4) fm.lastVerified = new Date().toISOString();

      // Confidence based on evidence: navigation=0.25-0.4, action=0.5-0.6,
      // workflow repeated 3x=0.75-0.85, verified outcome 5x=0.9-1.0
      fm.confidence = this.computeFeatureConfidence(fm);
    } else {
      fm.failCount++;
      // Confidence drops slightly on failure
      fm.confidence = Math.max(0, fm.confidence - 0.05);
    }

    // Recompute tier
    this.recomputeTier(data);
    this.save(data);
  }

  /**
   * Record a healing event — recovery from failure on a feature.
   */
  recordHealing(bundleId: string, featureKey: string): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;
    this.migrateToWeighted(data);

    const fm = data.featureMastery[featureKey];
    if (fm) {
      fm.healingCount++;
      fm.confidence = Math.min(1, fm.confidence + 0.05);
      this.recomputeTier(data);
      this.save(data);
    }
  }

  /**
   * Record a cross-feature workflow (end-to-end task spanning multiple features).
   */
  recordCrossFeatureWorkflow(bundleId: string): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;
    this.migrateToWeighted(data);

    data.crossFeatureWorkflows++;
    this.recomputeTier(data);
    this.save(data);
  }

  /** @deprecated Use recordFeatureSignal. Kept for backward compat. */
  recordFeatureCompletion(bundleId: string, featureKey: string): void {
    this.recordFeatureSignal(bundleId, featureKey, 1, true);
  }

  // ── Navigation Graph ──────────────────────────────────────────────

  /**
   * Record a page/view transition observed during tool execution.
   * Auto-creates NavNodes for both pages and creates or updates the edge.
   * Same-page transitions are ignored. Respects maxEdges config limit.
   */
  recordPageTransition(
    bundleId: string,
    fromPage: string,
    toPage: string,
    action: string,
  ): void {
    // M3: Reject empty page names
    if (!fromPage || !toPage) return;

    // V2: Redact PII from page names before persistence
    fromPage = redactPII(fromPage);
    toPage = redactPII(toPage);
    // Sanitize: strip control chars, cap length to prevent zone key explosion
    const sanitizeTitle = (t: string) => t.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\ufeff]/g, "").slice(0, 100);
    fromPage = sanitizeTitle(fromPage);
    toPage = sanitizeTitle(toPage);
    // Re-check after sanitization in case both pages redact/truncate to the same string
    if (!fromPage || !toPage || fromPage === toPage) return;

    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    // Handle initial page entry (first page after app launch)
    if (fromPage === "__initial__") {
      // Just ensure the initial page node exists — no edge from __initial__
      if (!data.navigationGraph.nodes[toPage]) {
        data.navigationGraph.nodes[toPage] = {
          type: "window",
          description: toPage,
        };
        this.save(data);
      }
      return;
    }

    // Find existing edge with same from/action/to
    const existing = data.navigationGraph.edges.find(
      (e) => e.from === fromPage && e.action === action && e.to === toPage,
    );

    if (existing) {
      existing.successCount++;
      if (existing.successCount >= 2) {
        existing.verified = true;
      }
      existing.lastUsed = new Date().toISOString();
    } else {
      // Check limit before creating nodes or edge
      if (data.navigationGraph.edges.length >= this.config.maxEdges) return;

      // Auto-create NavNodes only when we know the edge will be added
      if (!data.navigationGraph.nodes[fromPage]) {
        data.navigationGraph.nodes[fromPage] = {
          type: "window",
          description: fromPage,
        };
      }
      if (!data.navigationGraph.nodes[toPage]) {
        data.navigationGraph.nodes[toPage] = {
          type: "window",
          description: toPage,
        };
      }

      data.navigationGraph.edges.push({
        from: fromPage,
        action,
        to: toPage,
        verified: false,
        successCount: 1,
        failCount: 0,
        lastUsed: new Date().toISOString(),
      });
    }

    this.save(data);
  }

  addNavNode(bundleId: string, nodeKey: string, node: NavNode): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    data.navigationGraph.nodes[nodeKey] = node;
    this.save(data);
  }

  addNavEdge(bundleId: string, edge: NavEdge): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    if (data.navigationGraph.edges.length >= this.config.maxEdges) return;

    // Deduplicate by from+action+to
    const idx = data.navigationGraph.edges.findIndex(
      (e) => e.from === edge.from && e.action === edge.action && e.to === edge.to,
    );
    if (idx >= 0) {
      data.navigationGraph.edges[idx] = edge;
    } else {
      data.navigationGraph.edges.push(edge);
    }
    this.save(data);
  }

  recordEdgeOutcome(
    bundleId: string,
    from: string,
    action: string,
    to: string,
    success: boolean,
  ): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    let edge = data.navigationGraph.edges.find(
      (e) => e.from === from && e.action === action && e.to === to,
    );
    if (!edge) {
      if (data.navigationGraph.edges.length >= this.config.maxEdges) return;
      edge = {
        from,
        action,
        to,
        verified: false,
        successCount: 0,
        failCount: 0,
        lastUsed: new Date().toISOString(),
      };
      data.navigationGraph.edges.push(edge);
    }

    if (success) {
      edge.successCount++;
      if (edge.successCount >= 2) {
        edge.verified = true;
      }
    } else {
      edge.failCount++;
    }
    edge.lastUsed = new Date().toISOString();

    // Wire #11: stamp Bayesian score from TopologyPolicy if available
    if (this.topologyPolicy) {
      const entries = this.topologyPolicy.query(bundleId, from);
      const match = entries.find((e) => e.action === action && e.toNode === to);
      if (match) {
        edge.topologyScore = match.score;
      }
    }

    this.save(data);
  }

  /**
   * Wire #11: Get reliability score for a nav edge.
   * Prefers TopologyPolicy Bayesian score when available,
   * falls back to simple success ratio from AppMap edge data.
   */
  getEdgeScore(bundleId: string, from: string, action: string, to: string): number | null {
    // Prefer live TopologyPolicy score
    if (this.topologyPolicy) {
      const entries = this.topologyPolicy.query(bundleId, from);
      const match = entries.find((e) => e.action === action && e.toNode === to);
      if (match) return match.score;
    }
    // Fallback to AppMap edge data
    const data = this.load(bundleId);
    if (!data) return null;
    const edge = data.navigationGraph.edges.find(
      (e) => e.from === from && e.action === action && e.to === to,
    );
    if (!edge) return null;
    if (edge.topologyScore !== undefined) return edge.topologyScore;
    const total = edge.successCount + edge.failCount;
    return total > 0 ? edge.successCount / total : null;
  }

  // ── Hierarchy ────────────────────────────────────────────────────

  /**
   * Record a parent/child containment relationship within a zone.
   * If the parent already has a hierarchy entry, merges children (no duplicates).
   * Respects maxHierarchyEntriesPerZone limit.
   */
  recordHierarchy(
    bundleId: string,
    zoneKey: string,
    parentLabel: string,
    children: string[],
    source: ElementHierarchy["source"],
  ): void {
    // M3: Reject empty parent label
    if (!parentLabel) return;

    // V2: Redact PII from user-facing strings before persistence
    parentLabel = redactPII(parentLabel);
    children = redactStrings(children);

    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    // Find or create zone
    let zone = data.zones[zoneKey];
    if (!zone) {
      if (Object.keys(data.zones).length >= this.config.maxZonesPerApp) return;
      zone = {
        relativePosition: { top: 0, left: 0, width: 1, height: 1 },
        type: "other",
        elements: [],
        verified: false,
        lastSeen: new Date().toISOString(),
      };
      data.zones[zoneKey] = zone;
    }

    if (!zone.hierarchy) {
      zone.hierarchy = [];
    }

    // Deduplicate: find existing entry by parentLabel + parentZone
    const existing = zone.hierarchy.find(
      (h) => h.parentLabel === parentLabel && h.parentZone === zoneKey,
    );
    if (existing) {
      // Merge children — add new ones, skip duplicates, cap at 200
      const childSet = new Set(existing.children);
      for (const child of children) {
        if (childSet.size >= 200) break;
        childSet.add(child);
      }
      existing.children = [...childSet];
      existing.source = source;
      existing.lastSeen = new Date().toISOString();
    } else {
      // Enforce limit
      if (zone.hierarchy.length >= this.config.maxHierarchyEntriesPerZone) return;
      zone.hierarchy.push({
        parentLabel,
        parentZone: zoneKey,
        children: [...new Set(children)],
        source,
        lastSeen: new Date().toISOString(),
      });
    }

    this.save(data);
  }

  /**
   * Get hierarchy entries for a zone or all zones.
   * Returns empty array if no hierarchy data exists.
   */
  getHierarchy(bundleId: string, zoneKey?: string): ElementHierarchy[] {
    const data = this.ensureLoaded(bundleId);
    if (!data) return [];

    if (zoneKey != null) {
      const zone = data.zones[zoneKey];
      return zone?.hierarchy ?? [];
    }

    // Collect from all zones
    const result: ElementHierarchy[] = [];
    for (const zone of Object.values(data.zones)) {
      if (zone.hierarchy) {
        result.push(...zone.hierarchy);
      }
    }
    return result;
  }

  // ── State Machine ──────────────────────────────────────────────────

  /**
   * Record a UI state change (e.g., sidebar expanded → collapsed).
   * Auto-creates the StateDimension if new. If the transition already
   * exists (same dimension + from + to + trigger), increments observedCount.
   * Auto-detects reversibility: if A→B via trigger1 AND B→A via trigger2
   * exist, sets reverseTrigger on both.
   */
  recordStateChange(
    bundleId: string,
    dimensionKey: string,
    fromValue: string,
    toValue: string,
    trigger: string,
  ): void {
    if (fromValue === toValue) return; // No-op transitions are meaningless
    // M3: Reject empty string keys/values
    if (!dimensionKey || !fromValue || !toValue) return;

    // V2: Redact PII from user-visible state values (NOT dimensionKey — internal)
    fromValue = redactPII(fromValue);
    toValue = redactPII(toValue);
    // Re-check after redaction in case both values redacted to the same string
    if (fromValue === toValue) return;

    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    // Lazy-init arrays (optional fields on AppMapData)
    if (!data.stateDimensions) data.stateDimensions = [];
    if (!data.stateTransitions) data.stateTransitions = [];

    const now = new Date().toISOString();

    // ── Update or create StateTransition (BEFORE dimension update — M1 fix) ──
    let tx = data.stateTransitions.find(
      (t) =>
        t.dimensionKey === dimensionKey &&
        t.fromValue === fromValue &&
        t.toValue === toValue &&
        t.trigger === trigger,
    );

    if (tx) {
      tx.observedCount++;
      tx.lastSeen = now;
    } else {
      // M1: If transition limit is hit, don't update dimension either
      if (data.stateTransitions.length >= this.config.maxStateTransitions) {
        this.save(data);
        return;
      }
      tx = {
        dimensionKey,
        fromValue,
        toValue,
        trigger,
        observedCount: 1,
        lastSeen: now,
      };
      data.stateTransitions.push(tx);
    }

    // ── Update or create StateDimension (only after transition is accepted) ──
    let dim = data.stateDimensions.find((d) => d.key === dimensionKey);
    if (!dim) {
      if (data.stateDimensions.length >= this.config.maxStateDimensions) {
        this.save(data);
        return;
      }
      dim = {
        key: dimensionKey,
        possibleValues: [],
        currentValue: toValue,
        lastObserved: now,
      };
      data.stateDimensions.push(dim);
    }

    // Add from/to values to possibleValues if not already present (cap at 100)
    if (!dim.possibleValues.includes(fromValue) && dim.possibleValues.length < 100) dim.possibleValues.push(fromValue);
    if (!dim.possibleValues.includes(toValue) && dim.possibleValues.length < 100) dim.possibleValues.push(toValue);
    dim.currentValue = toValue;
    dim.lastObserved = now;

    // ── Auto-detect reversibility (M2: collect all reverse triggers) ──
    // Find ALL reverse transitions (B→A for this A→B)
    const reverses = data.stateTransitions.filter(
      (t) =>
        t.dimensionKey === dimensionKey &&
        t.fromValue === toValue &&
        t.toValue === fromValue,
    );
    for (const reverse of reverses) {
      // Add reverse.trigger to tx.reverseTrigger array (deduplicate)
      // Migration: old persisted data may have reverseTrigger as string, not string[]
      if (!tx.reverseTrigger || typeof tx.reverseTrigger === "string") {
        const old = typeof tx.reverseTrigger === "string" ? [tx.reverseTrigger] : [];
        tx.reverseTrigger = old;
      }
      if (!tx.reverseTrigger.includes(reverse.trigger)) {
        tx.reverseTrigger.push(reverse.trigger);
      }
      // Add tx.trigger to reverse.reverseTrigger array (deduplicate)
      if (!reverse.reverseTrigger || typeof reverse.reverseTrigger === "string") {
        const old = typeof reverse.reverseTrigger === "string" ? [reverse.reverseTrigger] : [];
        reverse.reverseTrigger = old;
      }
      if (!reverse.reverseTrigger.includes(tx.trigger)) {
        reverse.reverseTrigger.push(tx.trigger);
      }
    }

    this.save(data);
  }

  /**
   * Get all known state dimensions for an app.
   * Returns empty array if no state has been recorded.
   */
  getStateDimensions(bundleId: string): StateDimension[] {
    const data = this.ensureLoaded(bundleId);
    if (!data) return [];
    return data.stateDimensions ?? [];
  }

  /**
   * Get the current state snapshot: dimension key → current value.
   * Returns empty record if no state has been recorded.
   */
  getCurrentState(bundleId: string): Record<string, string> {
    const data = this.ensureLoaded(bundleId);
    if (!data || !data.stateDimensions) return {};

    const result: Record<string, string> = {};
    for (const dim of data.stateDimensions) {
      result[dim.key] = dim.currentValue;
    }
    return result;
  }

  /**
   * Get all state transitions for an app (optionally filtered by dimension).
   */
  getStateTransitions(bundleId: string, dimensionKey?: string): StateTransition[] {
    const data = this.ensureLoaded(bundleId);
    if (!data || !data.stateTransitions) return [];
    if (dimensionKey) {
      return data.stateTransitions.filter((t) => t.dimensionKey === dimensionKey);
    }
    return data.stateTransitions;
  }

  // ── Query ─────────────────────────────────────────────────────────

  findElement(bundleId: string, label: string): { zone: string; element: MapElement } | null {
    const data = this.ensureLoaded(bundleId);
    if (!data) return null;

    for (const [zoneKey, zone] of Object.entries(data.zones)) {
      const el = zone.elements.find((e) => e.label === label);
      if (el) return { zone: zoneKey, element: el };
    }
    return null;
  }

  resolvePosition(
    bundleId: string,
    label: string,
    windowBounds: { x: number; y: number; width: number; height: number },
  ): { x: number; y: number } | null {
    const found = this.findElement(bundleId, label);
    if (!found || (found.element.relativeX === -1 && found.element.relativeY === -1)) return null;

    return {
      x: Math.round(windowBounds.x + found.element.relativeX * windowBounds.width),
      y: Math.round(windowBounds.y + found.element.relativeY * windowBounds.height),
    };
  }

  /**
   * BFS pathfinding through the navigation graph.
   */
  findPath(bundleId: string, from: string, to: string): NavEdge[] | null {
    const data = this.ensureLoaded(bundleId);
    if (!data) return null;
    if (from === to) return [];

    const edges = data.navigationGraph.edges;
    const visited = new Set<string>();
    const queue: Array<{ node: string; path: NavEdge[] }> = [{ node: from, path: [] }];
    visited.add(from);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of edges) {
        if (edge.from !== current.node) continue;
        if (visited.has(edge.to)) continue;

        const newPath = [...current.path, edge];
        if (edge.to === to) return newPath;

        visited.add(edge.to);
        queue.push({ node: edge.to, path: newPath });
      }
    }

    return null;
  }

  // ── Mastery (Gated Weighted System) ─────────────────────────────

  /**
   * Compute per-feature confidence from evidence.
   * - 1 navigation: 0.25-0.4
   * - 1 basic action: 0.5-0.6
   * - Multi-step workflow repeated 3x: 0.75-0.85
   * - Verified outcome repeated 5x: 0.9-1.0
   */
  private computeFeatureConfidence(fm: FeatureMastery): number {
    const { depth, repeatCount, workflowCount } = fm;
    if (depth === 0) return 0;

    // Base confidence from depth
    const depthBase: Record<number, number> = { 1: 0.25, 2: 0.5, 3: 0.7, 4: 0.85 };
    let conf = depthBase[depth] ?? 0;

    // Repeat bonus: more repeats = more confidence, diminishing returns
    // Each repeat adds up to the ceiling for that depth
    const depthCeiling: Record<number, number> = { 1: 0.4, 2: 0.6, 3: 0.85, 4: 1.0 };
    const ceiling = depthCeiling[depth] ?? 0;
    const repeatBonus = Math.min(ceiling - conf, repeatCount * 0.03);
    conf += repeatBonus;

    // Workflow bonus for depth 3+
    if (depth >= 3 && workflowCount >= 3) {
      conf = Math.min(ceiling, conf + 0.05);
    }

    return Math.min(1, Math.max(0, conf));
  }

  /**
   * Compute aggregate mastery metrics from per-feature data.
   * criticalFloor is tier-scoped: for pro, only beginner+pro critical features count.
   * For expert, beginner+pro+expert. For grandmaster, all.
   */
  computeMetrics(data: AppMapData, tierScope?: MasteryLevel): MasteryMetrics {
    this.migrateToWeighted(data);
    const ladder = data.featureLadder;
    if (!ladder.length) return this.emptyMetrics();

    const totalWeight = ladder.reduce((s, f) => s + f.weight, 0);
    let breadthWeight = 0;
    let workflowWeight = 0;
    let outcomeWeight = 0;
    let totalSuccesses = 0;
    let totalAttempts = 0;
    let totalHealings = 0;
    let totalFailures = 0;
    let weightedScore = 0;

    // Tier-scoped critical floor: only check critical features at or below the target tier
    const tierOrder: MasteryLevel[] = ["beginner", "pro", "expert", "grandmaster"];
    const scopeIdx = tierScope ? tierOrder.indexOf(tierScope) : 3; // default: all tiers
    const scopedLevels = new Set(tierOrder.slice(0, scopeIdx + 1));
    let criticalMinDepth = 999;
    let hasScopedCritical = false;

    for (const feature of ladder) {
      const fm = data.featureMastery[feature.id];
      const depth = fm?.depth ?? 0;
      const conf = fm?.confidence ?? 0;

      // Feature score = (depth/4) * weight * confidence
      weightedScore += (depth / 4) * feature.weight * conf;

      if (depth >= 2) breadthWeight += feature.weight;
      if (depth >= 3) workflowWeight += feature.weight;
      if (depth === 4) outcomeWeight += feature.weight;

      if (fm) {
        totalSuccesses += fm.repeatCount;
        totalAttempts += fm.repeatCount + fm.failCount;
        totalHealings += fm.healingCount;
        totalFailures += fm.failCount;
      }

      // Only check critical floor on features at or below the target tier
      if (feature.critical && scopedLevels.has(feature.level)) {
        hasScopedCritical = true;
        criticalMinDepth = Math.min(criticalMinDepth, depth);
      }
    }

    return {
      breadth: totalWeight > 0 ? breadthWeight / totalWeight : 0,
      workflowBreadth: totalWeight > 0 ? workflowWeight / totalWeight : 0,
      outcomeBreadth: totalWeight > 0 ? outcomeWeight / totalWeight : 0,
      reliability: totalAttempts > 0 ? totalSuccesses / totalAttempts : 0,
      healingRate: totalFailures > 0 ? totalHealings / totalFailures : 0,
      crossFeatureWorkflows: data.crossFeatureWorkflows,
      criticalFloor: hasScopedCritical ? (criticalMinDepth === 999 ? 0 : criticalMinDepth) : 0,
      weightedScore,
    };
  }

  /**
   * Determine mastery tier from hard gates.
   * Like engineering seniority: you can't fake your way to grandmaster.
   *
   * | Tier        | Breadth(>=2) | Workflow(>=3) | Outcome(=4) | Reliability | Healing | Cross-feat | Critical |
   * |-------------|-------------|--------------|------------|------------|---------|-----------|---------|
   * | Beginner    | >=20%       | >=10%        | 0-5%       | >=60%      | —       | 0-1       | —       |
   * | Pro         | >=40%       | >=25%        | >=10%      | >=80%      | opt     | >=2       | some>=2 |
   * | Expert      | >=60%       | >=45%        | >=25%      | >=90%      | >=50%   | >=4       | all>=3  |
   * | Grandmaster | >=80%       | >=65%        | >=40%      | >=95%      | >=80%   | >=8       | all>=3, half=4 |
   */
  computeMasteryLevel(metricsOrConfidence: MasteryMetrics | number, data?: AppMapData): MasteryLevel {
    // Backward compat: accept raw confidence number
    if (typeof metricsOrConfidence === "number") {
      const c = metricsOrConfidence;
      if (c >= 0.75) return "grandmaster";
      if (c >= 0.50) return "expert";
      if (c >= 0.25) return "pro";
      return "beginner";
    }

    const m = metricsOrConfidence;

    // Each tier checks critical floor scoped to its own level.
    // Pro only requires beginner+pro critical features at depth 2.
    // Expert adds expert-level critical features. Grandmaster checks all.
    const scopedFloor = (tier: MasteryLevel): number => {
      if (!data) return m.criticalFloor;
      return this.computeMetrics(data, tier).criticalFloor;
    };

    // Grandmaster: you can operate, verify, recover, and repeat everything
    if (
      m.breadth >= 0.80 &&
      m.workflowBreadth >= 0.65 &&
      m.outcomeBreadth >= 0.40 &&
      m.reliability >= 0.95 &&
      m.healingRate >= 0.80 &&
      m.crossFeatureWorkflows >= 8 &&
      scopedFloor("grandmaster") >= 3
    ) return "grandmaster";

    // Expert: deep operational competence
    if (
      m.breadth >= 0.60 &&
      m.workflowBreadth >= 0.45 &&
      m.outcomeBreadth >= 0.25 &&
      m.reliability >= 0.90 &&
      m.healingRate >= 0.50 &&
      m.crossFeatureWorkflows >= 4 &&
      scopedFloor("expert") >= 3
    ) return "expert";

    // Pro: consistent operational user
    if (
      m.breadth >= 0.40 &&
      m.workflowBreadth >= 0.25 &&
      m.outcomeBreadth >= 0.10 &&
      m.reliability >= 0.80 &&
      m.crossFeatureWorkflows >= 2 &&
      scopedFloor("pro") >= 2
    ) return "pro";

    // Beginner: has touched things
    if (
      m.breadth >= 0.20 &&
      m.workflowBreadth >= 0.10 &&
      m.reliability >= 0.60
    ) return "beginner";

    return "beginner";
  }

  /**
   * Compute a single confidence number (0-1) for display/backward compat.
   * Derived from weighted score + metrics quality.
   */
  computeConfidence(data: AppMapData): number {
    this.migrateToWeighted(data);
    const metrics = this.computeMetrics(data);
    const ladder = data.featureLadder;
    const maxPossibleScore = ladder.reduce((s, f) => s + f.weight, 0);

    if (maxPossibleScore === 0) return 0;

    // Weighted score normalized by max possible
    let confidence = metrics.weightedScore / maxPossibleScore;

    // Reliability bonus (up to +10%)
    if (metrics.reliability > 0) {
      confidence = Math.min(1, confidence + 0.10 * metrics.reliability);
    }

    // Staleness decay
    const daysSinceValidated =
      (Date.now() - new Date(data.lastValidated).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceValidated > this.config.staleThresholdDays) {
      const decay = Math.max(
        0.3,
        1.0 - (daysSinceValidated - this.config.staleThresholdDays) * 0.05,
      );
      confidence *= decay;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Recompute tier and confidence from current feature mastery state.
   */
  private recomputeTier(data: AppMapData): void {
    const prevTier = data.masteryLevel;
    const metrics = this.computeMetrics(data);
    data.masteryMetrics = metrics;
    data.confidence = this.computeConfidence(data);
    data.masteryLevel = this.computeMasteryLevel(metrics, data);

    // Compute game-style rating (F→0)
    const factors = this.computeRatingFactors(data);
    data.ratingFactors = factors;
    data.rating = this.computeRating(factors);

    // Use lastRecomputed — lastValidated is reserved for perception coordinator
    data.lastRecomputed = new Date().toISOString();

    // Urgent flush when mastery tier changes — write ONLY this app immediately
    if (prevTier !== data.masteryLevel) {
      try {
        writeFileAtomicSync(this.filePath(data.app), JSON.stringify(data, null, 2) + "\n");
        this.dirty.delete(data.app); // Only remove the one we just wrote
      } catch { /* non-fatal — will be picked up by next debounced save */ }
    }
  }

  refreshMastery(bundleId: string): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;
    this.migrateToWeighted(data);
    this.recomputeTier(data);

    // Add history entry (deduplicate by date)
    const today = new Date().toISOString().split("T")[0]!;
    const lastHistory = data.masteryHistory[data.masteryHistory.length - 1];
    if (!lastHistory || lastHistory.date !== today) {
      data.masteryHistory.push({
        date: today,
        level: data.masteryLevel,
        rating: data.rating,
        confidence: data.confidence,
        zonesKnown: Object.keys(data.zones).length,
        edgesVerified: data.navigationGraph.edges.filter((e) => e.verified).length,
      });
      if (data.masteryHistory.length > this.config.maxHistoryEntries) {
        data.masteryHistory = data.masteryHistory.slice(-this.config.maxHistoryEntries);
      }
    }

    this.save(data);
  }

  /** Empty metrics baseline */
  private emptyMetrics(): MasteryMetrics {
    return {
      breadth: 0,
      workflowBreadth: 0,
      outcomeBreadth: 0,
      reliability: 0,
      healingRate: 0,
      crossFeatureWorkflows: 0,
      criticalFloor: 0,
      weightedScore: 0,
    };
  }

  /** Empty rating factors baseline (all zeros) */
  private emptyRatingFactors(): RatingFactors {
    return {
      featureCoverage: 0,
      workflowDepth: 0,
      outcomeVerification: 0,
      errorRecovery: 0,
      speedEfficiency: 0,
      crossFeatureChains: 0,
      edgeCaseHandling: 0,
      teachingAbility: 0,
      platformKnowledge: 0,
      consistency: 0,
    };
  }

  /**
   * Compute all 10 rating factors (each 0-100) from current app state.
   *
   * ALL evidence-based factors are SESSION-GATED: raw score × sessionMaturity.
   * sessionMaturity = min(sessionCount, 20) / 20 → maxes at 20 sessions.
   * This prevents inflating grades by automating everything in one burst.
   *
   * Hard-to-fake factors (consistency, platformKnowledge, edgeCaseHandling,
   * teachingAbility) have their own scaling that inherently requires time.
   */
  computeRatingFactors(data: AppMapData): RatingFactors {
    this.migrateToWeighted(data);
    const ladder = data.featureLadder;
    const metrics = this.computeMetrics(data);

    const totalWeight = ladder.reduce((s, f) => s + f.weight, 0);
    if (totalWeight === 0) return this.emptyRatingFactors();

    // Session gate: can't max coverage/workflow/verification in a few sessions.
    // Requires 20+ sessions to fully unlock. 4 sessions → 20% of raw score.
    const sessionMaturity = Math.min(data.sessionCount, 20) / 20;

    // ── Evidence-based factors (session-gated) ──────────────────────

    // 1. Feature Coverage: raw breadth × session maturity
    const featureCoverage = metrics.breadth * 100 * sessionMaturity;

    // 2. Workflow Depth: raw workflow breadth × session maturity
    const workflowDepth = metrics.workflowBreadth * 100 * sessionMaturity;

    // 3. Outcome Verification: raw outcome breadth × session maturity
    const outcomeVerification = metrics.outcomeBreadth * 100 * sessionMaturity;

    // 4. Error Recovery: healing rate — 0 if untested (no free pass)
    const totalFailures = Object.values(data.featureMastery).reduce((s, fm) => s + fm.failCount, 0);
    const errorRecovery = totalFailures > 0
      ? Math.min(100, metrics.healingRate * 100)
      : 0;

    // 5. Repeat Mastery (speedEfficiency field): features with 10+ repeats, session-gated
    //    Measures whether you actually USE features repeatedly, not just touch them
    let featuresWithRepeats = 0;
    for (const f of ladder) {
      const fm = data.featureMastery[f.id];
      if (fm && fm.repeatCount >= 10) featuresWithRepeats++;
    }
    const repeatRaw = ladder.length > 0 ? (featuresWithRepeats / ladder.length) * 100 : 0;
    const speedEfficiency = repeatRaw * sessionMaturity;

    // 6. Cross-Feature Chains: need 50+ to max (was 12 — way too easy to inflate)
    const crossFeatureChains = Math.min(100, (data.crossFeatureWorkflows / 50) * 100);

    // ── Hard-to-fake factors (inherently time-gated) ────────────────

    // 7. Edge Case Handling: need 50+ edge cases (dialogs, errors, unexpected states)
    const edgeCasesHandled = data.edgeCasesHandled ?? 0;
    const edgeCaseHandling = Math.min(100, (edgeCasesHandled / 50) * 100);

    // 8. Teaching Ability: need 10+ playbooks exported
    const playbooksExported = data.playbooksExported ?? 0;
    const teachingAbility = Math.min(100, (playbooksExported / 10) * 100);

    // 9. Platform Knowledge: need 50+ shortcuts/hidden features
    const shortcutsUsed = data.shortcutsUsed ?? 0;
    const platformKnowledge = Math.min(100, (shortcutsUsed / 50) * 100);

    // 10. Consistency: need 50+ sessions × sustained reliability
    //     THE hardest factor to game — requires showing up over time
    const consistencyFactor = Math.min(data.sessionCount, 50) / 50;
    const consistency = consistencyFactor * metrics.reliability * 100;

    return {
      featureCoverage: Math.round(Math.min(100, featureCoverage)),
      workflowDepth: Math.round(Math.min(100, workflowDepth)),
      outcomeVerification: Math.round(Math.min(100, outcomeVerification)),
      errorRecovery: Math.round(errorRecovery),
      speedEfficiency: Math.round(Math.min(100, speedEfficiency)),
      crossFeatureChains: Math.round(crossFeatureChains),
      edgeCaseHandling: Math.round(edgeCaseHandling),
      teachingAbility: Math.round(teachingAbility),
      platformKnowledge: Math.round(platformKnowledge),
      consistency: Math.round(Math.min(100, consistency)),
    };
  }

  /**
   * Compute game-style rating from the 10 weighted factors.
   * Returns grade (F→0) and sub-tier (1-3).
   */
  computeRating(factors: RatingFactors): Rating {
    // Weighted average of all 10 factors (0-100 scale)
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [key, weight] of Object.entries(RATING_FACTOR_WEIGHTS)) {
      const score = factors[key as keyof RatingFactors];
      weightedSum += score * weight;
      totalWeight += weight;
    }
    const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Find grade from thresholds (sorted highest first)
    let grade: RatingGrade = "F";
    for (const threshold of GRADE_THRESHOLDS) {
      if (finalScore >= threshold.minScore) {
        grade = threshold.grade;
        break;
      }
    }

    // Sub-tier within grade: divide the range into 3 equal parts
    const gradeIdx = GRADE_THRESHOLDS.findIndex(t => t.grade === grade);
    const gradeMin = GRADE_THRESHOLDS[gradeIdx]!.minScore;
    const gradeMax = gradeIdx > 0 ? GRADE_THRESHOLDS[gradeIdx - 1]!.minScore : 100;
    const range = gradeMax - gradeMin;
    const posInRange = finalScore - gradeMin;
    const subTier: RatingSubTier = range > 0
      ? (posInRange < range / 3 ? 1 : posInRange < (range * 2) / 3 ? 2 : 3)
      : 1;

    return { grade, subTier };
  }

  /**
   * Migrate old completedFeatures[] format to new featureMastery{} format.
   * Old features get depth=1 (navigated), since that's all we knew.
   */
  private migrateToWeighted(data: AppMapData): void {
    if (!data.featureMastery) data.featureMastery = {};
    if (!data.masteryMetrics) data.masteryMetrics = this.emptyMetrics();
    if (data.crossFeatureWorkflows == null) data.crossFeatureWorkflows = 0;
    if (!data.featureLadder) data.featureLadder = this.getFeatureLadder(data.app);
    // Migrate to rating system
    if (!data.rating) data.rating = { grade: "F", subTier: 1 };
    if (!data.ratingFactors) data.ratingFactors = this.emptyRatingFactors();
    if (data.shortcutsUsed == null) data.shortcutsUsed = 0;
    if (data.playbooksExported == null) data.playbooksExported = 0;
    if (data.edgeCasesHandled == null) data.edgeCasesHandled = 0;

    // Sync ladder with builtin: add new features, update weights/critical flags
    const builtin = this.getFeatureLadder(data.app);
    const existingIds = new Set(data.featureLadder.map((f) => f.id));
    const builtinIds = new Set(builtin.map((f) => f.id));
    let ladderChanged = false;

    // Add features that exist in builtin but not in data
    for (const bf of builtin) {
      if (!existingIds.has(bf.id)) {
        data.featureLadder.push(bf);
        ladderChanged = true;
      } else {
        // Update weight/critical/level from builtin (code is source of truth)
        const existing = data.featureLadder.find((f) => f.id === bf.id);
        if (existing && (existing.weight !== bf.weight || existing.critical !== bf.critical || existing.level !== bf.level)) {
          existing.weight = bf.weight;
          existing.critical = bf.critical;
          existing.level = bf.level;
          ladderChanged = true;
        }
      }
    }

    // Remove features that no longer exist in builtin (only if app has a handcrafted ladder)
    const hasBuiltinLadder = !!BUILTIN_LADDERS[data.app];
    if (hasBuiltinLadder && builtinIds.size > 0) {
      // Migrate renamed features: old ID → closest new ID by mastery data
      const OLD_TO_NEW: Record<string, string> = {
        roles_notifications: "roles_permissions",
        community_design: "community_growth",
        moderation_tools: "moderation_system",
        bots_integrations: "bot_ecosystem",
      };
      for (const [oldId, newId] of Object.entries(OLD_TO_NEW)) {
        if (data.featureMastery[oldId] && !data.featureMastery[newId]) {
          data.featureMastery[newId] = data.featureMastery[oldId]!;
          delete data.featureMastery[oldId];
          ladderChanged = true;
        }
      }

      const toRemove = data.featureLadder.filter((f) => !builtinIds.has(f.id));
      if (toRemove.length > 0) {
        data.featureLadder = data.featureLadder.filter((f) => builtinIds.has(f.id));
        ladderChanged = true;
      }
    }

    if (ladderChanged) {
      // Sort ladder by builtin order
      const orderMap = new Map(builtin.map((f, i) => [f.id, i]));
      data.featureLadder.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
    }

    // Migrate old completedFeatures to depth=1 entries
    if (data.completedFeatures && data.completedFeatures.length > 0) {
      for (const fid of data.completedFeatures) {
        if (!data.featureMastery[fid]) {
          data.featureMastery[fid] = {
            depth: 1,
            confidence: 0.3,
            repeatCount: 1,
            workflowCount: 0,
            healingCount: 0,
            failCount: 0,
            lastSeen: data.lastValidated,
            lastVerified: null,
          };
        }
      }
      // Clear old field after migration
      data.completedFeatures = [];
    }
  }

  // ── Version / Staleness ───────────────────────────────────────────

  applyVersionChange(bundleId: string, newVersion: string): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;
    if (data.version === newVersion) return;

    data.version = newVersion;
    data.confidence *= this.config.versionDecayFactor;
    this.recomputeTier(data);

    // Unverify all edges on version change
    for (const edge of data.navigationGraph.edges) {
      edge.verified = false;
    }

    this.save(data);
  }

  applyStaleDecay(bundleId: string): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    data.confidence = this.computeConfidence(data);
    this.recomputeTier(data);
    this.save(data);
  }

  // ── Pruning ───────────────────────────────────────────────────────

  prune(bundleId: string): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    // Prune elements unused for too many sessions
    for (const zone of Object.values(data.zones)) {
      zone.elements = zone.elements.filter(
        (e) => e.sessionsSinceUse < this.config.pruneSessionThreshold,
      );
    }

    // Remove empty zones (except auto_discovered)
    for (const [key, zone] of Object.entries(data.zones)) {
      if (zone.elements.length === 0 && key !== "auto_discovered") {
        delete data.zones[key];
      }
    }

    // Cap zones
    const zoneKeys = Object.keys(data.zones);
    if (zoneKeys.length > this.config.maxZonesPerApp) {
      // Keep zones with most elements
      const sorted = zoneKeys.sort(
        (a, b) => (data.zones[b]?.elements.length ?? 0) - (data.zones[a]?.elements.length ?? 0),
      );
      for (const key of sorted.slice(this.config.maxZonesPerApp)) {
        delete data.zones[key];
      }
    }

    // Cap elements per zone
    for (const zone of Object.values(data.zones)) {
      if (zone.elements.length > this.config.maxElementsPerZone) {
        zone.elements.sort(
          (a, b) => new Date(b.lastInteracted).getTime() - new Date(a.lastInteracted).getTime(),
        );
        zone.elements = zone.elements.slice(0, this.config.maxElementsPerZone);
      }
    }

    // Cap edges
    if (data.navigationGraph.edges.length > this.config.maxEdges) {
      data.navigationGraph.edges.sort(
        (a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
      );
      data.navigationGraph.edges = data.navigationGraph.edges.slice(0, this.config.maxEdges);
    }

    this.save(data);
  }

  // ── Session Tracking ──────────────────────────────────────────────

  incrementSession(bundleId: string): void {
    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    data.sessionCount++;
    // Increment sessionsSinceUse for all elements
    for (const zone of Object.values(data.zones)) {
      for (const el of zone.elements) {
        el.sessionsSinceUse++;
      }
    }
    this.save(data);
  }

  // ── Summary ───────────────────────────────────────────────────────

  getSummary(bundleId: string): string | null {
    const data = this.ensureLoaded(bundleId);
    if (!data) return null;
    this.migrateToWeighted(data);

    const ladder = data.featureLadder ?? this.getFeatureLadder(bundleId);
    const metrics = this.computeMetrics(data);

    // Count features at each depth level
    let d1 = 0, d2 = 0, d3 = 0, d4 = 0;
    for (const f of ladder) {
      const fm = data.featureMastery[f.id];
      const d = fm?.depth ?? 0;
      if (d >= 1) d1++;
      if (d >= 2) d2++;
      if (d >= 3) d3++;
      if (d >= 4) d4++;
    }

    // Show game-style rating as primary, legacy tier in parentheses
    const rating = data.rating ?? { grade: "F" as RatingGrade, subTier: 1 as RatingSubTier };
    const ratingStr = ratingToString(rating);

    return (
      `Map: ${data.appName} — Rating ${ratingStr} [${data.masteryLevel.toUpperCase()}] ` +
      `(${(data.confidence * 100).toFixed(0)}%, ` +
      `${ladder.length} features [nav:${d1} act:${d2} wf:${d3} out:${d4}], ` +
      `rel:${(metrics.reliability * 100).toFixed(0)}% heal:${(metrics.healingRate * 100).toFixed(0)}% ` +
      `xwf:${metrics.crossFeatureWorkflows} crit:${metrics.criticalFloor})`
    );
  }

  // ── Conditional UI Tracking ─────────────────────────────────────

  /**
   * Record whether an element was seen (or absent) on a given page.
   * Auto-creates a VisibilityCondition if new, updates stats, and
   * auto-classifies the condition type from the accumulated pattern.
   */
  recordElementVisibility(
    bundleId: string,
    elementLabel: string,
    pageContext: string,
    seen: boolean,
  ): void {
    // M3: Reject empty element label
    if (!elementLabel) return;

    // V2: Redact PII from element label before persistence
    elementLabel = redactPII(elementLabel);

    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    if (!data.visibilityConditions) data.visibilityConditions = [];

    let vc = data.visibilityConditions.find(
      (v) => v.elementLabel === elementLabel,
    );

    const now = new Date().toISOString();

    if (!vc) {
      // Enforce limit before creating new entry
      if (data.visibilityConditions.length >= this.config.maxVisibilityConditions) {
        return;
      }
      vc = {
        elementLabel,
        conditionType: "unknown",
        description: "",
        seenOnPages: [],
        absentOnPages: [],
        seenCount: 0,
        checkCount: 0,
        visibilityRate: 0,
        lastSeen: now,
        firstSeen: now,
      };
      data.visibilityConditions.push(vc);
    }

    vc.checkCount++;

    if (seen) {
      vc.seenCount++;
      vc.lastSeen = now;
      if (pageContext && !vc.seenOnPages.includes(pageContext) && vc.seenOnPages.length < 100) {
        vc.seenOnPages.push(pageContext);
      }
    } else {
      if (pageContext && !vc.absentOnPages.includes(pageContext) && vc.absentOnPages.length < 100) {
        vc.absentOnPages.push(pageContext);
      }
    }

    vc.visibilityRate = vc.checkCount > 0 ? vc.seenCount / vc.checkCount : 0;

    // Auto-classify condition type from accumulated pattern
    vc.conditionType = this.classifyVisibilityCondition(vc);
    vc.description = this.describeVisibilityCondition(vc);

    this.save(data);
  }

  /**
   * Get elements with visibilityRate < 0.9 — elements that are NOT always visible.
   * These are the conditional UI elements worth tracking.
   */
  getConditionalElements(bundleId: string): VisibilityCondition[] {
    const data = this.ensureLoaded(bundleId);
    if (!data?.visibilityConditions) return [];
    return data.visibilityConditions.filter((v) => v.visibilityRate < 0.9);
  }

  /**
   * Get elements that have only been seen on a specific page.
   * Useful for knowing what UI to expect when navigating to a page.
   */
  getPageSpecificElements(
    bundleId: string,
    pageContext: string,
  ): VisibilityCondition[] {
    const data = this.ensureLoaded(bundleId);
    if (!data?.visibilityConditions) return [];
    return data.visibilityConditions.filter(
      (v) =>
        v.seenOnPages.includes(pageContext) &&
        v.seenOnPages.length === 1 &&
        v.absentOnPages.length > 0,
    );
  }

  /**
   * Classify a visibility condition from its accumulated pattern.
   * - "page": only seen on specific pages, absent on others
   * - "session": seen early but not recently (visibilityRate < 0.5)
   * - "state": intermittent visibility (0.3-0.8), depends on app state
   * - "unknown": not enough data or doesn't fit other patterns
   */
  private classifyVisibilityCondition(
    vc: VisibilityCondition,
  ): VisibilityCondition["conditionType"] {
    // Need at least 3 checks to start classifying
    if (vc.checkCount < 3) return "unknown";

    // Page-conditional: seen on some pages, absent on DIFFERENT pages.
    // If the same page appears in both seen and absent, that's state-dependent,
    // not page-dependent — the element appears/disappears on the same page.
    if (
      vc.seenOnPages.length > 0 &&
      vc.absentOnPages.length > 0 &&
      vc.visibilityRate < 0.9
    ) {
      const hasDistinctPages = vc.absentOnPages.some(
        (p) => !vc.seenOnPages.includes(p),
      );
      if (hasDistinctPages) {
        return "page";
      }
    }

    // Session-conditional: seen early, disappeared (rate < 0.5 and
    // first observation is significantly older than last observation)
    if (vc.visibilityRate < 0.5 && vc.seenCount > 0) {
      const firstTime = new Date(vc.firstSeen).getTime();
      const lastSeenTime = new Date(vc.lastSeen).getTime();
      const age = Date.now() - firstTime;
      const recentness = Date.now() - lastSeenTime;
      // If element was seen long ago but not recently (>50% of its age ago)
      if (age > 0 && recentness > age * 0.5) {
        return "session";
      }
    }

    // State-conditional: intermittent visibility, depends on app state
    if (vc.visibilityRate >= 0.3 && vc.visibilityRate <= 0.8) {
      return "state";
    }

    return "unknown";
  }

  /**
   * Generate a human-readable description of when an element appears.
   */
  private describeVisibilityCondition(vc: VisibilityCondition): string {
    switch (vc.conditionType) {
      case "page":
        return `Only visible on: ${vc.seenOnPages.join(", ")}`;
      case "session":
        return `Appeared in early sessions, not seen recently (${Math.round(vc.visibilityRate * 100)}% visibility)`;
      case "state":
        return `Intermittently visible (${Math.round(vc.visibilityRate * 100)}% of checks), likely state-dependent`;
      default:
        return `Visibility rate: ${Math.round(vc.visibilityRate * 100)}%`;
    }
  }

  // ── Timing & Animation ──────────────────────────────────────────────

  /**
   * Record a timing measurement for an element or action.
   * If an existing profile exists for the same key+type, updates the
   * running average: newAvg = (oldAvg * (n-1) + newValue) / n.
   * Respects maxTimingProfiles config limit.
   */
  recordTiming(
    bundleId: string,
    key: string,
    type: TimingProfile["type"],
    durationMs: number,
  ): void {
    // M3: Reject empty key
    if (!key) return;
    // Guard: reject non-finite or negative durations to prevent data corruption
    if (!Number.isFinite(durationMs) || durationMs < 0) return;

    // V2: Redact PII from timing key before persistence
    key = redactPII(key);

    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    if (!data.timingProfiles) data.timingProfiles = [];

    const now = new Date().toISOString();

    // Find existing profile for same key+type
    const existing = data.timingProfiles.find(
      (p) => p.key === key && p.type === type,
    );

    if (existing) {
      // Running average: newAvg = (oldAvg * (n-1) + newValue) / n
      const n = existing.sampleCount;
      existing.avgMs = (existing.avgMs * n + durationMs) / (n + 1);
      existing.minMs = Math.min(existing.minMs, durationMs);
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      existing.sampleCount++;
      existing.lastMs = durationMs;
      existing.lastMeasured = now;
    } else {
      // Enforce limit
      if (data.timingProfiles.length >= this.config.maxTimingProfiles) return;

      data.timingProfiles.push({
        key,
        type,
        avgMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
        sampleCount: 1,
        lastMs: durationMs,
        lastMeasured: now,
      });
    }

    this.save(data);
  }

  /**
   * Record a ready-state signal (how to know when UI is ready after an action).
   * If an existing signal for the same afterAction+signal exists, updates
   * typicalMs (running average) and maxObservedMs.
   * Respects maxReadySignals config limit.
   */
  recordReadySignal(
    bundleId: string,
    afterAction: string,
    signal: string,
    waitMs: number,
  ): void {
    // M3: Reject empty action/signal
    if (!afterAction || !signal) return;
    // Guard: reject non-finite or negative wait times to prevent data corruption
    if (!Number.isFinite(waitMs) || waitMs < 0) return;

    // V2: Redact PII from user-facing strings before persistence
    afterAction = redactPII(afterAction);
    signal = redactPII(signal);

    const data = this.ensureLoaded(bundleId);
    if (!data) return;

    if (!data.readySignals) data.readySignals = [];

    const now = new Date().toISOString();

    // Find existing signal for same afterAction+signal
    const existing = data.readySignals.find(
      (s) => s.afterAction === afterAction && s.signal === signal,
    );

    if (existing) {
      // Running average for typicalMs
      const n = existing.sampleCount;
      existing.typicalMs = (existing.typicalMs * n + waitMs) / (n + 1);
      existing.maxObservedMs = Math.max(existing.maxObservedMs, waitMs);
      existing.sampleCount++;
      existing.lastSeen = now;
    } else {
      // Enforce limit
      if (data.readySignals.length >= this.config.maxReadySignals) return;

      data.readySignals.push({
        afterAction,
        signal,
        typicalMs: waitMs,
        maxObservedMs: waitMs,
        sampleCount: 1,
        lastSeen: now,
      });
    }

    this.save(data);
  }

  /**
   * Get timing profiles for an app, optionally filtered by key.
   * Returns empty array if no timing data exists.
   */
  getTimingProfile(bundleId: string, key?: string): TimingProfile[] {
    const data = this.ensureLoaded(bundleId);
    if (!data?.timingProfiles) return [];

    if (key != null) {
      return data.timingProfiles.filter((p) => p.key === key);
    }
    return data.timingProfiles;
  }

  /**
   * Get all ready-state signals for an app.
   * Returns empty array if no signals exist.
   */
  getReadySignals(bundleId: string): ReadySignal[] {
    const data = this.ensureLoaded(bundleId);
    if (!data?.readySignals) return [];
    return data.readySignals;
  }

  /**
   * Get the expected wait time (in ms) for an action, based on recorded ready signals.
   * Returns null if no signal is recorded for the given action.
   * If multiple signals exist for the same action, returns the maximum typicalMs.
   */
  getExpectedWait(bundleId: string, action: string): number | null {
    const data = this.ensureLoaded(bundleId);
    if (!data?.readySignals) return null;

    const matching = data.readySignals.filter((s) => s.afterAction === action);
    if (matching.length === 0) return null;

    // Return the max typicalMs across all matching signals
    let maxTypical = 0;
    for (const s of matching) {
      if (s.typicalMs > maxTypical) maxTypical = s.typicalMs;
    }
    return maxTypical;
  }

  /**
   * Wire #15: Check if an element is well-known and recently verified.
   * Returns true if the element has 3+ successes and was interacted with
   * within maxAgeMs (default 5 minutes). Used by Executor to skip verify.
   */
  isElementVerified(bundleId: string, label: string, maxAgeMs = 300_000): boolean {
    const data = this.ensureLoaded(bundleId);
    if (!data) return false;

    const now = Date.now();
    for (const zone of Object.values(data.zones)) {
      for (const el of zone.elements) {
        if (el.label === label && el.successCount >= 3) {
          const lastTime = new Date(el.lastInteracted).getTime();
          const elapsed = now - lastTime;
          // Guard: elapsed must be non-negative (rejects future dates from clock skew)
          // and within the staleness window
          if (elapsed >= 0 && elapsed <= maxAgeMs) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Wire F9: Import element knowledge from a community playbook.
   * Creates the app entry if it doesn't exist, then records each step's
   * target as a successful element interaction.
   */
  importFromPlaybook(
    bundleId: string,
    appName: string,
    steps: Array<{ tool: string; params?: Record<string, unknown>; description?: string }>,
  ): void {
    let data = this.ensureLoaded(bundleId);
    if (!data) {
      data = this.createEmpty(bundleId, appName);
      this.save(data); // Persist to cache + disk so recordElementOutcome can find it
    }
    for (const step of steps) {
      const label = (step.params?.text ?? step.params?.title ?? step.params?.target ?? step.description) as string | undefined;
      if (!label || typeof label !== "string") continue;
      this.recordElementOutcome(bundleId, "auto", label, true);
    }
  }

  /**
   * List all known app bundleIds by scanning the maps directory.
   * Returns bundleIds derived from filenames (excludes .ladder.json files).
   */
  listKnownApps(): string[] {
    try {
      const dirents = fs.readdirSync(this.config.mapsDir, { withFileTypes: true });
      const bundleIds: string[] = [];
      for (const dirent of dirents) {
        // Skip symlinks and directories — only read regular files
        if (!dirent.isFile()) continue;
        const file = dirent.name;
        if (file.endsWith(".json") && !file.endsWith(".ladder.json")) {
          const stem = file.slice(0, -5);
          // Load the file and use data.app (canonical bundleId) instead of
          // filename stem, which may differ from the original bundleId due
          // to filesystem sanitization in filePath()
          const data = this.ensureLoaded(stem);
          if (data?.app) {
            bundleIds.push(data.app);
          }
        }
      }
      return bundleIds;
    } catch {
      return [];
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private ensureLoaded(bundleId: string): AppMapData | null {
    return this.cache.get(bundleId) ?? this.load(bundleId);
  }

  private filePath(bundleId: string): string {
    // Sanitize bundleId for filesystem safety — strip path traversal sequences first
    const safe = bundleId.replace(/\.\./g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.config.mapsDir, `${safe}.json`);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeDirty();
    }, 500);
  }

  private writeDirty(): void {
    for (const bundleId of this.dirty) {
      const data = this.cache.get(bundleId);
      if (!data) continue;
      try {
        writeFileAtomicSync(
          this.filePath(bundleId),
          JSON.stringify(data, null, 2) + "\n",
        );
      } catch {
        // Persistence failure is non-fatal
      }
    }
    this.dirty.clear();
  }
}
