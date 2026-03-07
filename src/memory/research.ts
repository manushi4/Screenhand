// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.
//
// ScreenHand is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, version 3.
//
// ScreenHand is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with ScreenHand. If not, see <https://www.gnu.org/licenses/>.

/**
 * Background web research — fire-and-forget resolution lookup.
 *
 * When a tool fails and no resolution exists, this searches for a fix
 * in the background (non-blocking) and saves it for next time.
 *
 * Resolution paths:
 * 1. Claude API (haiku) — if ANTHROPIC_API_KEY is set
 * 2. DuckDuckGo instant answer — free fallback, no auth
 */

import type { MemoryStore } from "./store.js";

export function backgroundResearch(
  store: MemoryStore,
  tool: string,
  params: Record<string, unknown>,
  errorMessage: string,
): void {
  // Fire-and-forget — never blocks, never throws
  doResearch(store, tool, params, errorMessage).catch(() => {});
}

async function doResearch(
  store: MemoryStore,
  tool: string,
  params: Record<string, unknown>,
  errorMessage: string,
): Promise<void> {
  const query = `macOS automation: "${tool}" failed with "${errorMessage.slice(0, 200)}"`;

  let resolution: string | null = null;

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey) {
    resolution = await tryClaudeAPI(apiKey, query);
  }

  if (!resolution) {
    resolution = await tryDuckDuckGo(query);
  }

  if (!resolution) return;

  // Save resolution to error cache
  store.appendError({
    id: "err_research_" + Date.now().toString(36),
    tool,
    params,
    error: errorMessage,
    resolution,
    occurrences: 1,
    lastSeen: new Date().toISOString(),
  });

  // Save as a reusable strategy
  store.appendStrategy({
    id: "str_research_" + Date.now().toString(36),
    task: `Fix: ${tool} — ${errorMessage.slice(0, 100)}`,
    steps: [{ tool, params }],
    totalDurationMs: 0,
    successCount: 1,
    failCount: 0,
    lastUsed: new Date().toISOString(),
    tags: [tool, "research", "fix"],
    fingerprint: "",
  });
}

async function tryClaudeAPI(apiKey: string, query: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `You are a macOS automation expert. Give a brief fix (1-2 sentences) for this error:\n\n${query}`,
        }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.text;
    return text && text.length > 10 ? text.trim() : null;
  } catch {
    return null;
  }
}

async function tryDuckDuckGo(query: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
    const response = await fetch(url, { signal: controller.signal });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as {
      AbstractText?: string;
      Abstract?: string;
      Answer?: string;
    };
    const text = data.AbstractText || data.Abstract || data.Answer;
    return text && text.length > 10 ? text.trim() : null;
  } catch {
    return null;
  }
}
