# AGENTS.md — just-bash-mcp

> Sandboxed bash execution for AI agents via Model Context Protocol.

## What this is

A thin MCP (Model Context Protocol) server that wraps [Vercel Labs' `just-bash`](https://github.com/vercel-labs/just-bash) — a virtual bash environment in TypeScript with an in-memory filesystem. Provides agents with a sandboxed `bash` tool whose writes go to an in-memory overlay and do **not** touch the real filesystem unless committed.

## Tools exposed

| Tool | Purpose |
|---|---|
| `bash_exec(script, timeout?)` | Run a bash script in the sandbox. Timeout capped at 30s, stdout at 1MB. |
| `sandbox_status` | Show project root, age, exec count, network policy. |
| `sandbox_reset(confirm)` | Drop the overlay and start fresh. Requires `confirm: true`. |
| `realpath(sandboxPath)` | Translate `/home/user/project/*` to the real `<project-root>/*` path. |
| `path_exists(sandboxPath)` | Check existence in overlay + real FS. |

## Path translation

The sandbox mounts the project root at `/home/user/project`. Use `realpath` to translate paths before reading from the real FS.

```
/home/user/project/src/index.ts   <-->   C:\tools\03-Projects\lains Tools\just-bash-mcp\src\index.ts
```

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `JUST_BASH_PROJECT_ROOT` | `cwd` | Project dir to mount in the overlay |
| `JUST_BASH_NETWORK_ALLOW` | (disabled) | Comma-separated URL prefixes for `curl` (GET/HEAD only) |
| `JUST_BASH_MAX_DURATION_MS` | 30000 | Script timeout cap |
| `JUST_BASH_MAX_OUTPUT_BYTES` | 1048576 | stdout cap |

## Non-negotiables

- **Writes do NOT touch the real filesystem.** The overlay is in-memory. To commit, the user must do so explicitly outside this MCP server.
- **Network is OFF by default.** Set `JUST_BASH_NETWORK_ALLOW` to a comma-separated allow-list (e.g. `https://api.github.com/repos/,https://registry.npmjs.org/`) to enable `curl`.
- **No VM isolation.** This is a TypeScript-level sandbox, not OS-level. It stops accidental damage, not a determined attacker.
- **Path traversal blocked.** Sandbox paths must start with `/home/user/project`.

## When to use this

- Agent wants to run shell commands: `bash_exec("ls -la src/")`
- Agent wants to write a file: tell it to use `bash_exec` with `cat > path <<EOF ... EOF` (writes go to overlay, don't pollute real FS)
- Agent wants to read a file at an exact real path: use `realpath` first
- Need to start over: `sandbox_reset(confirm=true)`

## When NOT to use this

- User's own day-to-day shell work (use PowerShell on Windows).
- Anything that needs to actually modify the real filesystem without the user reviewing the diff first.
- Long-running processes >30s.
- Heavy network access (the allow-list is intentionally restrictive).

## Build / test / wire

```bash
npm install
npm run build                       # tsc -> dist/
node dist/index.js                  # stdio MCP server

# Test
$req | node dist/index.js           # pipe JSON-RPC requests

# Wire to opencode (add to mcp_servers.json):
"just-bash": {
  "command": "node",
  "args": ["C:\\tools\\03-Projects\\lains Tools\\just-bash-mcp\\dist\\index.js"],
  "env": {
    "JUST_BASH_PROJECT_ROOT": "C:\\tools\\03-Projects\\lains Tools\\just-bash-mcp"
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  AI Agent (OpenCode, Codex, Claude, etc.)   │
│  ─ calls MCP tool: bash_exec                │
└────────────────┬────────────────────────────┘
                 │ JSON-RPC over stdio
                 ▼
┌─────────────────────────────────────────────┐
│  just-bash-mcp (this server)                │
│  ─ singleton Bash instance per session      │
│  ─ path translation / truncation / limits   │
└────────────────┬────────────────────────────┘
                 │ Bash.exec()
                 ▼
┌─────────────────────────────────────────────┐
│  just-bash (Vercel Labs)                    │
│  ─ AST-based bash interpreter               │
│  ─ 100+ commands                            │
│  ─ optional python3 (CPython WASM)          │
│  ─ optional js-exec (QuickJS)               │
└────────────────┬────────────────────────────┘
                 │ OverlayFs (copy-on-write)
                 ▼
┌─────────────────────────────────────────────┐
│  Real filesystem (JUST_BASH_PROJECT_ROOT)   │
│  ─ reads: see real files                    │
│  ─ writes: go to in-memory overlay          │
└─────────────────────────────────────────────┘
```

## Related

- `C:\Text vault\RULES.md` — shared persona + constraints (applies to all lanes)
- `C:\tools\03-Projects\lains Tools\Nanolane\RULES.md` — lains Tools-specific rules
- `project.faf` — source of truth for faf sync (SOUL.md / CLAUDE.md / GEMINI.md)
- `https://github.com/vercel-labs/just-bash` — upstream
- `https://github.com/vercel-labs/bash-tool` — companion AI SDK tool
