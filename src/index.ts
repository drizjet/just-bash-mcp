import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Bash, OverlayFs } from "just-bash";
import { resolve as pathResolve, normalize, sep } from "node:path";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";

const PROJECT_ROOT = normalize(
  process.env.JUST_BASH_PROJECT_ROOT ?? process.cwd()
);

const NETWORK_ALLOW = (process.env.JUST_BASH_NETWORK_ALLOW ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_DURATION_MS = Number(
  process.env.JUST_BASH_MAX_DURATION_MS ?? 30_000
);

const MAX_OUTPUT_BYTES = Number(
  process.env.JUST_BASH_MAX_OUTPUT_BYTES ?? 1024 * 1024
);

const sandbox = {
  bash: null as Bash | null,
  overlay: null as OverlayFs | null,
  createdAt: 0,
  execCount: 0,
  lastScript: null as string | null,
};

async function getBash(): Promise<Bash> {
  if (sandbox.bash) return sandbox.bash;
  const overlay = new OverlayFs({ root: PROJECT_ROOT });
  const bash = new Bash({
    fs: overlay,
    cwd: "/home/user/project",
    executionLimits: {
      maxCallDepth: 100,
      maxCommandCount: 10_000,
      maxLoopIterations: 10_000,
      maxAwkIterations: 10_000,
      maxSedIterations: 10_000,
    },
    network:
      NETWORK_ALLOW.length > 0
        ? {
            allowedUrlPrefixes: NETWORK_ALLOW,
            allowedMethods: ["GET", "HEAD"],
          }
        : undefined,
  });
  sandbox.bash = bash;
  sandbox.overlay = overlay;
  sandbox.createdAt = Date.now();
  sandbox.execCount = 0;
  return bash;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return (
    s.slice(0, max) +
    `\n\n[... truncated ${s.length - max} bytes; set JUST_BASH_MAX_OUTPUT_BYTES to raise ...]\n`
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const FAF_BIN = process.env.FAF_BIN ?? "faf";
const FAF_MOLTBOT_BIN = process.env.FAF_MOLTBOT_BIN ?? "faf-moltbot";

interface HostCmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runHostCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<HostCmdResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn("cmd.exe", ["/d", "/s", "/c", [command, ...args].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(command, args, {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 12_500),
        exitCode: timedOut ? 124 : (code ?? 1),
      });
    });
    child.on("error", (err) => {
      clearTimeout(t);
      resolve({
        stdout: "",
        stderr: `spawn error: ${err.message}`,
        exitCode: 1,
      });
    });
  });
}

function resolveFafProject(arg: unknown): string {
  const p = typeof arg === "string" && arg.length > 0 ? arg : PROJECT_ROOT;
  return normalize(p);
}

function formatFafResult(
  label: string,
  project: string,
  result: HostCmdResult
): { content: { type: "text"; text: string }[]; isError: boolean } {
  const out = [
    `=== ${label} (${project}) ===`,
    result.stdout,
    result.stderr ? `=== STDERR ===\n${result.stderr}` : "",
    `=== EXIT ${result.exitCode} ===`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    content: [{ type: "text", text: out }],
    isError: result.exitCode !== 0,
  };
}

