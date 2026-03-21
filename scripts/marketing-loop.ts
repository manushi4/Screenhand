#!/usr/bin/env npx tsx
/**
 * ScreenHand Marketing Automation Loop
 *
 * Architecture:
 *   Claude Code (this script via /loop)
 *     → ScreenHand CDP → Codex (content generation)
 *     → ScreenHand browser → Social platforms (execution)
 *
 * Platforms: X/Twitter, Threads, LinkedIn, Reddit
 * Goal: Increase GitHub stars for ScreenHand (github.com/manushi4/Screenhand)
 */

// Marketing task types with weights for rotation
const TASK_TYPES = [
  { type: 'search_engage', weight: 30, platforms: ['x', 'threads', 'linkedin'] },
  { type: 'create_post', weight: 20, platforms: ['x', 'threads', 'linkedin'] },
  { type: 'reply_contextual', weight: 25, platforms: ['x', 'threads', 'reddit'] },
  { type: 'like_repost', weight: 15, platforms: ['x', 'threads'] },
  { type: 'dm_outreach', weight: 10, platforms: ['x', 'linkedin'] },
] as const;

// Search queries to find relevant conversations
const SEARCH_QUERIES = [
  'claude code',
  'desktop automation AI',
  'MCP server',
  'browser automation agent',
  'AI agent desktop control',
  'anthropic claude tools',
  'cursor automation',
  'computer use API',
  'accessibility automation mac',
  'screenhand',
  'AI coding assistant',
  'claude MCP',
  'openai codex desktop',
  'AI agent framework',
  'playwright alternative AI',
];

// Content angles for posts
const CONTENT_ANGLES = [
  'Show how ScreenHand gives AI agents native desktop control — 82 MCP tools',
  'Demo: Claude Code using ScreenHand to automate a real workflow',
  'ScreenHand vs browser-only automation — why desktop control matters',
  'Open source AI desktop automation — ScreenHand on npm',
  'How ScreenHand handles the focus-stealing problem in Electron apps',
  'Building multi-agent systems with ScreenHand supervisor + job system',
  'ScreenHand memory system — AI agents that learn from mistakes',
  'Cross-platform desktop automation: macOS Swift + Windows C# native bridges',
  'The playbook system — reusable automation recipes for any platform',
  'Why we built ScreenHand: the gap between AI coding and AI doing',
];

// Rate limits per platform (actions per hour)
const RATE_LIMITS: Record<string, number> = {
  x: 8,
  threads: 10,
  linkedin: 6,
  reddit: 4,
};

// State tracking
interface MarketingState {
  startTime: number;
  actionsPerformed: Record<string, number>;
  lastActionTime: Record<string, number>;
  postsCreated: string[];
  repliesSent: string[];
  searchesPerformed: string[];
  errors: string[];
  currentCycle: number;
}

const state: MarketingState = {
  startTime: Date.now(),
  actionsPerformed: { x: 0, threads: 0, linkedin: 0, reddit: 0 },
  lastActionTime: { x: 0, threads: 0, linkedin: 0, reddit: 0 },
  postsCreated: [],
  repliesSent: [],
  searchesPerformed: [],
  errors: [],
  currentCycle: 0,
};

function pickWeightedRandom<T extends { weight: number }>(items: readonly T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[0]!;
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function canActOnPlatform(platform: string): boolean {
  const hourMs = 60 * 60 * 1000;
  const now = Date.now();
  const limit = RATE_LIMITS[platform] ?? 5;
  const count = state.actionsPerformed[platform] ?? 0;
  const elapsed = now - state.startTime;
  const hoursElapsed = Math.max(1, elapsed / hourMs);
  return count / hoursElapsed < limit;
}

function getNextTask(): { type: string; platform: string; query?: string; angle?: string } {
  state.currentCycle++;

  // Pick task type
  const task = pickWeightedRandom(TASK_TYPES);

  // Pick platform that hasn't hit rate limit
  const availablePlatforms = task.platforms.filter(p => canActOnPlatform(p));
  if (availablePlatforms.length === 0) {
    return { type: 'wait', platform: 'none' };
  }
  const platform = pickRandom(availablePlatforms);

  return {
    type: task.type,
    platform,
    query: pickRandom(SEARCH_QUERIES),
    angle: pickRandom(CONTENT_ANGLES),
  };
}

function formatStatus(): string {
  const elapsed = Math.round((Date.now() - state.startTime) / 60000);
  const total = Object.values(state.actionsPerformed).reduce((s, n) => s + n, 0);
  return `[Cycle ${state.currentCycle} | ${elapsed}m elapsed | ${total} actions | ` +
    `X:${state.actionsPerformed.x} T:${state.actionsPerformed.threads} ` +
    `L:${state.actionsPerformed.linkedin} R:${state.actionsPerformed.reddit} | ` +
    `${state.errors.length} errors]`;
}

// Export for use by the loop controller
export { getNextTask, formatStatus, state, SEARCH_QUERIES, CONTENT_ANGLES, canActOnPlatform };
