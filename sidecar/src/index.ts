import { WebSocketServer, WebSocket } from "ws";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { gmailListTool, gmailReadTool, gmailSendTool, gmailSearchTool, gmailTrashTool, getAuthClient, getGmailProfile, onAuthUrl, submitAuthCode, getGmailClient } from "./tools/gmail.js";
import { saveLocal, syncToGCS, type SessionLog } from "./session-store.js";
import crypto from "crypto";
import http from "http";
import fs from "fs";
import fsP from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const DELETION_LOG = path.join(homedir(), ".gmailcode", "deletion-log.csv");

async function appendDeletionLog(rows: string[]) {
  await fsP.appendFile(DELETION_LOG, rows.join("\n") + "\n");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SIDECAR_PORT ?? 8765);
const GCS_BUCKET = process.env.GCS_BUCKET;

// Factory — createSdkMcpServer instances cannot be reused across query() calls
function makeGmailServer() {
  return createSdkMcpServer({
    name: "gmail-tools",
    tools: [gmailListTool, gmailReadTool, gmailSendTool, gmailSearchTool, gmailTrashTool],
  });
}

// HTTP server for web UI + WebSocket upgrade on same port
const httpServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    const htmlPath = path.join(__dirname, "..", "public", "index.html");
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Error loading UI");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`gmailcode sidecar running:`);
  console.log(`  Web UI:    http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
});

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected");

  ws.on("message", async (raw) => {
    let rpc: { id: string | number; method: string; params?: Record<string, unknown> };
    try {
      rpc = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ error: { code: -32700, message: "Parse error" } }));
      return;
    }

    if (rpc.method === "chat") {
      await handleChat(ws, rpc.id, rpc.params as { message: string });
    } else if (rpc.method === "gmail_login") {
      await handleGmailLogin(ws, rpc.id);
    } else if (rpc.method === "gmail_auth_code") {
      handleGmailAuthCode(ws, rpc.id, rpc.params as { code: string });
    } else if (rpc.method === "gmail_emails") {
      await handleGmailEmails(ws, rpc.id, rpc.params as any);
    } else if (rpc.method === "gmail_email") {
      await handleGmailEmail(ws, rpc.id, rpc.params as { id: string });
    } else if (rpc.method === "gmail_trash") {
      await handleGmailTrash(ws, rpc.id, rpc.params as { ids: string[] });
    } else if (rpc.method === "gmail_labels") {
      await handleGmailLabels(ws, rpc.id);
    } else if (rpc.method === "cleanup_scan") {
      await handleCleanupScan(ws, rpc.id, rpc.params as { category?: string; query?: string });
    } else if (rpc.method === "triage_emails") {
      await handleCleanupScan(ws, rpc.id, { query: (rpc.params as any)?.query });
    } else if (rpc.method === "gmail_trash_query") {
      await handleGmailTrashQuery(ws, rpc.id, rpc.params as { query: string });
    } else if (rpc.method === "cleanup_execute") {
      await handleCleanupExecute(ws, rpc.id, rpc.params as { action: "trash" | "keep"; ids: string[] });
    } else {
      ws.send(
        JSON.stringify({
          id: rpc.id,
          error: { code: -32601, message: `Unknown method: ${rpc.method}` },
        })
      );
    }
  });
});

async function handleGmailLogin(ws: WebSocket, requestId: string | number) {
  try {
    // Register callback to send auth URL to client when generated
    onAuthUrl((url) => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "gmail_auth_url",
          params: { url },
        })
      );
    });

    const email = await getGmailProfile();

    ws.send(
      JSON.stringify({
        id: requestId,
        result: {
          status: "authenticated",
          email,
        },
      })
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        id: requestId,
        error: { code: -32000, message: `Gmail login failed: ${err}` },
      })
    );
  }
}

function handleGmailAuthCode(ws: WebSocket, requestId: string | number, params: { code: string }) {
  const ok = submitAuthCode(params.code);
  ws.send(
    JSON.stringify({
      id: requestId,
      result: { accepted: ok },
    })
  );
}

async function handleGmailLabels(ws: WebSocket, requestId: string | number) {
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.labels.list({ userId: "me" });
    const interesting = ["INBOX","UNREAD","SPAM","TRASH","CATEGORY_PROMOTIONS","CATEGORY_SOCIAL","CATEGORY_UPDATES","CATEGORY_FORUMS"];
    const labels: Record<string, { total: number; unread: number }> = {};
    await Promise.all(
      (res.data.labels ?? [])
        .filter((l) => interesting.includes(l.id!))
        .map(async (l) => {
          const d = await gmail.users.labels.get({ userId: "me", id: l.id! });
          labels[l.id!] = { total: d.data.messagesTotal ?? 0, unread: d.data.messagesUnread ?? 0 };
        })
    );
    ws.send(JSON.stringify({ id: requestId, result: { labels } }));
  } catch (err) {
    ws.send(JSON.stringify({ id: requestId, error: { code: -32000, message: String(err) } }));
  }
}

async function handleGmailEmails(
  ws: WebSocket,
  requestId: string | number,
  params: { query?: string; pageToken?: string; maxResults?: number }
) {
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.messages.list({
      userId: "me",
      q: params.query || "in:inbox",
      pageToken: params.pageToken,
      maxResults: params.maxResults ?? 50,
    });

    if (!res.data.messages?.length) {
      ws.send(JSON.stringify({ id: requestId, result: { messages: [], nextPageToken: null } }));
      return;
    }

    const details = await Promise.all(
      res.data.messages.map((m) =>
        gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe"],
        })
      )
    );

    const messages = details.map((d) => {
      const h = d.data.payload?.headers ?? [];
      const get = (name: string) => h.find((x) => x.name === name)?.value ?? "";
      const from = get("From");
      const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
      return {
        id: d.data.id,
        threadId: d.data.threadId,
        from: nameMatch ? nameMatch[1].trim() : from,
        fromEmail: (from.match(/<([^>]+)>/) || [, from])[1],
        subject: get("Subject"),
        date: get("Date"),
        snippet: d.data.snippet,
        labels: d.data.labelIds ?? [],
        hasUnsub: !!get("List-Unsubscribe"),
        unsubHeader: get("List-Unsubscribe"),
      };
    });

    ws.send(JSON.stringify({ id: requestId, result: { messages, nextPageToken: res.data.nextPageToken ?? null } }));
  } catch (err) {
    ws.send(JSON.stringify({ id: requestId, error: { code: -32000, message: String(err) } }));
  }
}

async function handleGmailEmail(ws: WebSocket, requestId: string | number, params: { id: string }) {
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.messages.get({ userId: "me", id: params.id, format: "full" });
    const h = res.data.payload?.headers ?? [];
    const get = (name: string) => h.find((x: any) => x.name === name)?.value ?? "";

    // Extract body — both plain text and HTML
    let bodyText = "";
    let bodyHtml = "";
    const walk = (part: any) => {
      if (part?.mimeType === "text/plain" && part.body?.data) {
        bodyText += Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      if (part?.mimeType === "text/html" && part.body?.data) {
        bodyHtml += Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      if (part?.parts) part.parts.forEach(walk);
    };
    walk(res.data.payload);
    if (!bodyText && !bodyHtml && res.data.payload?.body?.data) {
      const raw = Buffer.from(res.data.payload.body.data, "base64url").toString("utf-8");
      if (res.data.payload?.mimeType === "text/html") bodyHtml = raw;
      else bodyText = raw;
    }

    ws.send(JSON.stringify({
      id: requestId,
      result: {
        id: res.data.id,
        from: get("From"),
        to: get("To"),
        subject: get("Subject"),
        date: get("Date"),
        body: bodyText || "(no plain text body)",
        bodyHtml: bodyHtml || undefined,
        labels: res.data.labelIds,
        unsubHeader: get("List-Unsubscribe"),
      },
    }));
  } catch (err) {
    ws.send(JSON.stringify({ id: requestId, error: { code: -32000, message: String(err) } }));
  }
}

const BATCH_CHUNK = 1000; // Gmail API batchModify limit

async function handleGmailTrash(ws: WebSocket, requestId: string | number, params: { ids: string[] }) {
  try {
    const gmail = await getGmailClient();
    const now = new Date().toISOString();

    // Chunk into 1000-ID batches (Gmail API limit)
    for (let i = 0; i < params.ids.length; i += BATCH_CHUNK) {
      const chunk = params.ids.slice(i, i + BATCH_CHUNK);
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: { ids: chunk, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      });
    }

    const logRows = params.ids.map((id) => `${now},trash,unknown,unknown,${id}`);
    await appendDeletionLog(logRows);
    ws.send(JSON.stringify({ id: requestId, result: { trashed: params.ids.length } }));
  } catch (err) {
    ws.send(JSON.stringify({ id: requestId, error: { code: -32000, message: String(err) } }));
  }
}

const anthropic = new Anthropic();

const CHAT_SYSTEM = `You are a Gmail assistant with full access to the user's inbox. Use your tools directly — never ask for permission.

Tools available:
- gmail_list: list recent emails (use for browsing)
- gmail_search: search with Gmail query syntax — from:, to:, subject:, after:YYYY/MM/DD, before:, label:, is:unread, has:attachment, etc.
- gmail_read: read full email body by message ID
- gmail_trash: move emails to trash — takes an array of message IDs
- gmail_send: send an email

When asked to delete/clean up emails:
1. Use gmail_search to find them (search multiple times if needed to separate keep vs trash)
2. Call gmail_trash with ALL the IDs to delete — do it, don't ask again
3. Report what was done

Be direct and action-oriented. Execute tasks, don't just describe them.`;

const GMAIL_TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "gmail_list",
    description: "List recent emails from Gmail. Returns id, subject, from, date, snippet.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Gmail search query (e.g. 'is:unread', 'from:boss@company.com')" },
        maxResults: { type: "number", description: "Number of emails to return (default 20, max 100)" },
      },
    },
  },
  {
    name: "gmail_search",
    description: "Search Gmail with query syntax. Returns id, subject, from, date, snippet.",
    input_schema: {
      type: "object" as const,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Gmail search query" },
        maxResults: { type: "number", description: "Number of results (default 50, max 500)" },
      },
    },
  },
  {
    name: "gmail_read",
    description: "Read the full body of a specific email by message ID.",
    input_schema: {
      type: "object" as const,
      required: ["messageId"],
      properties: {
        messageId: { type: "string", description: "Gmail message ID" },
      },
    },
  },
  {
    name: "gmail_trash",
    description: "Move emails to trash. Pass an array of message IDs. Use this to delete emails.",
    input_schema: {
      type: "object" as const,
      required: ["ids"],
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Array of Gmail message IDs to trash" },
      },
    },
  },
  {
    name: "gmail_send",
    description: "Send an email.",
    input_schema: {
      type: "object" as const,
      required: ["to", "subject", "body"],
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Email body (plain text)" },
      },
    },
  },
];

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const gmail = await getGmailClient();

  if (name === "gmail_list" || name === "gmail_search") {
    const q = input.query as string | undefined;
    const maxResults = Math.min(Number(input.maxResults ?? 50), 500);
    const res = await gmail.users.messages.list({ userId: "me", q, maxResults });
    if (!res.data.messages?.length) return "No emails found.";
    const details = await Promise.all(
      res.data.messages.slice(0, maxResults).map(async (m) => {
        const d = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
        const get = (n: string) => d.data.payload?.headers?.find((h) => h.name === n)?.value ?? "";
        return { id: m.id, from: get("From"), subject: get("Subject"), date: get("Date"), snippet: d.data.snippet };
      })
    );
    return JSON.stringify(details, null, 2);
  }

  if (name === "gmail_read") {
    const res = await gmail.users.messages.get({ userId: "me", id: input.messageId as string, format: "full" });
    const get = (n: string) => res.data.payload?.headers?.find((h: any) => h.name === n)?.value ?? "";
    let body = "";
    const walk = (part: any) => {
      if (part?.mimeType === "text/plain" && part.body?.data) body += Buffer.from(part.body.data, "base64url").toString();
      part?.parts?.forEach(walk);
    };
    walk(res.data.payload);
    return JSON.stringify({ id: res.data.id, from: get("From"), subject: get("Subject"), date: get("Date"), body: body || "(no plain text)" });
  }

  if (name === "gmail_trash") {
    const ids = input.ids as string[];
    const CHUNK = 1000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: { ids: ids.slice(i, i + CHUNK), addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      });
    }
    await appendDeletionLog(ids.map((id) => `${new Date().toISOString()},chat_trash,unknown,unknown,${id}`));
    return `Trashed ${ids.length} email(s).`;
  }

  if (name === "gmail_send") {
    const raw = Buffer.from(
      `To: ${input.to}\r\nSubject: ${input.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${input.body}`
    ).toString("base64url");
    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return `Email sent. Message ID: ${res.data.id}`;
  }

  return `Unknown tool: ${name}`;
}

