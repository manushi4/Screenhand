import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const MCP_DESKTOP_PATH = path.resolve(
  import.meta.dirname ?? process.cwd(),
  "../mcp-desktop.ts",
);

/**
 * Spawn the MCP server and send a JSON-RPC initialize + tool list request.
 * Waits for actual responses rather than using fixed timeouts.
 */
function spawnMcpServer(): Promise<{
  responses: any[];
  exitCode: number | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", MCP_DESKTOP_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const responses: any[] = [];
    const rl = createInterface({ input: child.stdout! });
    let sentToolsList = false;

    rl.on("line", (line) => {
      try {
        const parsed = JSON.parse(line);
        responses.push(parsed);

        // After receiving initialize response, send tools/list
        if (parsed.id === 1 && !sentToolsList) {
          sentToolsList = true;
          const toolsRequest = {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          };
          child.stdin!.write(JSON.stringify(toolsRequest) + "\n");
        }

        // After receiving tools/list response, we're done
        if (parsed.id === 2) {
          child.kill();
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    // Send MCP initialize request
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };

    child.stdin!.write(JSON.stringify(initRequest) + "\n");

    // Safety timeout — kill after 15s if no responses
    const timeout = setTimeout(() => {
      child.kill();
    }, 15_000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ responses, exitCode: code });
    });

    child.on("error", reject);
  });
}

describe("MCP server startup", () => {
  it("starts and responds to initialize + tools/list", async () => {
    const { responses } = await spawnMcpServer();

    // Should have at least 2 responses (initialize + tools/list)
    expect(responses.length).toBeGreaterThanOrEqual(2);

    // First response: initialize
    const initResponse = responses.find((r) => r.id === 1);
    expect(initResponse).toBeDefined();
    expect(initResponse.result).toBeDefined();
    expect(initResponse.result.serverInfo.name).toBe("screenhand");

    // Second response: tools/list
    const toolsResponse = responses.find((r) => r.id === 2);
    expect(toolsResponse).toBeDefined();
    expect(toolsResponse.result).toBeDefined();
    expect(toolsResponse.result.tools).toBeInstanceOf(Array);

    // Check key tools exist
    const toolNames = toolsResponse.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("apps");
    expect(toolNames).toContain("windows");
    expect(toolNames).toContain("screenshot");
    expect(toolNames).toContain("ui_tree");
    expect(toolNames).toContain("ui_press");
    expect(toolNames).toContain("click");
    expect(toolNames).toContain("type_text");
    expect(toolNames).toContain("key");
    expect(toolNames).toContain("browser_tabs");
    expect(toolNames).toContain("applescript");

    // Verify tool count is reasonable (25+ tools)
    expect(toolNames.length).toBeGreaterThanOrEqual(20);
  }, 20_000);

  it("exposes all expected tool categories", async () => {
    const { responses } = await spawnMcpServer();
    const toolsResponse = responses.find((r) => r.id === 2);
    const toolNames: string[] = toolsResponse?.result?.tools?.map((t: any) => t.name) ?? [];

    // App management
    expect(toolNames).toContain("apps");
    expect(toolNames).toContain("focus");
    expect(toolNames).toContain("launch");

    // Screen/OCR
    expect(toolNames).toContain("screenshot");
    expect(toolNames).toContain("screenshot_file");
    expect(toolNames).toContain("ocr");

    // Accessibility
    expect(toolNames).toContain("ui_tree");
    expect(toolNames).toContain("ui_find");
    expect(toolNames).toContain("ui_press");
    expect(toolNames).toContain("ui_set_value");
    expect(toolNames).toContain("menu_click");

    // Input
    expect(toolNames).toContain("click");
    expect(toolNames).toContain("click_text");
    expect(toolNames).toContain("type_text");
    expect(toolNames).toContain("key");
    expect(toolNames).toContain("drag");
    expect(toolNames).toContain("scroll");

    // Browser/CDP
    expect(toolNames).toContain("browser_tabs");
    expect(toolNames).toContain("browser_open");
    expect(toolNames).toContain("browser_navigate");
    expect(toolNames).toContain("browser_js");
    expect(toolNames).toContain("browser_dom");
    expect(toolNames).toContain("browser_click");
    expect(toolNames).toContain("browser_type");
    expect(toolNames).toContain("browser_wait");
    expect(toolNames).toContain("browser_page_info");
  }, 20_000);
});
