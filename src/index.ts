import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Bash, OverlayFs } from "just-bash";
import {
  resolve as pathResolve,
  normalize,
  relative,
  isAbsolute,
  posix,
} from "node:path";
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

const SANDBOX_ROOT = "/home/user/project";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Translate a sandbox path to a real path that is guaranteed to stay inside
 * PROJECT_ROOT, or return null.
 *
 * The final check runs on the *resolved host path*, not the input string: a
 * prefix test on the input admits `../`, `..\` (a plain filename to posix but a
 * separator to win32), drive letters such as `C:/x`, and sibling names such as
 * `/home/user/project-other`. Symlinks are not followed here; callers that touch
 * the filesystem must go through OverlayFs, which refuses symlinks by default.
 */
function sandboxToReal(sandboxPath: string): string | null {
  if (sandboxPath.includes("\0")) return null;
  const norm = posix.normalize(sandboxPath);
  if (norm !== SANDBOX_ROOT && !norm.startsWith(SANDBOX_ROOT + "/")) return null;
  const rel = norm.slice(SANDBOX_ROOT.length).replace(/^\/+/, "");
  const root = pathResolve(PROJECT_ROOT);
  const real = pathResolve(root, rel);
  const back = relative(root, real);
  if (back === "") return real;
  if (back === ".." || back.startsWith(".." + "/") || back.startsWith("..\\") || isAbsolute(back)) {
    return null;
  }
  return real;
}

function parseTimeout(raw: unknown): number {
  // A NaN/negative delay makes Node fire setTimeout after 1ms, aborting almost
  // every script; fall back to the default instead.
  const n = Number(raw ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return Math.min(DEFAULT_TIMEOUT_MS, MAX_DURATION_MS);
  return Math.min(n, MAX_DURATION_MS);
}

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
    cwd: SANDBOX_ROOT,
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

const FAF_BIN = process.env.FAF_BIN ?? "faf";
const FAF_MOLTBOT_BIN = process.env.FAF_MOLTBOT_BIN ?? "faf-moltbot";

// faf sync / faf-moltbot sync regenerate agent docs from project.faf and can
// overwrite hand-maintained instructions (and recreate root CLAUDE/SOUL files
// some workspaces forbid). Agents only get them when the operator opts in.
const FAF_SYNC_ENABLED = process.env.JUST_BASH_ENABLE_FAF_SYNC === "1";
const GATED_TOOLS = new Set(["faf_sync", "faf_moltbot_sync"]);

interface HostCmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// cmd.exe expands %VAR% (and !VAR! under delayed expansion) even inside double
// quotes, and an embedded quote would end the quoted span; refuse those instead
// of attempting to escape them. Inside quotes, & | < > ^ are literal.
const CMD_UNSAFE = /["%!\r\n\0]/;

function quoteForCmd(arg: string): string {
  // Backslashes directly before the closing quote would escape it for the
  // MSVCRT/Node argv parser of the called program, so double them.
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

function runHostCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<HostCmdResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    if (isWin) {
      const bad = [command, ...args].find((a) => CMD_UNSAFE.test(a));
      if (bad !== undefined) {
        resolve({
          stdout: "",
          stderr: `refused: argument contains a character cmd.exe cannot pass safely (" % ! or newline): ${bad}`,
          exitCode: 1,
        });
        return;
      }
    }
    // On Windows, faf/faf-moltbot are npm .cmd shims, which Node will only run
    // through cmd.exe. /s strips exactly the outer quote pair, and verbatim
    // arguments stop Node from re-escaping the already-quoted line.
    const child = isWin
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(quoteForCmd).join(" ")}"`], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
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

/**
 * Validate the `project` argument of the faf_* tools. These tools run real host
 * commands; scope is intentionally NOT limited to PROJECT_ROOT (that is a
 * trust-model decision for the operator), but the target must be an existing
 * absolute directory so a relative or mistyped path cannot silently resolve
 * against the server's cwd.
 */