async function handleChat(
  ws: WebSocket,
  requestId: string | number,
  params: { message: string; history?: Array<{ role: string; content: string }> }
) {
  const sessionId = crypto.randomUUID();
  const send = (obj: object) => ws.send(JSON.stringify(obj));

  const messages: Anthropic.MessageParam[] = [
    ...(params.history ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: params.message },
  ];

  let fullText = "";

  try {
    for (let turn = 0; turn < 15; turn++) {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: CHAT_SYSTEM,
        tools: GMAIL_TOOL_DEFS,
        messages,
      });

      let currentText = "";
      const toolUses: Anthropic.ToolUseBlock[] = [];

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          currentText += event.delta.text;
          fullText += event.delta.text;
          send({ jsonrpc: "2.0", method: "stream", params: { sessionId, delta: event.delta.text } });
        }
      }

      const finalMsg = await stream.finalMessage();
      messages.push({ role: "assistant", content: finalMsg.content });

      for (const block of finalMsg.content) {
        if (block.type === "tool_use") toolUses.push(block);
      }

      if (finalMsg.stop_reason === "end_turn" || toolUses.length === 0) break;

      // Execute all tool calls in parallel
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (tu) => {
          try {
            const output = await executeTool(tu.name, tu.input as Record<string, unknown>);
            return { type: "tool_result" as const, tool_use_id: tu.id, content: output };
          } catch (err) {
            return { type: "tool_result" as const, tool_use_id: tu.id, content: `Error: ${err}`, is_error: true };
          }
        })
      );

      messages.push({ role: "user", content: toolResults });
    }

    send({ id: requestId, result: { sessionId, text: fullText } });

    const log: SessionLog = {
      sessionId,
      startedAt: new Date().toISOString(),
      messages: [
        { role: "user", content: params.message, timestamp: new Date().toISOString() },
        { role: "assistant", content: fullText, timestamp: new Date().toISOString() },
      ],
    };
    await saveLocal(log);
    if (GCS_BUCKET) syncToGCS(log, GCS_BUCKET).catch((e) => console.error("GCS sync failed:", e));

  } catch (err: any) {
    console.error("handleChat error:", err?.stack ?? err);
    send({ id: requestId, error: { code: -32000, message: String(err) } });
  }
}

