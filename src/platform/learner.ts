// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlatformLearner — scrape official docs, help center, shortcuts for a platform.
 *
 * Crawls documentation pages via CDP, extracts structured data,
 * and saves as a reference JSON.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../util/atomic-write.js";

export interface LearnResult {
  platform: string;
  bundleId?: string;
  learnedAt: string;
  sourceUrls: string[];
  shortcuts: Record<string, string>;
  features: string[];
  selectors: Record<string, Record<string, string>>;
  flows: Record<string, { description: string; steps: string[] }>;
  apiEndpoints: string[];
  knownLimitations: string[];
  tips: string[];
}

/** Common URL patterns for platform documentation */
export function buildDocUrls(platform: string, rootUrl?: string): string[] {
  const base = rootUrl ?? `https://${platform}.com`;
  const origin = base.replace(/\/$/, "");

  return [
    origin,
    `${origin}/help`,
    `${origin}/support`,
    `${origin}/docs`,
    `${origin}/keyboard-shortcuts`,
    `${origin}/shortcuts`,
    `https://help.${platform}.com`,
    `https://support.${platform}.com`,
    `https://docs.${platform}.com`,
    `${origin}/developers`,
    `${origin}/api`,
    `${origin}/changelog`,
    `${origin}/whats-new`,
  ];
}

/** Extract keyboard shortcuts from a page */
export async function extractShortcuts(
  cdpEvaluate: (expr: string) => Promise<any>,
): Promise<Record<string, string>> {
  const result = await cdpEvaluate(`(() => {
    const shortcuts = {};
    // Look for common shortcut table patterns
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
          const text0 = (cells[0].textContent || '').trim();
          const text1 = (cells[1].textContent || '').trim();
          // Check if either cell contains key combos
          if (text0.match(/[⌘⌥⇧⌃]|ctrl|cmd|alt|shift/i) || text1.match(/[⌘⌥⇧⌃]|ctrl|cmd|alt|shift/i)) {
            shortcuts[text0] = text1;
          }
        }
      }
    }
    // Also check kbd elements
    const kbds = document.querySelectorAll('kbd');
    for (const kbd of kbds) {
      const parent = kbd.closest('li, tr, p, div');
      if (parent) {
        const keyText = kbd.textContent.trim();
        const descText = parent.textContent.replace(keyText, '').trim().substring(0, 80);
        if (keyText && descText) shortcuts[keyText] = descText;
      }
    }
    return shortcuts;
  })()`);
  return result.result?.value ?? {};
}

/** Extract page content as structured text */
export async function extractPageContent(
  cdpEvaluate: (expr: string) => Promise<any>,
): Promise<{ title: string; headings: string[]; links: Array<{ text: string; href: string }>; text: string }> {
  const result = await cdpEvaluate(`(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent.trim()).filter(Boolean);
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
      text: (a.textContent || '').trim().substring(0, 80),
      href: a.href,
    })).filter(l => l.text && l.href);
    return {
      title: document.title,
      headings,
      links,
      text: document.body.innerText.substring(0, 8000),
    };
  })()`);
  return result.result?.value ?? { title: "", headings: [], links: [], text: "" };
}

/** Extract interactive element selectors from a page */
export async function extractSelectors(
  cdpEvaluate: (expr: string) => Promise<any>,
): Promise<Record<string, string>> {
  const result = await cdpEvaluate(`(() => {
    const selectors = {};
    const elements = document.querySelectorAll('[data-testid], [aria-label], [role="button"], [role="tab"], [role="menuitem"]');
    for (const el of Array.from(elements).slice(0, 50)) {
      const testId = el.getAttribute('data-testid');
      const label = el.getAttribute('aria-label');
      const key = testId || label || el.textContent?.trim().substring(0, 30) || '';
      if (!key) continue;

      let selector = '';
      if (testId) selector = '[data-testid="' + testId + '"]';
      else if (el.id) selector = '#' + el.id;
      else if (label) selector = '[aria-label="' + label + '"]';

      if (selector) selectors[key] = selector;
    }
    return selectors;
  })()`);
  return result.result?.value ?? {};
}

/** Crawl a page via CDP: navigate, wait, extract */
export async function crawlPage(
  cdpClient: { Runtime: any; Page: any },
  url: string,
  timeoutMs: number = 10000,
): Promise<{ success: boolean; content?: ReturnType<typeof extractPageContent> extends Promise<infer T> ? T : never; shortcuts?: Record<string, string>; selectors?: Record<string, string>; error?: string }> {
  try {
    // Navigate
    await cdpClient.Page.navigate({ url });

    // Wait for load
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      cdpClient.Page.loadEventFired().then(() => { clearTimeout(timer); resolve(); }).catch(() => { clearTimeout(timer); resolve(); });
    });

    // Extra wait for SPA content
    await new Promise(r => setTimeout(r, 2000));

    const evaluate = async (expr: string) => {
      return cdpClient.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    };

    const content = await extractPageContent(evaluate);
    const shortcuts = await extractShortcuts(evaluate);
    const selectors = await extractSelectors(evaluate);

    return { success: true, content, shortcuts, selectors };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Compile crawl results into a learn result */
