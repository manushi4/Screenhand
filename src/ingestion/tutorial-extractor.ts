// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import type { ParsedFlowStep } from "./types.js";

/** A single transcript segment from a video. */
export interface TranscriptSegment {
  text: string;
  startTime: number;
  duration: number;
}

/** Result of extracting a tutorial from a transcript. */
export interface TutorialExtractResult {
  title: string;
  platform: string;
  steps: ParsedFlowStep[];
  rawSegments: number;
  actionSegments: number;
  extractedAt: string;
}

// Patterns that indicate an action step in a tutorial
const ACTION_PATTERNS = [
  /\b(?:click|tap|press|hit)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button|\s+tab|\s+menu|\s+icon)?(?:\.|,|$)/i,
  /\b(?:go to|navigate to|open|switch to)\s+(.+?)(?:\.|,|$)/i,
  /\b(?:select|choose|pick)\s+(.+?)(?:\.|,|$)/i,
  /\b(?:type|enter|input|write)\s+(.+?)(?:\.|,|$)/i,
  /\b(?:drag|move)\s+(.+?)\s+to\s+(.+?)(?:\.|,|$)/i,
  /\b(?:right[- ]?click|double[- ]?click)\s+(?:on\s+)?(.+?)(?:\.|,|$)/i,
  /\bpress\s+((?:cmd|ctrl|alt|shift|command|control|option)[+\s].+?)(?:\.|,|$)/i,
  /\b(?:scroll|zoom)\s+(.+?)(?:\.|,|$)/i,
  /\b(?:set|change|adjust)\s+(.+?)\s+to\s+(.+?)(?:\.|,|$)/i,
];

// Words that indicate non-action segments (skip these)
const SKIP_PATTERNS = [
  /\bhey guys\b/i,
  /\bsubscribe\b/i,
  /\blike (?:this|the) video\b/i,
  /\bcomment below\b/i,
  /\bsponsor/i,
  /\bwhat's up\b/i,
  /\bhello everyone\b/i,
  /\bwelcome (?:back|to)\b/i,
  /\blet me know\b/i,
  /\bcheck out\b/i,
  /\blink in (?:the )?description\b/i,
];

/**
 * TutorialExtractor — extracts structured playbook steps from video
 * transcripts (typically YouTube captions/subtitles).
 */
export class TutorialExtractor {
  /**
   * Extract action steps from a transcript.
   */
  extract(
    segments: TranscriptSegment[],
    title: string,
    platform: string,
  ): TutorialExtractResult {
    const steps: ParsedFlowStep[] = [];

    for (const segment of segments) {
      // Skip filler/promo segments
      if (SKIP_PATTERNS.some((p) => p.test(segment.text))) continue;

      const parsedSteps = this.parseSegment(segment.text);
      for (const step of parsedSteps) {
        // Deduplicate consecutive identical steps
        const last = steps[steps.length - 1];
        if (last && last.description === step.description) continue;
        steps.push(step);
      }
    }

    return {
      title,
      platform,
      steps,
      rawSegments: segments.length,
      actionSegments: steps.length,
      extractedAt: new Date().toISOString(),
    };
  }

  /**
   * Convert extracted steps to a playbook-ready format.
   */
  toPlaybookSteps(
    result: TutorialExtractResult,
  ): Array<{
    action: string;
    tool: string;
    params: Record<string, unknown>;
    description: string;
    postcondition?: string | undefined;
  }> {
    return result.steps
      .filter((s) => s.tool)
      .map((step) => ({
        action: step.tool === "key" ? "press" : step.tool === "type_text" ? "type" : "click",
        tool: step.tool!,
        params: step.params ?? {},
        description: step.description,
        postcondition: step.postcondition,
      }));
  }

  /**
   * Parse a single transcript segment for action steps.
   */
  private parseSegment(text: string): ParsedFlowStep[] {
    const steps: ParsedFlowStep[] = [];

    // Split on sentence boundaries
    const sentences = text.split(/(?<=[.!?])\s+|(?:,\s+(?:then|and then|next|after that)\s+)/i);

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed.length < 5) continue;

      for (const pattern of ACTION_PATTERNS) {
        const match = trimmed.match(pattern);
        if (match) {
          const step = this.mapToStep(trimmed, match);
          if (step) {
            steps.push(step);
            break; // Only take first matching pattern per sentence
          }
        }
      }
    }

    return steps;
  }

  /**
   * Map a matched action to a ParsedFlowStep with tool and params.
   */
  private mapToStep(
    fullText: string,
    match: RegExpMatchArray,
  ): ParsedFlowStep | null {
    const lower = fullText.toLowerCase();
    const target = match[1]?.trim();

    if (!target || target.length < 2) return null;

    // Determine tool and params
    if (lower.includes("type") || lower.includes("enter") || lower.includes("input")) {
      return {
        description: fullText,
        tool: "type_text",
        params: { text: target },
      };
    }

    if (lower.includes("press") && /(?:cmd|ctrl|alt|shift|command|control|option)/i.test(target)) {
      return {
        description: fullText,
        tool: "key",
        params: { combo: this.normalizeShortcut(target) },
      };
    }

    if (lower.includes("drag") || lower.includes("move")) {
      return {
        description: fullText,
        tool: "click_text",
        params: { text: target },
      };
    }

    if (lower.includes("scroll") || lower.includes("zoom")) {
      return {
        description: fullText,
        tool: "scroll",
        params: { direction: lower.includes("down") ? "down" : lower.includes("up") ? "up" : "down" },
      };
    }

    if (lower.includes("menu") || target.includes(">")) {
      const pathParts = target
        .split(/\s*>\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (pathParts.length >= 2) {
        return {
          description: fullText,
          tool: "menu_click",
          params: { menuPath: pathParts.join("/") },
        };
      }
    }

    if (lower.includes("set") || lower.includes("change") || lower.includes("adjust")) {
      return {
        description: fullText,
        tool: "click_text",
        params: { text: target },
      };
    }

    // Default: click on the target
    return {
      description: fullText,
      tool: "click_text",
      params: { text: target },
    };
  }

  private normalizeShortcut(keys: string): string {
    return keys
      .replace(/Command/gi, "Cmd")
      .replace(/Control/gi, "Ctrl")
      .replace(/\s+/g, "+")
      .trim();
  }
}