// ============================================================
// Cleanup Handlers — AI-powered email triage
// ============================================================

type TriageCategory = "newsletter" | "promotion" | "social" | "alert" | "transactional" | "personal" | "system" | "other";

interface TriageItem {
  id: string;
  from: string;
  subject: string;
  reason: string;
  category: TriageCategory;
}

interface TriageResult {
  trash: TriageItem[];
  keep: TriageItem[];
  review: TriageItem[];
}

async function handleCleanupScan(ws: WebSocket, requestId: string | number, params: { category?: string; query?: string }) {
  try {
    const gmail = await getGmailClient();
    const gmailQuery = params.query ?? (params.category === "spam" ? "in:spam" : "category:promotions");

    // Paginate to fetch ALL message IDs (not just first 500)
    const messageIds: string[] = [];
    let pageToken: string | undefined;
    do {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: gmailQuery,
        maxResults: 500,
        pageToken,
      });
      messageIds.push(...(listRes.data.messages?.map((m) => m.id!) ?? []));
      pageToken = listRes.data.nextPageToken ?? undefined;
    } while (pageToken);
    if (!messageIds.length) {
      ws.send(JSON.stringify({ id: requestId, result: { trash: [], keep: [], review: [] } }));
      return;
    }

    // Fetch metadata in bounded batches of 10 (avoid rate limit with Promise.all on 1000+ IDs)
    const messages: Array<{ id: string; from: string; subject: string }> = [];
    const META_CONCURRENCY = 10;
    for (let i = 0; i < messageIds.length; i += META_CONCURRENCY) {
      const chunk = messageIds.slice(i, i + META_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (id) => {
          const msg = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "Subject"],
          });
          const headers = msg.data.payload?.headers ?? [];
          const getHeader = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
          return { id, from: getHeader("From"), subject: getHeader("Subject") };
        })
      );
      messages.push(...results);
    }

    // Triage in parallel batches — 3 concurrent, 30s timeout each
    const BATCH_SIZE = 30;
    const TRIAGE_CONCURRENCY = 3;
    const TRIAGE_TIMEOUT_MS = 30_000;
    const triageResults: TriageResult = { trash: [], keep: [], review: [] };

    const batches: Array<typeof messages> = [];
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      batches.push(messages.slice(i, i + BATCH_SIZE));
    }

    let doneCount = 0;

    async function triageBatch(batch: typeof messages) {
      const prompt = `You are an email triage assistant. For each email output:
- decision: "trash" | "keep" | "review"
- category: "newsletter" | "promotion" | "social" | "alert" | "transactional" | "personal" | "system" | "other"
- reason: one short phrase

Categories:
  newsletter   — email digests, subscriptions, blog posts
  promotion    — marketing, sales, discounts, ads
  social       — GitHub, LinkedIn, Twitter, Slack, notifications from platforms
  alert        — automated monitoring, Google Scholar, price alerts, system alerts
  transactional — receipts, order confirmations, shipping, invoices
  personal     — real human sender, direct conversation
  system       — account security, password reset, billing, verification codes
  other        — doesn't fit above

Decision rules:
  trash → newsletter, promotion, social (unless action needed), alert (routine)
  keep  → personal, transactional, system
  review → ambiguous or potentially important

${batch.map((e) => `ID: ${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}`).join("\n\n")}

Reply with ONLY a JSON array, no markdown:
[{"id":"...","decision":"trash","category":"newsletter","reason":"weekly digest"},...]`;

      const timeout = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("triage timeout")), TRIAGE_TIMEOUT_MS)
      );

      const triageCall = (async () => {
        for await (const message of query({
          prompt,
          options: { maxTurns: 1, model: "claude-haiku-4-5" },
        })) {
          if (message.type === "result") {
            return (message as any).result ?? "";
          }
        }
        return "";
      })();

      const resultText = await Promise.race([triageCall, timeout]) as string;
      const jsonMatch = resultText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      const decisions = JSON.parse(jsonMatch[0]) as Array<{
        id: string;
        decision: "trash" | "keep" | "review";
        category: TriageCategory;
        reason: string;
      }>;
      const validDecisions = new Set(["trash", "keep", "review"]);
      const validCategories = new Set(["newsletter","promotion","social","alert","transactional","personal","system","other"]);
      for (const d of decisions) {
        const email = batch.find((e) => e.id === d.id);
        if (email && validDecisions.has(d.decision)) {
          triageResults[d.decision].push({
            id: d.id,
            from: email.from,
            subject: email.subject,
            reason: d.reason ?? "",
            category: validCategories.has(d.category) ? d.category : "other",
          });
        }
      }
    }

    // Process with bounded concurrency, streaming progress after each batch
    for (let i = 0; i < batches.length; i += TRIAGE_CONCURRENCY) {
      const window = batches.slice(i, i + TRIAGE_CONCURRENCY);
      await Promise.allSettled(window.map(async (batch) => {
        try {
          await triageBatch(batch);
        } catch (err) {
          console.error("Triage batch failed:", err);
        }
        doneCount += batch.length;
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "triage_progress",
          params: { done: doneCount, total: messages.length },
        }));
      }));
    }

    ws.send(JSON.stringify({ id: requestId, result: triageResults }));
  } catch (err: any) {
    console.error("handleCleanupScan error:", err);
    ws.send(
      JSON.stringify({
        id: requestId,
        error: { code: -32000, message: `Cleanup scan failed: ${err.message}` },
      })
    );
  }
}

