// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlatformExplorer — autonomously explore an app or website.
 *
 * Maps all interactive elements, tries each one, records working selectors,
 * broken paths, and errors. Outputs a reference JSON.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../util/atomic-write.js";

/** Patterns for buttons that should never be clicked */
const DANGEROUS_PATTERNS = /delete|logout|log.?out|remove|cancel|unsubscribe|deactivate|sign.?out|close.?account|erase|destroy|terminate|disconnect|revoke/i;

interface DiscoveredElement {
  selector: string;
  text: string;
  tag: string;
  role?: string;
  ariaLabel?: string;
}

interface TestedElement extends DiscoveredElement {
  clickWorked: boolean;
  result: string;
  error?: string;
  newUrl?: string;
  stateChange?: string;
}

export interface ExploreResult {
  platform: string;
  exploredAt: string;
  source: "web" | "native";
  url?: string;
  bundleId?: string;
  totalElements: number;
  testedElements: number;
  workingSelectors: number;
  selectors: Record<string, Record<string, string>>;
  navigation: Array<{ text: string; selector: string; worked: boolean; url?: string }>;
  errors: Array<{ error: string; context: string; solution: string; severity: "high" | "medium" | "low" }>;
  keyDiscoveries: string[];
}

/** Discover all interactive elements on a web page via CDP */
export async function discoverWebElements(
  cdpEvaluate: (expr: string) => Promise<any>,
  maxElements: number,
): Promise<DiscoveredElement[]> {
  const result = await cdpEvaluate(`(() => {
    const elements = [];
    const selectors = new Set();
    const interactive = document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [onclick], [data-testid], summary'
    );
    for (const el of interactive) {
      if (elements.length >= ${maxElements}) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < 0 || rect.left < 0) continue;

      let selector = '';
      if (el.getAttribute('data-testid')) selector = '[data-testid="' + el.getAttribute('data-testid') + '"]';
      else if (el.id) selector = '#' + el.id;
      else if (el.getAttribute('aria-label')) selector = '[aria-label="' + el.getAttribute('aria-label') + '"]';
      else {
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().substring(0, 30);
        selector = tag + (text ? ':text("' + text + '")' : ':nth(' + elements.length + ')');
      }

      if (selectors.has(selector)) continue;
      selectors.add(selector);

      elements.push({
        selector,
        text: (el.textContent || '').trim().substring(0, 100),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
      });
    }
    return elements;
  })()`);
  return result.result?.value ?? [];
}