export function compileLearnResult(
  platform: string,
  crawledPages: Array<{ url: string; content?: { title: string; headings: string[]; links: Array<{ text: string; href: string }>; text: string }; shortcuts?: Record<string, string>; selectors?: Record<string, string> }>,
): LearnResult {
  const allShortcuts: Record<string, string> = {};
  const allSelectors: Record<string, Record<string, string>> = {};
  const features: string[] = [];
  const tips: string[] = [];
  const sourceUrls: string[] = [];
  const flows: Record<string, { description: string; steps: string[] }> = {};
  const apiEndpoints: string[] = [];
  const knownLimitations: string[] = [];

  for (const page of crawledPages) {
    sourceUrls.push(page.url);

    if (page.shortcuts) {
      Object.assign(allShortcuts, page.shortcuts);
    }

    if (page.selectors && Object.keys(page.selectors).length > 0) {
      const pageName = page.content?.title?.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30) ?? "page";
      allSelectors[pageName] = page.selectors;
    }

    if (page.content) {
      // Extract features from headings
      for (const h of page.content.headings) {
        if (h.length > 3 && h.length < 80) features.push(h);
      }

      // Look for API-related links
      for (const link of page.content.links) {
        if (/api|developer|endpoint|sdk|integration/i.test(link.text)) {
          apiEndpoints.push(`${link.text}: ${link.href}`);
        }
      }

      // Extract flows from numbered step sequences (e.g. "1. Click..." "2. Enter..." "3. Submit...")
      const contentLines = page.content.text.split("\n");
      let currentFlow: { name: string; steps: string[] } | null = null;
      for (let i = 0; i < contentLines.length; i++) {
        const line = contentLines[i]!.trim();
        const stepMatch = line.match(/^(\d+)[.)]\s+(.+)/);
        if (stepMatch) {
          const stepNum = parseInt(stepMatch[1]!, 10);
          const stepText = stepMatch[2]!.trim();
          if (stepNum === 1 && stepText.length > 5) {
            // Start a new flow — use the preceding heading as the name
            const heading = i > 0 ? contentLines.slice(Math.max(0, i - 3), i).find(l => l.trim().length > 3 && !l.trim().match(/^\d/)) : null;
            const flowName = (heading?.trim() ?? `flow_${Object.keys(flows).length + 1}`).replace(/[^a-zA-Z0-9_ ]/g, "").substring(0, 50).trim();
            currentFlow = { name: flowName, steps: [stepText] };
          } else if (currentFlow && stepNum > 1) {
            currentFlow.steps.push(stepText);
          }
        } else if (currentFlow && currentFlow.steps.length >= 2) {
          // End of step sequence — save the flow
          const key = currentFlow.name.toLowerCase().replace(/\s+/g, "_");
          if (!flows[key]) {
            flows[key] = { description: currentFlow.name, steps: currentFlow.steps };
          }
          currentFlow = null;
        } else if (line.length > 0 && !line.match(/^\d/)) {
          currentFlow = null;
        }
      }
      // Save any trailing flow
      if (currentFlow && currentFlow.steps.length >= 2) {
        const key = currentFlow.name.toLowerCase().replace(/\s+/g, "_");
        if (!flows[key]) {
          flows[key] = { description: currentFlow.name, steps: currentFlow.steps };
        }
      }

      // Look for limitation/known-issue mentions
      const text = page.content.text.toLowerCase();
      if (text.includes("limitation") || text.includes("known issue") || text.includes("not supported")) {
        const lines = page.content.text.split("\n");
        for (const line of lines) {
          if (/limitation|known issue|not supported|doesn't support|won't work/i.test(line)) {
            knownLimitations.push(line.trim().substring(0, 200));
          }
        }
      }
    }
  }

  return {
    platform,
    learnedAt: new Date().toISOString(),
    sourceUrls,
    shortcuts: allShortcuts,
    features: [...new Set(features)].slice(0, 50),
    selectors: allSelectors,
    flows,
    apiEndpoints: [...new Set(apiEndpoints)].slice(0, 20),
    knownLimitations: [...new Set(knownLimitations)].slice(0, 20),
    tips,
  };
}

/** Save learn result as a reference JSON */
export function saveLearnResult(referencesDir: string, result: LearnResult): string {
  if (!fs.existsSync(referencesDir)) {
    fs.mkdirSync(referencesDir, { recursive: true });
  }
  const filePath = path.join(referencesDir, `${result.platform}-learned.json`);

  const reference = {
    id: `${result.platform}-learned`,
    name: `${result.platform} — Auto-Learned from Docs`,
    description: `Scraped ${result.sourceUrls.length} documentation pages. Found ${Object.keys(result.shortcuts).length} shortcuts, ${result.features.length} features.`,
    platform: result.platform,
    bundleId: result.bundleId ?? null,
    version: "1.0.0",
    tags: [result.platform, "auto-learned"],
    successCount: 0,
    failCount: 0,
    urls: Object.fromEntries(result.sourceUrls.map((u, i) => [`doc_${i}`, u])),
    selectors: result.selectors,
    shortcuts: result.shortcuts,
    flows: result.flows,
    detection: {},
    errors: [],
    policyNotes: {},
    _meta: {
      learnedAt: result.learnedAt,
      sourceUrls: result.sourceUrls,
      features: result.features,
      apiEndpoints: result.apiEndpoints,
      knownLimitations: result.knownLimitations,
      tips: result.tips,
    },
  };

  writeFileAtomicSync(filePath, JSON.stringify(reference, null, 2));
  return filePath;
}