async function handleCleanupExecute(
  ws: WebSocket,
  requestId: string | number,
  params: { action: "trash" | "keep"; ids: string[] }
) {
  try {
    const gmail = await getGmailClient();
    const now = new Date().toISOString();

    if (params.action === "trash") {
      for (let i = 0; i < params.ids.length; i += BATCH_CHUNK) {
        const chunk = params.ids.slice(i, i + BATCH_CHUNK);
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: chunk, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM", "CATEGORY_PROMOTIONS"] },
        });
      }
      await appendDeletionLog(params.ids.map((id) => `${now},trash,unknown,unknown,${id}`));
    } else if (params.action === "keep") {
      for (let i = 0; i < params.ids.length; i += BATCH_CHUNK) {
        const chunk = params.ids.slice(i, i + BATCH_CHUNK);
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: chunk, addLabelIds: ["INBOX"], removeLabelIds: ["SPAM", "CATEGORY_PROMOTIONS"] },
        });
      }
      await appendDeletionLog(params.ids.map((id) => `${now},rescue,unknown,unknown,${id}`));
    }

    ws.send(JSON.stringify({ id: requestId, result: { executed: params.ids.length } }));
  } catch (err: any) {
    console.error("handleCleanupExecute error:", err);
    ws.send(
      JSON.stringify({
        id: requestId,
        error: { code: -32000, message: `Cleanup execute failed: ${err.message}` },
      })
    );
  }
}