/** Test clicking an element and record what happens */
export async function testWebElement(
  cdpEvaluate: (expr: string) => Promise<any>,
  element: DiscoveredElement,
): Promise<TestedElement> {
  // Check if dangerous
  if (DANGEROUS_PATTERNS.test(element.text) || DANGEROUS_PATTERNS.test(element.ariaLabel ?? "")) {
    return { ...element, clickWorked: false, result: "skipped_dangerous", error: "Skipped: potentially destructive action" };
  }

  try {
    // Get pre-click state
    const preState = await cdpEvaluate(`(() => ({ url: location.href, title: document.title }))()`)
    const pre = preState.result?.value ?? { url: "", title: "" };

    // Click the element
    const clickResult = await cdpEvaluate(`(() => {
      const el = document.querySelector('${element.selector.replace(/'/g, "\\'")}');
      if (!el) return { found: false };
      el.click();
      return { found: true };
    })()`);

    if (!clickResult.result?.value?.found) {
      return { ...element, clickWorked: false, result: "element_not_found" };
    }

    // Wait for UI to settle
    await new Promise(r => setTimeout(r, 800));

    // Get post-click state
    const postState = await cdpEvaluate(`(() => ({ url: location.href, title: document.title }))()`)
    const post = postState.result?.value ?? { url: "", title: "" };

    const urlChanged = pre.url !== post.url;
    const titleChanged = pre.title !== post.title;
    const stateChange = urlChanged ? `url_changed: ${post.url}` : titleChanged ? `title_changed: ${post.title}` : "no_visible_change";

    // Navigate back if URL changed
    if (urlChanged) {
      await cdpEvaluate(`history.back()`);
      await new Promise(r => setTimeout(r, 500));
    }

    return {
      ...element,
      clickWorked: true,
      result: stateChange,
      newUrl: urlChanged ? post.url : undefined,
      stateChange,
    };
  } catch (err) {
    return {
      ...element,
      clickWorked: false,
      result: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Discover all interactive elements in a native app via AX bridge */
export async function discoverNativeElements(
  bridge: { call: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  pid: number,
  maxElements: number,
): Promise<DiscoveredElement[]> {
  const tree = await bridge.call<any>("ax.getElementTree", { pid, maxDepth: 5 });
  const elements: DiscoveredElement[] = [];

  const CLICKABLE_ROLES = new Set([
    "AXButton", "AXLink", "AXMenuItem", "AXTab", "AXCheckBox",
    "AXPopUpButton", "AXRadioButton", "AXSwitch", "AXDisclosureTriangle",
  ]);

  function walk(node: any, path: number[] = []) {
    if (elements.length >= maxElements) return;
    if (node.role && CLICKABLE_ROLES.has(node.role)) {
      const title = node.title || node.description || node.value || "";
      if (title && !DANGEROUS_PATTERNS.test(title)) {
        elements.push({
          selector: path.join("."),
          text: String(title).substring(0, 100),
          tag: node.role,
          role: node.role,
          ariaLabel: node.description,
        });
      }
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child: any, i: number) => walk(child, [...path, i]));
    }
  }

  walk(tree);
  return elements;
}

/** Compile exploration results into a reference JSON */
export function compileReference(
  platform: string,
  source: "web" | "native",
  tested: TestedElement[],
  url?: string,
  bundleId?: string,
): ExploreResult {
  const working = tested.filter(t => t.clickWorked);
  const broken = tested.filter(t => !t.clickWorked && t.result !== "skipped_dangerous");
  const skipped = tested.filter(t => t.result === "skipped_dangerous");

  // Group working selectors by tag/role
  const selectors: Record<string, Record<string, string>> = {};
  for (const el of working) {
    const group = el.role ?? el.tag;
    if (!selectors[group]) selectors[group] = {};
    const key = el.text.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 40) || `el_${Object.keys(selectors[group]).length}`;
    selectors[group][key] = el.selector;
  }

  const navigation = working
    .filter((t): t is TestedElement & { newUrl: string } => t.newUrl !== undefined)
    .map(t => ({ text: t.text, selector: t.selector, worked: true, url: t.newUrl }));

  const errors = broken.map(t => ({
    error: t.error ?? t.result,
    context: `Clicking "${t.text}" (${t.selector})`,
    solution: "Element may be hidden, disabled, or require prior interaction",
    severity: "low" as const,
  }));

  const keyDiscoveries: string[] = [];
  keyDiscoveries.push(`Found ${tested.length} interactive elements, ${working.length} clickable, ${broken.length} broken, ${skipped.length} skipped (dangerous)`);
  if (navigation.length > 0) keyDiscoveries.push(`${navigation.length} navigation links discovered`);
  if (Object.keys(selectors).length > 0) keyDiscoveries.push(`Selector groups: ${Object.keys(selectors).join(", ")}`);

  return {
    platform,
    exploredAt: new Date().toISOString(),
    source,
    ...(url !== undefined ? { url } : {}),
    ...(bundleId !== undefined ? { bundleId } : {}),
    totalElements: tested.length,
    testedElements: tested.filter(t => t.result !== "skipped_dangerous").length,
    workingSelectors: working.length,
    selectors,
    navigation,
    errors,
    keyDiscoveries,
  };
}

/** Save exploration result as a reference JSON */
export function saveExploreResult(referencesDir: string, result: ExploreResult): string {
  if (!fs.existsSync(referencesDir)) {
    fs.mkdirSync(referencesDir, { recursive: true });
  }
  const safePlatform = result.platform.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 100);
  const filePath = path.join(referencesDir, `${safePlatform}-explore.json`);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(referencesDir))) {
    throw new Error("Invalid platform name — path traversal detected");
  }

  // Build reference format matching existing references
  const reference = {
    id: `${result.platform}-explore`,
    name: `${result.platform} — Auto-Explored`,
    description: `Auto-explored ${result.source === "web" ? result.url : result.bundleId}. Found ${result.workingSelectors} working selectors out of ${result.totalElements} elements.`,
    platform: result.platform,
    version: "1.0.0",
    tags: [result.platform, "auto-explored"],
    successCount: result.workingSelectors,
    failCount: result.errors.length,
    selectors: result.selectors,
    errors: result.errors,
    _meta: {
      exploredAt: result.exploredAt,
      source: result.source,
      url: result.url,
      bundleId: result.bundleId,
      totalElements: result.totalElements,
      testedElements: result.testedElements,
      workingSelectors: result.workingSelectors,
      keyDiscoveries: result.keyDiscoveries,
    },
  };

  writeFileAtomicSync(filePath, JSON.stringify(reference, null, 2));
  return filePath;
}
