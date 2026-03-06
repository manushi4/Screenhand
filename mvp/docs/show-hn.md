# Show HN Draft

## Title options

- Show HN: ScreenHand, native desktop control for MCP agents in ~50ms
- Show HN: ScreenHand, open-source desktop automation for Claude, Cursor, and Codex
- Show HN: ScreenHand, an MCP server that clicks real UI elements instead of guessing coordinates

## Post draft

I built **ScreenHand**, an open-source MCP server for desktop automation on macOS and Windows.

The main idea is simple: most "computer use" systems take a screenshot, send it to an LLM, then guess where to click. ScreenHand uses native Accessibility APIs / Windows UI Automation instead, so actions like clicking a button or typing into a field happen in about **50ms** and target the real UI element, not guessed coordinates.

What it does:

- Native desktop control for apps and menus
- OCR and screenshots when visual context is useful
- Chrome CDP automation for browser workflows
- Works with Claude Desktop, Claude Code, Cursor, Codex CLI, OpenClaw, and other MCP clients

Current setup is source-first because the native bridge is built locally:

```bash
git clone https://github.com/manushi4/screenhand.git
cd screenhand
npm install
npm run build:native
```

If you're building agent workflows, I'm especially interested in feedback on:

- What actions are still missing for real desktop automation
- Which MCP clients should get first-class setup guides
- Whether the Accessibility-first approach feels meaningfully better than screenshot-driven control

GitHub: https://github.com/manushi4/screenhand
