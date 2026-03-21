/**
 * ScreenHand Twitter/X 2-Hour Campaign Runner
 *
 * Executes the engagement cadence from threads-campaign.md
 * Uses ScreenHand MCP tools via direct function calls
 *
 * Usage: tsx scripts/threads-campaign.ts
 * With cron/loop: keeps alive for 2 hours
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Campaign config
const CONFIG = {
  duration: 2 * 60 * 60 * 1000, // 2 hours in ms
  tabId: '', // filled at runtime
  searchQueries: [
    '"MCP server" -is:retweet',
    '"AI agent" automation -is:retweet',
    '"Claude Code" -is:retweet',
    '"desktop automation" -is:retweet',
    '"Selenium frustrating" OR "Playwright broken" -is:retweet',
    '"browser automation" -is:retweet',
    '"Figma to code" -is:retweet',
  ],
  tweets: [
    {
      time: 0,
      content: `AI agents can think, code, and reason.

But they can't click a button.

That's the gap ScreenHand fills — an MCP server giving any AI agent native desktop control on macOS + Windows.

No API keys. No cloud. No fixed scripts. Just real OS-level control. 82 tools. One protocol.`
    },
    {
      time: 20,
      content: `If your automation breaks when a button moves 10 pixels, you don't have automation. You have a time bomb.

ScreenHand doesn't rely on fixed selectors. It uses fallback chains:

Accessibility API → CDP → Vision → AppleScript

If one fails, it adapts. It also remembers what worked — gets faster every run.`
    },
    {
      time: 40,
      content: `The AI stack everyone's sleeping on:

Claude Code → thinks + codes
Figma MCP → design tokens
ScreenHand → opens the actual browser, verifies pixels, clicks deploy

What takes 45 min manually takes 3 min with this stack. The AI has a brain. ScreenHand gives it hands.`
    },
    {
      time: 60,
      content: `Every cloud automation tool has the same problem — your credentials pass through someone else's server.

ScreenHand runs locally. On your machine. No cloud relay. No API keys to leak. No third-party credential storage.

AGPL licensed. You own it completely.`
    },
    {
      time: 80,
      content: `Building AI agents? Here's what nobody tells you:

The hardest part isn't the reasoning. It's the last mile — actually executing actions in real software.

We built ScreenHand because we hit this wall ourselves. 82 MCP tools later, our agents can control any app on the desktop.

What are you building?`
    },
    {
      time: 100,
      content: `What ScreenHand can do in one MCP call:

- browser_human_click — clicks like a real human, anti-detection built in
- memory_recall — remembers patterns from previous runs
- execution_plan — plans multi-step workflows with fallback strategies
- export_playbook — saves learned flows for autonomous replay

Not scripts. Not recordings. Adaptive execution.`
    },
  ],
  replyTemplates: [
    `This is exactly why we built ScreenHand — the execution layer is the missing piece. Agents can reason but need OS-level control to do real work. We use accessibility APIs + CDP, not screenshots.`,
    `Interesting approach. One thing we've found — the fallback chain matters more than any single method. AX API fails? Try CDP. CDP fails? Try Vision. Resilience > precision.`,
    `Have you tried giving your agent actual desktop control? We built an MCP server (ScreenHand) that lets Claude/GPT control any app natively. Game changer for automation.`,
    `MCP is the right protocol for this. We built ScreenHand as an MCP server — 82 tools for desktop + browser automation. Any MCP client can drive it.`,
    `The composability of MCP is what makes it powerful. ScreenHand (desktop control) stacks with tools like yours naturally. Brain + hands.`,
    `Felt this. Selector-based automation is brittle. We switched to accessibility-tree-first with ScreenHand — the OS exposes UI elements semantically, not positionally.`,
    `The maintenance tax on Selenium scripts is brutal. We built fallback chains (AX → CDP → Vision → AppleScript) because no single method is reliable enough alone.`,
    `This is why we went API-free. No API keys = no rate limits, no platform approval needed. ScreenHand controls the actual UI like a human would.`,
    `Claude Code + ScreenHand is a wild combo. Claude thinks and codes, ScreenHand handles everything outside the IDE — browser testing, deployment UIs, verification.`,
    `Figma MCP gives you design tokens. But who verifies the implementation matches? ScreenHand opens the browser, screenshots the result, compares. Loop closed.`,
  ],
  // Rate limits
  maxLikesPerHour: 18,
  maxRepliesPerHour: 6,
  maxDmsPerHour: 2,
  maxTweetsPerHour: 3,
};

// Randomized delay (human-like)
function randomDelay(minSec: number, maxSec: number): number {
  return (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
}

// Campaign state
interface CampaignState {
  startTime: number;
  tweetsPosted: number;
  likesGiven: number;
  repliesSent: number;
  dmsSent: number;
  searchIndex: number;
  replyIndex: number;
  minutesElapsed: number;
}

function createInitialState(): CampaignState {
  return {
    startTime: Date.now(),
    tweetsPosted: 0,
    likesGiven: 0,
    repliesSent: 0,
    dmsSent: 0,
    searchIndex: 0,
    replyIndex: 0,
    minutesElapsed: 0,
  };
}

// Action schedule (minute -> action type)
interface ScheduledAction {
  minute: number;
  type: 'post' | 'like' | 'reply' | 'retweet' | 'dm' | 'search';
  tweetIndex?: number;
  count?: number;
  replyTemplate?: number;
}

const SCHEDULE: ScheduledAction[] = [
  { minute: 0, type: 'post', tweetIndex: 0 },
  { minute: 3, type: 'like', count: 3 },
  { minute: 8, type: 'reply', replyTemplate: 0 },
  { minute: 10, type: 'reply', replyTemplate: 3 },
  { minute: 15, type: 'like', count: 2 },
  { minute: 20, type: 'post', tweetIndex: 1 },
  { minute: 25, type: 'reply', replyTemplate: 5 },
  { minute: 27, type: 'reply', replyTemplate: 7 },
  { minute: 30, type: 'like', count: 3 },
  { minute: 35, type: 'reply', replyTemplate: 8 },
  { minute: 40, type: 'post', tweetIndex: 2 },
  { minute: 45, type: 'like', count: 3 },
  { minute: 50, type: 'reply', replyTemplate: 9 },
  { minute: 52, type: 'reply', replyTemplate: 1 },
  { minute: 55, type: 'search' },
  { minute: 60, type: 'post', tweetIndex: 3 },
  { minute: 65, type: 'like', count: 2 },
  { minute: 70, type: 'reply', replyTemplate: 2 },
  { minute: 72, type: 'reply', replyTemplate: 4 },
  { minute: 75, type: 'like', count: 3 },
  { minute: 80, type: 'post', tweetIndex: 4 },
  { minute: 85, type: 'reply', replyTemplate: 6 },
  { minute: 87, type: 'reply', replyTemplate: 1 },
  { minute: 90, type: 'search' },
  { minute: 95, type: 'like', count: 3 },
  { minute: 100, type: 'post', tweetIndex: 5 },
  { minute: 105, type: 'reply', replyTemplate: 3 },
  { minute: 107, type: 'reply', replyTemplate: 8 },
  { minute: 110, type: 'like', count: 2 },
  { minute: 115, type: 'like', count: 3 },
  { minute: 120, type: 'search' },
];

// Log action for tracking
function logAction(action: string, details: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${action}: ${details}`;
  console.log(line);
  // Append to campaign log
  const logPath = join(__dirname, '..', 'threads_campaign_log.txt');
  const { appendFileSync } = require('fs');
  appendFileSync(logPath, line + '\n');
}

// Main — this file is designed to be driven by ScreenHand MCP tools
// When run standalone, it outputs the schedule for the current minute
if (require.main === module) {
  const state = createInitialState();
  const elapsed = Math.floor((Date.now() - state.startTime) / 60000);

  // Find next actions
  const upcoming = SCHEDULE.filter(a => a.minute >= elapsed).slice(0, 3);

  console.log('=== ScreenHand Campaign Runner ===');
  console.log(`Started: ${new Date(state.startTime).toLocaleTimeString()}`);
  console.log(`Elapsed: ${elapsed} minutes`);
  console.log(`\nNext actions:`);

  for (const action of upcoming) {
    const inMinutes = action.minute - elapsed;
    let desc = '';
    switch (action.type) {
      case 'post':
        desc = `Post tweet #${(action.tweetIndex ?? 0) + 1}`;
        break;
      case 'like':
        desc = `Like ${action.count} relevant tweets`;
        break;
      case 'reply':
        desc = `Reply using template #${(action.replyTemplate ?? 0) + 1}`;
        break;
      case 'search':
        desc = `Search for new engagement targets`;
        break;
      case 'dm':
        desc = `Send warm DM`;
        break;
    }
    console.log(`  ${inMinutes === 0 ? 'NOW' : `in ${inMinutes}m`}: ${desc}`);
  }

  console.log(`\nTweet content for next post:`);
  const nextPost = upcoming.find(a => a.type === 'post');
  if (nextPost?.tweetIndex !== undefined) {
    console.log(CONFIG.tweets[nextPost.tweetIndex]?.content.substring(0, 200) + '...');
  }

  console.log(`\nReply template for next reply:`);
  const nextReply = upcoming.find(a => a.type === 'reply');
  if (nextReply?.replyTemplate !== undefined) {
    console.log(CONFIG.replyTemplates[nextReply.replyTemplate]?.substring(0, 200) + '...');
  }

  console.log('\n--- Campaign will be executed via ScreenHand MCP tools ---');
  console.log('Use /loop 5m to keep the campaign runner alive');
}

export { CONFIG, SCHEDULE, CampaignState, createInitialState, logAction, randomDelay };
