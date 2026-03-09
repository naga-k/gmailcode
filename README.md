# gmailcode

Chat with Claude to manage your Gmail — powered by the Claude Agent SDK with Gmail as an MCP tool.

Ask Claude to read, search, and send emails in natural language.

## Features

- **Gmail MCP Tools** — list, read, search, and send emails through Claude
- **Local-first session logs** — cached at `~/.gmailcode/sessions/`, optional GCS sync
- **React Web UI** — modern chat + email management interface via Vite
- **Pluggable** — add more MCP tools (Calendar, Drive, etc.) without changing the frontend

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://claude.ai/code) (handles auth automatically)
- Gmail API credentials (see [Setup](#gmail-setup) below)

### Install & Run

```bash
git clone https://github.com/tullen/gmailcode.git
cd gmailcode/sidecar
npm install
npm run dev
```

Open **http://localhost:8765** in your browser.

### macOS

```bash
# Install Node.js if needed
brew install node

# Clone and run
git clone https://github.com/tullen/gmailcode.git
cd gmailcode/sidecar
npm install
npm run dev
```

## Gmail Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or use an existing one)
3. Enable the **Gmail API** under APIs & Services
4. Create an **OAuth 2.0 Client ID** → Application type: **Desktop app**
5. Download the JSON file
6. Save it to `~/.gmailcode/credentials.json`

On first run, your browser will open for OAuth consent. The token is cached at `~/.gmailcode/gmail-token.json` for future runs.

## Architecture

```
frontend/             React + Vite UI (TypeScript)
  src/components/     Sidebar, EmailList, EmailPreview, ChatPanel
  src/hooks/useWs.ts  WebSocket JSON-RPC client hook

sidecar/              Node.js process (TypeScript)
  src/index.ts        WebSocket JSON-RPC server + Claude Agent SDK
  src/tools/gmail.ts  Gmail MCP tools (list, read, send, search)
  src/session-store.ts  Local session cache with optional GCS sync
```

**Flow:** React UI → WebSocket → Node.js sidecar → Claude Agent SDK → Gmail API

The sidecar keeps API keys and OAuth tokens server-side and isolates long-running agent loops from the UI.

## Adding More Tools

Gmail is an MCP tool. To add Google Calendar, Drive, etc., create a new tool in `sidecar/src/tools/` and register it in the MCP server:

```typescript
// sidecar/src/tools/calendar.ts
export const calendarTool = tool("calendar_list", "List upcoming events", { ... }, async (args) => { ... });

// sidecar/src/index.ts
const server = createSdkMcpServer({
  name: "google-tools",
  tools: [gmailListTool, gmailReadTool, gmailSendTool, gmailSearchTool, calendarTool],
});
```

No changes needed on the frontend — Claude discovers tools automatically via MCP.

## License

MIT
