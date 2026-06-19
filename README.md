# just-bash-mcp

Sandboxed bash execution for AI agents via [Model Context Protocol](https://modelcontextprotocol.io/), powered by [Vercel Labs' `just-bash`](https://github.com/vercel-labs/just-bash).

Every agent in your fleet — OpenCode, Codex, Claude, Droid, Cline, Kiro, Gemini, etc. — currently runs its `bash` tool with full user privileges against your real filesystem. This MCP server replaces that with a sandboxed alternative: agents operate on a **virtual filesystem backed by an in-memory overlay**, so writes evaporate unless you explicitly commit them.

## What you get

- 100+ unix commands (`cat`, `awk`, `sed`, `jq`, `sqlite3`, `xan`, `yq`, `tar`, `grep`, `sort`, `find`, `tee`, ...)
- Optional `python3` (CPython compiled to WASM) and `js-exec` (QuickJS) — opt-in
- Pipes, redirections, variables, if/while/for, functions, all the bash you know
- A real bash, not a shell-out to PowerShell — works the same on every OS
- Path translation: `/home/user/project/*` ↔ your real `<project-root>/*`
- Network off by default; allow-list via env var
- 30s timeout, 1MB output cap, configurable
- Process kills cleanly on SIGINT/SIGTERM

## What you don't get (intentional)

- No VM isolation. This is a TypeScript sandbox, not OS-level. It stops accidental damage — a slipped `rm -rf` won't kill your real project — but not a determined attacker.
- No modification of the real filesystem. The overlay is in-memory; committing is a separate step the user does explicitly.
- No PowerShell compatibility. This is bash. For your day-to-day shell on Windows, keep using PowerShell.

## Install

```bash
cd "C:\tools\03-Projects\lains Tools\just-bash-mcp"
npm install
npm run build
```

## Run standalone (for testing)

```bash
# Pipe JSON-RPC requests
$req | node dist/index.js
```

The server uses stdio transport. It speaks the [MCP protocol](https://modelcontextprotocol.io/).

## Wire to OpenCode

Add to `C:\Users\badanalysis\.config\opencode\mcp_servers.json`:

```json
"just-bash": {
  "command": "node",
  "args": ["C:\\tools\\03-Projects\\lains Tools\\just-bash-mcp\\dist\\index.js"],
  "env": {
    "JUST_BASH_PROJECT_ROOT": "C:\\path\\to\\your\\project"
  }
}
```

The `JUST_BASH_PROJECT_ROOT` should point at the project you want the agent to operate on. Each project will need its own MCP instance OR you set it to a neutral root and let the agent `cd` around.

## Tools

### `bash_exec(script, timeout?)`

Run a bash script in the sandbox. Returns stdout, stderr, and exit code.

```typescript
// Example: agent wants to look at the project structure
await bash_exec({ script: "ls -la src/ && wc -l src/*.ts | tail -5" });
```

```typescript
// Example: agent wants to create a new file
await bash_exec({
  script: "mkdir -p src/components && cat > src/components/Button.tsx <<'EOF\nexport function Button() { return <button>Click</button>; }\nEOF"
});
// The file lives in the overlay until committed
```

### `sandbox_status`

```typescript
await sandbox_status();
// {
//   project_root: "C:\\path\\to\\project",
//   age_seconds: 42,
//   executions: 7,
//   network_policy: "DISABLED" | "https://api.github.com/, ..."
// }
```

### `sandbox_reset(confirm)`

Drop the in-memory overlay and start fresh. Useful when an agent has gone off-track and you want to restart from the real FS state.

```typescript
await sandbox_reset({ confirm: true });
```

### `realpath(sandboxPath)`

```typescript
await realpath({ sandboxPath: "/home/user/project/src/index.ts" });
// "C:\\path\\to\\project\\src\\index.ts"
```

### `path_exists(sandboxPath)`

```typescript
await path_exists({ sandboxPath: "/home/user/project/README.md" });
// "true" | "false"
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `JUST_BASH_PROJECT_ROOT` | `cwd` | Project dir to mount in the overlay |
| `JUST_BASH_NETWORK_ALLOW` | (empty) | Comma-separated URL prefixes (e.g. `https://api.github.com/,https://registry.npmjs.org/`) |
| `JUST_BASH_MAX_DURATION_MS` | 30000 | Max script duration |
| `JUST_BASH_MAX_OUTPUT_BYTES` | 1048576 | Max stdout bytes |

## Limits

Built into just-bash itself:

- `maxCallDepth: 100` (function recursion)
- `maxCommandCount: 10000` (total commands in a session)
- `maxLoopIterations: 10000` (per loop)
- `maxAwkIterations: 10000`, `maxSedIterations: 10000`

## Security model

| Layer | Protection |
|---|---|
| **TypeScript sandbox** | Stops prototype-pollution attacks and accidental escape to host JS engine |
| **Filesystem isolation** | Writes go to in-memory overlay; reads from real FS only at the configured project root |
| **Path translation** | All sandbox paths must start with `/home/user/project`; traversal blocked |
| **Network isolation** | Off by default; allow-list with URL prefix + HTTP method (GET/HEAD) |
| **Optional runtimes off** | `python3` and `js-exec` are opt-in — they don't exist unless you set `python: true` / `javascript: true` |
| **Execution limits** | Prevent infinite loops, runaway computation |
| **No VM** | If you need a full VM with arbitrary binary execution, use [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) instead — same API, different backend |

## License

Apache-2.0 (inherited from `just-bash`)

## Related projects

- [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash) — the underlying virtual bash
- [vercel-labs/bash-tool](https://github.com/vercel-labs/bash-tool) — companion AI SDK tool
- [vercel-labs/just-bash-executor](https://github.com/vercel-labs/just-bash/tree/main/packages/just-bash-executor) — tool framework bridge (MCP, GraphQL, OpenAPI)
- [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) — production-grade VM with the same API
