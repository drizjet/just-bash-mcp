<!-- faf:start -->
<!-- faf: just-bash-mcp |  |  | Sandboxed bash execution for AI agents via Model Context Protocol -->
<!-- faf: claim=project.faf | family=FAF -->

# CLAUDE.md — just-bash-mcp

## What This Is

Sandboxed bash execution for AI agents via Model Context Protocol

## Stack

- **Runtime:** node
- **Framework:** @modelcontextprotocol/sdk
- **Core Dep:** just-bash@^3.0.1
- **Package Manager:** npm
- **Build:** tsc
- **Language Version:** ES2022
- **Module System:** ESM
- **Node Version:** >=18
- **Api Type:** mcp-stdio
- **Transport:** stdio

## Context

- **Who:** badanalysis — solo dev, multi-harness agent stack
- **Why:** Every agent runs its bash tool with full user privileges; just-bash provides a sandboxed alternative with virtual FS
- **Where:** Windows 11, PowerShell 5.1, OpenCode + 14 other AI agent CLIs
- **How:** Thin MCP wrapper over Vercel Labs' just-bash package; OverlayFs mounted at project root; per-session state

---

*STATUS: BI-SYNC ACTIVE — 2026-06-19T01:51:11.802Z*
<!-- faf:end -->