const server = new Server(
  {
    name: "just-bash-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bash_exec",
      description:
        "Execute a bash script in a sandboxed virtual filesystem mounted at the project root. " +
        "Writes go to an in-memory overlay and do NOT touch the real filesystem unless committed. " +
        "Network is disabled unless JUST_BASH_NETWORK_ALLOW is set. " +
        "Supports: cat/cp/ls/find/grep/awk/sed/sort/uniq/jq/sqlite3/xan/yq/tar/tee, " +
        "optional python3 (CPython WASM) and js-exec (QuickJS) runtimes.",
      inputSchema: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "Bash script to execute",
          },
          timeout: {
            type: "number",
            description: `Timeout in ms (max ${MAX_DURATION_MS})`,
            default: 10_000,
          },
        },
        required: ["script"],
      },
    },
    {
      name: "sandbox_status",
      description:
        "Show the current sandbox state: project root, age, exec count, last script, network policy.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "sandbox_reset",
      description:
        "Discard the current sandbox (drops all in-memory writes) and create a fresh one. " +
        "Use this when you want to start over from the real project state.",
      inputSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "Must be true to confirm destruction of in-memory writes",
            default: false,
          },
        },
        required: ["confirm"],
      },
    },
    {
      name: "realpath",
      description:
        "Resolve a sandbox path to its real filesystem path (for reading or committing).",
      inputSchema: {
        type: "object",
        properties: {
          sandboxPath: {
            type: "string",
            description: "Path inside the sandbox, e.g. /home/user/project/src/foo.ts",
          },
        },
        required: ["sandboxPath"],
      },
    },
    {
      name: "path_exists",
      description: "Check if a path exists in the sandbox (overlay + real fs).",
      inputSchema: {
        type: "object",
        properties: {
          sandboxPath: {
            type: "string",
            description: "Path inside the sandbox",
          },
        },
        required: ["sandboxPath"],
      },
    },
    {
      name: "faf_migrate",
      description:
        "Run `faf migrate` on a project directory to upgrade project.faf to the latest schema version. " +
        "Operates on the REAL filesystem (bypasses the bash sandbox). Modifies project.faf in place.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Absolute path to project directory (defaults to JUST_BASH_PROJECT_ROOT)",
          },
        },
      },
    },
    {
      name: "faf_sync",
      description:
        "Run `faf sync` on a project directory to regenerate CLAUDE.md and other agent docs from project.faf. " +
        "Operates on the REAL filesystem. May overwrite faf-generated AGENTS.md (use a custom AGENTS.md to keep your own).",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Absolute path to project directory (defaults to JUST_BASH_PROJECT_ROOT)",
          },
        },
      },
    },
    {
      name: "faf_score",
      description:
        "Run `faf score` on a project directory to get a quality report (slot fill %, color). " +
        "Read-only. Operates on the REAL filesystem.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Absolute path to project directory (defaults to JUST_BASH_PROJECT_ROOT)",
          },
        },
      },
    },
    {
      name: "faf_moltbot_sync",
      description:
        "Run `faf-moltbot sync` on a project directory to generate SOUL.md with persona + constraints inline. " +
        "Operates on the REAL filesystem. Overwrites SOUL.md in the project root.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Absolute path to project directory (defaults to JUST_BASH_PROJECT_ROOT)",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "bash_exec": {
      const script = String((args as { script: string }).script ?? "");
      const timeout = Math.min(
        Number((args as { timeout?: number }).timeout ?? 10_000),
        MAX_DURATION_MS
      );
      if (!script.trim()) {
        return {
          content: [
            { type: "text", text: "Error: empty script" },
          ],
          isError: true,
        };
      }
      const bash = await getBash();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeout);
      try {
        const result = await bash.exec(script, {
          signal: controller.signal,
        });
        sandbox.execCount += 1;
        sandbox.lastScript = script.slice(0, 200);
        const stdout = truncate(result.stdout, MAX_OUTPUT_BYTES);
        const stderr = truncate(result.stderr, MAX_OUTPUT_BYTES / 4);
        const out = [
          `=== STDOUT ===\n${stdout}`,
          stderr ? `=== STDERR ===\n${stderr}` : "",
          `=== EXIT ${result.exitCode} ===`,
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [{ type: "text", text: out }],
          isError: result.exitCode !== 0,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${truncate(msg, MAX_OUTPUT_BYTES / 4)}`,
            },
          ],
          isError: true,
        };
      } finally {
        clearTimeout(t);
      }
    }

    case "sandbox_status": {
      const overlayRoot = sandbox.overlay
        ? (sandbox.overlay as unknown as { root: string }).root
        : "(not initialized)";
      const lines = [
        `Project root:    ${PROJECT_ROOT}`,
        `Overlay root:    ${overlayRoot}`,
        `Sandbox cwd:     /home/user/project`,
        `Age:             ${sandbox.bash ? Math.round((Date.now() - sandbox.createdAt) / 1000) + "s" : "n/a"}`,
        `Executions:      ${sandbox.execCount}`,
        `Last script:     ${sandbox.lastScript ?? "(none)"}`,
        `Network policy:  ${NETWORK_ALLOW.length > 0 ? NETWORK_ALLOW.join(", ") : "DISABLED"}`,
        `Max duration:    ${MAX_DURATION_MS}ms`,
        `Max output:      ${MAX_OUTPUT_BYTES} bytes`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }

    case "sandbox_reset": {
      const confirm = Boolean(
        (args as { confirm?: boolean }).confirm ?? false
      );
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: "Error: pass confirm: true to discard the current sandbox (destroys in-memory writes)",
            },
          ],
          isError: true,
        };
      }
      sandbox.bash = null;
      sandbox.overlay = null;
      sandbox.execCount = 0;
      sandbox.lastScript = null;
      return {
        content: [
          { type: "text", text: "Sandbox reset. Next call will re-mount project root." },
        ],
      };
    }

    case "realpath": {
      const sandboxPath = String(
        (args as { sandboxPath: string }).sandboxPath ?? ""
      );
      const root = "/home/user/project";
      if (!sandboxPath.startsWith(root)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: path must start with ${root} (got: ${sandboxPath})`,
            },
          ],
          isError: true,
        };
      }
      const rel = sandboxPath.slice(root.length).replace(/^\/+/, "");
      const real = pathResolve(PROJECT_ROOT, rel);
      return {
        content: [{ type: "text", text: real }],
      };
    }

    case "path_exists": {
      const sandboxPath = String(
        (args as { sandboxPath: string }).sandboxPath ?? ""
      );
      const root = "/home/user/project";
      if (!sandboxPath.startsWith(root)) {
        return {
          content: [
            { type: "text", text: `Error: path must start with ${root}` },
          ],
          isError: true,
        };
      }
      const rel = sandboxPath.slice(root.length).replace(/^\/+/, "");
      const real = pathResolve(PROJECT_ROOT, rel);
      const exists = await pathExists(real);
      return {
        content: [{ type: "text", text: String(exists) }],
      };
    }

    case "faf_migrate": {
      const project = resolveFafProject(
        (args as { project?: string }).project
      );
      const result = await runHostCommand(FAF_BIN, ["migrate"], project, 30_000);
      return formatFafResult("faf migrate", project, result);
    }

    case "faf_sync": {
      const project = resolveFafProject(
        (args as { project?: string }).project
      );
      const result = await runHostCommand(FAF_BIN, ["sync"], project, 30_000);
      return formatFafResult("faf sync", project, result);
    }

    case "faf_score": {
      const project = resolveFafProject(
        (args as { project?: string }).project
      );
      const result = await runHostCommand(FAF_BIN, ["score"], project, 30_000);
      return formatFafResult("faf score", project, result);
    }

    case "faf_moltbot_sync": {
      const project = resolveFafProject(
        (args as { project?: string }).project
      );
      const quotedProject =
        process.platform === "win32" ? `"${project}"` : project;
      const result = await runHostCommand(
        FAF_MOLTBOT_BIN,
        ["sync", "-w", quotedProject],
        project,
        30_000
      );
      return formatFafResult("faf-moltbot sync", project, result);
    }

    default:
      return {
        content: [
          { type: "text", text: `Error: unknown tool '${name}'` },
        ],
        isError: true,
      };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = () => {
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