async function resolveFafProject(
  arg: unknown
): Promise<{ project: string } | { error: string }> {
  const raw = typeof arg === "string" && arg.length > 0 ? arg : PROJECT_ROOT;
  if (!isAbsolute(raw)) return { error: `project must be an absolute path (got: ${raw})` };
  const project = pathResolve(raw);
  try {
    if (!(await stat(project)).isDirectory()) {
      return { error: `project is not a directory: ${project}` };
    }
  } catch {
    return { error: `project directory does not exist: ${project}` };
  }
  return { project };
}

async function runFafTool(
  label: string,
  bin: string,
  args: (project: string) => string[],
  projectArg: unknown
) {
  const resolved = await resolveFafProject(projectArg);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: `Error: ${resolved.error}` }],
      isError: true,
    };
  }
  const { project } = resolved;
  const result = await runHostCommand(bin, args(project), project, 30_000);
  return formatFafResult(label, project, result);
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
  tools: TOOLS.filter((t) => FAF_SYNC_ENABLED || !GATED_TOOLS.has(t.name)),
}));

const TOOLS = [
  {
    name: "bash_exec",
    description:
      "Execute a bash script in a virtual filesystem whose project root is mounted read-through at /home/user/project. " +
      "Writes go to an in-memory overlay that is never written to disk (there is no commit tool; " +
      "it is discarded on sandbox_reset or server restart). Paths outside the mount cannot reach the host. " +
      "Network is disabled unless JUST_BASH_NETWORK_ALLOW is set. " +
      "Supports: cat/cp/ls/find/grep/awk/sed/sort/uniq/jq/sqlite3/xan/yq/tar/tee. " +
      "The python3 and js-exec runtimes are not enabled in this server. " +
      "Note: the faf_* tools in this server are NOT sandboxed.",
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
      "Translate a path under /home/user/project to the corresponding real path under the project root. " +
      "Rejects paths that would leave the project root. Does not check existence or follow symlinks.",
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
    description:
      "Check if a path under /home/user/project exists as the sandbox sees it " +
      "(in-memory overlay writes and deletions applied over the real project root).",
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
];

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (GATED_TOOLS.has(name) && !FAF_SYNC_ENABLED) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${name} is disabled; the operator must set JUST_BASH_ENABLE_FAF_SYNC=1 to allow it`,
        },
      ],
      isError: true,
    };
  }

  switch (name) {
    case "bash_exec": {
      const script = String((args as { script: string }).script ?? "");
      const timeout = parseTimeout((args as { timeout?: unknown }).timeout);
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
        `Sandbox cwd:     ${SANDBOX_ROOT}`,
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
      const real = sandboxToReal(sandboxPath);
      if (real === null) {
        return {
          content: [
            {
              type: "text",
              text: `Error: path must stay within ${SANDBOX_ROOT} (got: ${sandboxPath})`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: real }],
      };
    }

    case "path_exists": {
      const sandboxPath = String(
        (args as { sandboxPath: string }).sandboxPath ?? ""
      );
      // Same boundary as realpath, then ask the overlay itself so in-memory
      // writes/deletions count and OverlayFs's symlink policy applies. Never
      // stat the host path directly: that made this tool an existence oracle
      // for arbitrary host files.
      if (sandboxToReal(sandboxPath) === null) {
        return {
          content: [
            { type: "text", text: `Error: path must stay within ${SANDBOX_ROOT}` },
          ],
          isError: true,
        };
      }
      await getBash();
      const exists = await sandbox.overlay!.exists(posix.normalize(sandboxPath));
      return {
        content: [{ type: "text", text: String(exists) }],
      };
    }

    case "faf_migrate":
      return runFafTool("faf migrate", FAF_BIN, () => ["migrate"], (args as { project?: unknown }).project);

    case "faf_sync":
      return runFafTool("faf sync", FAF_BIN, () => ["sync"], (args as { project?: unknown }).project);

    case "faf_score":
      return runFafTool("faf score", FAF_BIN, () => ["score"], (args as { project?: unknown }).project);

    case "faf_moltbot_sync":
      // runHostCommand quotes each argument; pre-quoting here produced ""path"".
      return runFafTool(
        "faf-moltbot sync",
        FAF_MOLTBOT_BIN,
        (project) => ["sync", "-w", project],
        (args as { project?: unknown }).project
      );

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
