#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";

const DEFAULT_TIMEOUT = 300000; // 5 minutes

const tools: Tool[] = [
  {
    name: "list",
    description: "List available recipes in the justfile",
    inputSchema: {
      type: "object" as const,
      properties: {
        working_directory: {
          type: "string",
          description: "Directory containing the justfile",
        },
        justfile: {
          type: "string",
          description: "Path to the justfile (optional)",
        },
      },
    },
  },
  {
    name: "run",
    description: "Run a recipe from the justfile",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipe: {
          type: "string",
          description: "Recipe name to run",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments to pass to the recipe",
        },
        working_directory: {
          type: "string",
          description: "Directory containing the justfile",
        },
        justfile: {
          type: "string",
          description: "Path to the justfile (optional)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 300000)",
        },
      },
      required: ["recipe"],
    },
  },
  {
    name: "show",
    description: "Show the definition of a recipe",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipe: {
          type: "string",
          description: "Recipe name to show",
        },
        working_directory: {
          type: "string",
          description: "Directory containing the justfile",
        },
        justfile: {
          type: "string",
          description: "Path to the justfile (optional)",
        },
      },
      required: ["recipe"],
    },
  },
];

function validateRecipeName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Recipe name must be a non-empty string");
  }
  if (name.startsWith("-")) {
    throw new Error("Recipe name cannot start with '-'");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Recipe name contains invalid characters");
  }
  return name;
}

function getBaseArgs(justfile?: string): string[] {
  const args = ["--color=never"];
  if (justfile && typeof justfile === "string") {
    args.push("--justfile", justfile);
  }
  return args;
}

async function execJust(
  args: string[],
  workingDirectory?: string,
  timeout: number = DEFAULT_TIMEOUT
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("just", args, {
      cwd: workingDirectory || process.cwd(),
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ stdout, stderr: stderr + "\n[Process timed out]", exitCode: 124 });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, exitCode: 1 });
    });
  });
}

async function handleTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const workingDir = typeof args.working_directory === "string" ? args.working_directory : undefined;
  const justfile = typeof args.justfile === "string" ? args.justfile : undefined;
  const baseArgs = getBaseArgs(justfile);

  switch (name) {
    case "list": {
      const result = await execJust([...baseArgs, "--list"], workingDir);
      return formatResult(result);
    }
    case "run": {
      const recipe = validateRecipeName(args.recipe);
      const timeout = typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT;
      const justArgs = [...baseArgs, recipe];
      if (Array.isArray(args.args)) {
        justArgs.push(...args.args.filter((a): a is string => typeof a === "string"));
      }
      const result = await execJust(justArgs, workingDir, timeout);
      return formatResult(result);
    }
    case "show": {
      const recipe = validateRecipeName(args.recipe);
      const result = await execJust([...baseArgs, "--show", recipe], workingDir);
      return formatResult(result);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function formatResult(result: { stdout: string; stderr: string; exitCode: number }): string {
  let output = result.stdout;
  if (result.stderr) output += (output ? "\n" : "") + result.stderr;
  if (result.exitCode !== 0) output += `\n[Exit code: ${result.exitCode}]`;
  return output || "Command completed successfully";
}

const server = new Server(
  { name: "just-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args as Record<string, unknown>);
    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("just-mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
