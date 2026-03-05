# MVP Architecture

## Design Goals
- Fast execution by keeping session and context persistent.
- Predictable completion by hard action budgets.
- No infinite loops: each tool call returns success or structured failure.
- LLM plans high-level intent; runtime handles micro-logic.

## Layers
1. `MCP Server Layer`
- Accepts tool requests (`session_start`, `navigate`, `press`, `type_into`, `wait_for`, `extract`, `screenshot`).
- Validates args and forwards to runtime service.

2. `Runtime Service Layer`
- Orchestrates session manager, executor, adapter, logging, and cache.
- Converts low-level errors into structured failure payloads.

3. `Executor Layer`
- Runs bounded state machine for action tools:
  - locate (cached first, fallback strategy)
  - act
  - verify
  - optional retry
- Enforces per-step time budgets.

4. `Browser Adapter Layer`
- Thin contract for browser operations.
- Current scaffold uses a placeholder adapter; later replace with CDP or Playwright robot-mode adapter.

## Core Runtime Flow
1. `session_start(profile)` ensures a persistent session ID.
2. `navigate(url)` completes within timeout and returns url/title.
3. `press` / `type_into` run bounded loop with max retries.
4. `wait_for(condition)` waits only for explicit UI conditions.
5. `extract(target, format)` returns structured data.
6. On failure, return structured diagnostics + timings.

## Key Data Contracts
- `ActionBudget`: `locateMs`, `actMs`, `verifyMs`, `maxRetries`.
- `ActionTelemetry`: per-action timing + retry count + status.
- `RuntimeError`: error code, attempts, page meta, and cause.

## Next Implementation Phase
- Harden the current CDP adapter with richer locator heuristics and cleanup hooks.
- Add locator strategy expansion (role/text/selector priority + fuzzy fallback).
- Persist locator cache per site/action.
- Wire transport for actual MCP protocol endpoint.
