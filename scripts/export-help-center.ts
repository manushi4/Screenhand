#!/usr/bin/env npx tsx

import { exportHelpCenterToMarkdown } from "../src/platform/help-center-markdown.js";

interface CliOptions {
  url?: string;
  output: string;
  scope?: string;
  maxPages: number;
  headless: boolean;
  waitMs: number;
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.url) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  const result = await exportHelpCenterToMarkdown({
    startUrl: options.url,
    outputPath: options.output,
    maxPages: options.maxPages,
    headless: options.headless,
    waitAfterLoadMs: options.waitMs,
    onProgress: (message) => console.log(message),
    ...(options.scope ? { scopePrefix: options.scope } : {}),
  });

  console.log("");
  console.log(`Wrote ${result.pageCount} page(s) to ${result.outputPath}`);
  console.log(`Scope prefix: ${result.scopePrefix}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    output: "help-center-export.md",
    maxPages: 25,
    headless: false,
    waitMs: 1200,
    help: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const next = args[index + 1];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--headless") {
      options.headless = true;
      continue;
    }

    if (arg === "--headed") {
      options.headless = false;
      continue;
    }

    if (arg === "--url" && next) {
      options.url = next;
      index++;
      continue;
    }

    if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
      continue;
    }

    if (arg === "--output" && next) {
      options.output = next;
      index++;
      continue;
    }

    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }

    if (arg === "--scope" && next) {
      options.scope = next;
      index++;
      continue;
    }

    if (arg.startsWith("--scope=")) {
      options.scope = arg.slice("--scope=".length);
      continue;
    }

    if (arg === "--max-pages" && next) {
      options.maxPages = parsePositiveInt(next, "--max-pages");
      index++;
      continue;
    }

    if (arg.startsWith("--max-pages=")) {
      options.maxPages = parsePositiveInt(arg.slice("--max-pages=".length), "--max-pages");
      continue;
    }

    if (arg === "--wait-ms" && next) {
      options.waitMs = parsePositiveInt(next, "--wait-ms");
      index++;
      continue;
    }

    if (arg.startsWith("--wait-ms=")) {
      options.waitMs = parsePositiveInt(arg.slice("--wait-ms=".length), "--wait-ms");
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value: string, flagName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function printUsage(): void {
  console.log("Usage:");
  console.log(
    "  npm run export:help-md -- --url <help-root-url> [--output file.md] [--scope /path/] [--max-pages 25] [--headless]",
  );
  console.log("");
  console.log("Examples:");
  console.log(
    "  npm run export:help-md -- --url https://www.canva.com/en_in/help/topics/ --output docs/canva-help.md --max-pages 40",
  );
  console.log(
    "  npm run export:help-md -- --url https://www.canva.com/en_in/help/topics/ --scope /en_in/help/ --headless",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
