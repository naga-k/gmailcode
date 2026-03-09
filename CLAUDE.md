# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

gmailcode — React + Vite web app for Gmail management, powered by Claude Agent SDK, with MCP tools and GCS session log sync.

## Architecture

```
frontend/             React + Vite UI (TypeScript)
  src/components/     Sidebar, EmailList, EmailPreview, ChatPanel
  src/hooks/          useWs — WebSocket JSON-RPC client hook
sidecar/              Node.js sidecar process (TypeScript)
  src/index.ts        WebSocket JSON-RPC server, wires Claude Agent SDK
  src/tools/          MCP tools (gmail via Google APIs)
  src/session-store.ts Local-first session cache (~/.gmailcode/sessions/) with optional GCS sync
```

**Data flow:** React UI <-> WebSocket JSON-RPC <-> Node.js sidecar <-> Claude Agent SDK (with MCP tools)

## Commands

### Sidecar (Node.js)
```bash
cd sidecar
npm install
npm run dev          # dev server with hot reload (tsx watch)
npm run build        # compile TypeScript
npm run start        # run compiled JS
npm run typecheck    # type-check without emitting
```

### Frontend (React + Vite)
```bash
cd frontend
npm install
npm run dev            # dev server with hot reload
npm run build          # production build
```

## Environment

Copy `.env.example` to `.env` and fill in:
- `GCS_BUCKET` — optional, enables cloud sync of session logs
- `SIDECAR_PORT` — defaults to 8765

Gmail OAuth uses credentials from `~/.gmailcode/credentials.json` (download from Google Cloud Console). First run opens the browser for OAuth consent.

## AI Calls

- **No `ANTHROPIC_API_KEY` in env.** The sidecar authenticates via the Claude Agent SDK's `query()` function, not the Anthropic SDK directly. For any AI calls in scripts, use `query()` from `@anthropic-ai/claude-agent-sdk` with `options: { model: "claude-haiku-4-5" }` (or other models). Do NOT use `new Anthropic()` — it will fail.

## Key Design Decisions

- **MCP for tools**: Gmail is exposed as an MCP tool via `createSdkMcpServer`. Adding Calendar, Drive, etc. is just adding more `tool()` definitions — no protocol changes needed on the frontend side.
- **Sidecar pattern**: The Node.js sidecar keeps API keys and OAuth tokens server-side and isolates long-running agent loops from the UI process.
- **Local-first caching**: Session logs write to `~/.gmailcode/sessions/` before syncing to GCS. This gives offline resilience and deduplicates writes.
- **JSON-RPC over WebSocket**: Bidirectional — supports both request/response (`chat`) and server-push notifications (`stream` deltas for real-time text display).

## Privacy + History Safety

- Do not commit mailbox-derived artifacts (sender lists, Gmail message IDs, recovery outputs, or absolute local home paths).
- Keep operational recovery data outside this repo under `~/.gmailcode/`.
- Before every push, inspect staged files with `git diff --cached --name-only`.
- If sensitive data is committed, rewrite history, verify removal with `git log --all -- <path>`, then force-push.
- Do not run history rewrites while other agents or background processes are actively modifying this repo.
