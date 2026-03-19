// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { DocParseResult, ParsedShortcut, ParsedFlowStep } from "./types.js";
import {
  parseShortcutsFromHTML,
  parseShortcutsFromText,
  parseShortcutsFromMarkdown,
} from "./shortcut-extractor.js";

/**
 * DocParser — extracts structured knowledge from documentation pages.
 * Handles HTML, markdown, and plain text.
 */
export class DocParser {
  /**
   * Parse a documentation page and extract shortcuts, flows, and tips.
   */
  parse(content: string, url: string, format: "html" | "markdown" | "text" = "html"): DocParseResult {
    const title = this.extractTitle(content, format);
    const shortcuts = this.extractShortcuts(content, format);
    const flows = this.extractFlows(content, format);
    const tips = this.extractTips(content, format);

    return {
      url,
      title,
      shortcuts,
      flows,
      tips,
      parsedAt: new Date().toISOString(),
    };
  }

  /**
   * Extract page title.
   */
  private extractTitle(content: string, format: string): string {
    if (format === "html") {
      const titleMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) return titleMatch[1]!.replace(/<[^>]+>/g, "").trim();
      const h1Match = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) return h1Match[1]!.replace(/<[^>]+>/g, "").trim();
    } else if (format === "markdown") {
      const mdTitle = content.match(/^#\s+(.+)$/m);
      if (mdTitle) return mdTitle[1]!.trim();
    }
    return "Untitled";
  }

  /**
   * Extract shortcuts from the content.
   */
  private extractShortcuts(content: string, format: string): ParsedShortcut[] {
    switch (format) {
      case "html":
        return parseShortcutsFromHTML(content);
      case "markdown":
        return parseShortcutsFromMarkdown(content);
      case "text":
        return parseShortcutsFromText(content);
      default:
        return [];
    }
  }

  /**
   * Extract workflow/how-to steps from documentation.
   * Looks for numbered lists, step-by-step sections.
   */
  private extractFlows(
    content: string,
    format: string,
  ): Array<{ name: string; steps: ParsedFlowStep[] }> {
    const flows: Array<{ name: string; steps: ParsedFlowStep[] }> = [];
    const stripped = format === "html" ? this.stripHTML(content) : content;

    // Find sections with numbered steps
    // Pattern: heading followed by numbered list
    const sectionRegex =
      /(?:^|\n)(?:#{1,3}\s+|<h[1-3][^>]*>)(.+?)(?:<\/h[1-3]>)?(?:\n|$)([\s\S]*?)(?=(?:\n(?:#{1,3}\s+|<h[1-3]))|$)/gi;

    let match;
    while ((match = sectionRegex.exec(stripped)) !== null) {
      const heading = match[1]!.replace(/<[^>]+>/g, "").trim();
      const body = match[2]!;

      // Check if the section has numbered steps
      const stepRegex = /(?:^|\n)\s*(?:(\d+)[.)]\s*|Step\s+\d+[:.]\s*)(.+)/gi;
      const steps: ParsedFlowStep[] = [];
      let stepMatch;

      while ((stepMatch = stepRegex.exec(body)) !== null) {
        const desc = stepMatch[2]!.trim();
        if (desc.length > 5) {
          steps.push({
            description: desc,
            tool: this.inferTool(desc),
            params: this.inferParams(desc),
          });
        }
      }

      if (steps.length >= 2) {
        flows.push({ name: heading, steps });
      }
    }

    return flows;
  }

  /**
   * Extract tips/best practices from the content.
   */
  private extractTips(content: string, format: string): string[] {
    const tips: string[] = [];
    const stripped = format === "html" ? this.stripHTML(content) : content;

    // Look for tip/note/important callouts
    const tipRegex =
      /(?:tip|note|important|best practice|pro tip|hint)[:\s]*(.+?)(?:\n|$)/gi;
    let match;

    while ((match = tipRegex.exec(stripped)) !== null) {
      const tip = match[1]!.trim();
      if (tip.length > 10 && tip.length < 500) {
        tips.push(tip);
      }
    }

    return tips.slice(0, 20); // Cap tips
  }

  /**
   * Infer the ScreenHand tool from a step description.
   */
  private inferTool(description: string): string | undefined {
    const lower = description.toLowerCase();

    if (lower.includes("click") && lower.includes("menu")) return "menu_click";
    if (lower.includes("click")) return "click_text";
    if (lower.includes("type") || lower.includes("enter")) return "type_text";
    if (lower.includes("press") || lower.includes("keyboard") || lower.includes("shortcut")) return "key";
    if (lower.includes("select")) return "click_text";
    if (lower.includes("drag")) return "drag";
    if (lower.includes("scroll")) return "scroll";
    if (lower.includes("navigate") || lower.includes("go to") || lower.includes("open")) return "menu_click";

    return undefined;
  }

  /**
   * Infer tool params from a step description.
   */
  private inferParams(description: string): Record<string, unknown> | undefined {
    // Extract quoted text as target
    const quoteMatch = description.match(/["'"](.+?)["'"]/);
    if (quoteMatch) {
      return { text: quoteMatch[1] };
    }

    // Extract menu path: File > Export > Media
    const menuMatch = description.match(
      /(?:click|go to|select|choose|open)\s+(.+?>.*)/i,
    );
    if (menuMatch) {
      const path = menuMatch[1]!
        .split(/\s*>\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (path.length >= 2) {
        return { menuPath: path.join("/") };
      }
    }

    return undefined;
  }

  private stripHTML(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}
