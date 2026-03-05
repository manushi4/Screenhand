# Discord Post — Friends of the Crustacean

**Channel:** #skills or #show-and-tell (whichever is most active)

---

**Title:** Native desktop control for OpenClaw — 50ms per click, zero extra AI calls

Hey everyone! I built **ScreenHand**, an open-source MCP server that gives your Claw native desktop control through OS accessibility APIs.

**The problem it solves:** Clawd Cursor sends a screenshot to an LLM every time it needs to click something. That works, but it's slow (~3-5s per action) and costs an API call per click. If you're automating a 20-step workflow, that's 20 screenshots + 20 LLM calls just for clicking.

**What ScreenHand does differently:** It reads the actual UI element tree through macOS Accessibility APIs (or Windows UI Automation). Instead of "look at this screenshot and figure out where Send is," it's just `press('Send')` — 50ms, exact, no AI call.

**Setup is 3 lines in your openclaw.json:**
```json
{
  "mcpServers": {
    "screenhand": {
      "command": "npx",
      "args": ["tsx", "/path/to/screenhand/src/mcp-entry.ts"]
    }
  }
}
```

Your Claw gets 16 tools: click elements by name/role, type into fields, read UI trees, launch/focus apps, keyboard shortcuts, menu clicks, drag & drop, scroll, screenshots, and more.

**Quick demo of what changes:**
- Before: screenshot -> LLM interprets -> "click at (523, 412)" -> hope it hits
- After: `press("Send")` -> done in 50ms

Works on macOS and Windows. MIT licensed.

GitHub: https://github.com/manushi4/screenhand
Full integration guide: [link to docs/openclaw-integration.md or blog post]

Happy to answer any questions! I saw someone asking about Mac mini screen access a couple weeks ago — this is exactly that use case.

---

*Note: Adjust tone/length based on the Discord community norms. Keep it helpful, not salesy.*