// Trash ALL emails matching a Gmail query — no AI, just paginate + batchModify
async function handleGmailTrashQuery(ws: WebSocket, requestId: string | number, params: { query: string }) {
  try {
    const gmail = await getGmailClient();

    // Paginate through all matching message IDs
    const allIds: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await gmail.users.messages.list({
        userId: "me",
        q: params.query,
        maxResults: 500,
        pageToken,
      });
      allIds.push(...(res.data.messages?.map((m) => m.id!) ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
      // Stream progress back so the frontend can show a count
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "trash_query_progress",
        params: { found: allIds.length, done: false },
      }));
    } while (pageToken);

    if (!allIds.length) {
      ws.send(JSON.stringify({ id: requestId, result: { trashed: 0 } }));
      return;
    }

    // batchModify in chunks of 1000
    const now = new Date().toISOString();
    for (let i = 0; i < allIds.length; i += BATCH_CHUNK) {
      const chunk = allIds.slice(i, i + BATCH_CHUNK);
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: { ids: chunk, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM", "CATEGORY_PROMOTIONS"] },
      });
    }

    await appendDeletionLog(allIds.map((id) => `${now},trash_query,${params.query},unknown,${id}`));
    ws.send(JSON.stringify({ id: requestId, result: { trashed: allIds.length } }));
  } catch (err: any) {
    console.error("handleGmailTrashQuery error:", err);
    ws.send(JSON.stringify({ id: requestId, error: { code: -32000, message: String(err) } }));
  }
}
