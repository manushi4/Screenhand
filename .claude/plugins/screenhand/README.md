# ScreenHand — Claude Code Plugin

Desktop and browser automation for Claude Code. Control any macOS/Windows app, automate social media, run QA tests, edit video in DaVinci Resolve, design in Figma/Canva, scrape the web, and orchestrate multi-agent parallel workflows.

**111 MCP tools** wrapped in 13 intent-oriented skills and 5 specialized agents.

## Quick Start

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand
npm install && npm run build:native
./install-plugin.sh
```

The install script copies the plugin to `~/.claude/plugins/screenhand/`, configures the MCP server path, and creates `~/.screenhand/` for logs and state. Restart Claude Code after installing.

For browser automation, launch Chrome with remote debugging:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

> **Development mode**: Load the plugin directly instead of installing:
> ```bash
> claude --plugin-dir /path/to/screenhand/.claude/plugins/screenhand
> ```

## Skills

| Skill | Command | What it does |
|-------|---------|-------------|
| **Automate App** | `/screenhand:automate-app` | Control any desktop app — click, type, navigate menus |
| **Post Social** | `/screenhand:post-social` | Post to X, LinkedIn, Instagram, Reddit, Threads, Discord |
| **Run Campaign** | `/screenhand:run-campaign` | Multi-platform marketing campaigns (parallel or sequential) |
| **Edit Video** | `/screenhand:edit-video` | DaVinci Resolve — color grade, edit timeline, render |
| **Design Figma** | `/screenhand:design-figma` | Create/edit Figma designs via Plugin API + browser |
| **Edit Canva** | `/screenhand:edit-canva` | Edit Canva templates, add elements, download |
| **Scrape Web** | `/screenhand:scrape-web` | Extract data from any website with anti-detection |
| **Fill Form** | `/screenhand:fill-form` | Fill web forms with human-like typing |
| **QA Smoke Test** | `/screenhand:qa-smoke-test` | Automated UI testing, accessibility audits |
| **Record Workflow** | `/screenhand:record-workflow` | Record actions into reusable playbooks |
| **Learn Platform** | `/screenhand:learn-platform` | Discover how to automate a new app/site |
| **Run Jobs** | `/screenhand:run-jobs` | Manage job queues, background workers, orchestrator |
| **Manage System** | `/screenhand:manage-system` | Supervisor, memory health, session diagnostics |

## Agents

| Agent | Specialty |
|-------|-----------|
| **marketing-agent** | Social media campaigns, content adaptation, rate limit management |
| **design-agent** | Figma, Canva, DaVinci Resolve automation |
| **qa-agent** | Test planning, UI validation, accessibility audits |
| **scraper-agent** | Web data extraction, pagination, structured output |
| **orchestrator-agent** | Parallel task decomposition, worker slot management |

## Platform Support

Pre-built references (curated selectors, flows, error handling) for:

| Category | Platforms |
|----------|-----------|
| Social | X/Twitter, LinkedIn, Instagram, Reddit, Threads, YouTube, Discord |
| Design | Figma, Canva |
| Video | DaVinci Resolve (full menu map + keyboard shortcuts) |
| Dev | n8n, Dev.to, Devpost, Codex Desktop |
| Google | Google Flow (8 workflow variants) |

Use `/screenhand:learn-platform` to add support for any new app or website.

## Intelligence Wrapper

Every tool call through ScreenHand goes through an automatic intelligence pipeline:
- **Pre-call**: Warns about known errors, injects selector hints from reference files, suggests strategies from past successes
- **Post-call**: Records outcomes, learns which selectors work, captures tool calls for playbook recording

Watch for `[HINT]`, `[WARNING]`, and `[STRATEGY]` lines in tool responses — they contain actionable guidance from curated references and verified learnings.

## Electron App Support (cdpPort)

All `browser_*` tools accept an optional `cdpPort` parameter for controlling Electron apps:
- Chrome: auto-detected on ports 9222-9224
- Codex Desktop: port 9333 (reference: `codex-desktop`)
- Custom Electron apps: pass `cdpPort` explicitly

## Examples

```
# Desktop automation
"Open Xcode and click the Run button"
"Navigate to File > New > Project in Xcode"

# Social media
/screenhand:post-social Post this announcement to Twitter: "We just launched v2.0!"
/screenhand:run-campaign Share across Twitter, LinkedIn, and Threads: "Big update coming"

# Design
/screenhand:design-figma Create a 1440x900 frame with a header component
/screenhand:edit-video Color grade the current timeline in DaVinci Resolve

# QA
/screenhand:qa-smoke-test Test the login flow on https://myapp.com
"Check if all buttons are clickable on the homepage"

# Data extraction
/screenhand:scrape-web Extract all product names and prices from https://store.example.com
"Get all article titles from Hacker News"

# Workflow automation
/screenhand:record-workflow Record the steps to send a Slack message
/screenhand:run-jobs Start a background worker to process all queued tasks
```

## Safety

Skills with real-world side effects require explicit invocation (won't auto-trigger):
- `/screenhand:post-social` — posts real content
- `/screenhand:run-campaign` — multi-platform posting
- `/screenhand:edit-video` — modifies DaVinci projects
- `/screenhand:fill-form` — submits forms
- `/screenhand:run-jobs` — runs background processes
- `/screenhand:record-workflow` — starts recording sessions
- `/screenhand:manage-system` — starts/stops daemons, clears memory

## Troubleshooting

| Issue | Solution |
|-------|---------|
| Browser tools fail | Launch Chrome with `--remote-debugging-port=9222` |
| Native tools fail | Run `npm run build:native` to build the accessibility bridge |
| MCP server not found | Update path in `.mcp.json` to your ScreenHand installation |
| Skills not appearing | Run `/reload-plugins` in Claude Code |
| CAPTCHA detected | Solve manually, then continue — ScreenHand never bypasses CAPTCHAs |
| Rate limited | Wait 15 min, reduce posting frequency |

## License

AGPL-3.0-only — Copyright (C) 2025-2026 Clazro Technology Private Limited
