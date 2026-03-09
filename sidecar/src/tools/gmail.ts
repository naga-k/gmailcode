import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { google } from "googleapis";
import fs from "fs/promises";
import path from "path";
import { homedir } from "os";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

const TOKEN_PATH = path.join(homedir(), ".gmailcode", "gmail-token.json");
const CREDENTIALS_PATH = path.join(homedir(), ".gmailcode", "credentials.json");

// Pending auth state — allows the sidecar to relay the auth URL to clients
let pendingAuthResolve: ((code: string) => void) | null = null;
let authUrlCallback: ((url: string) => void) | null = null;

/** Register a callback to be notified when an auth URL is generated. */
export function onAuthUrl(cb: (url: string) => void) {
  authUrlCallback = cb;
}

/** Submit the authorization code received from Google. */
export function submitAuthCode(code: string): boolean {
  if (pendingAuthResolve) {
    pendingAuthResolve(code);
    pendingAuthResolve = null;
    return true;
  }
  return false;
}

async function loadCredentials() {
  const raw = await fs.readFile(CREDENTIALS_PATH, "utf-8");
  const creds = JSON.parse(raw);
  const key = creds.installed || creds.web;
  return key;
}

export async function getAuthClient(): Promise<OAuth2Client> {
  // Try loading saved token first
  try {
    const tokenData = await fs.readFile(TOKEN_PATH, "utf-8");
    const saved = JSON.parse(tokenData);
    const oauth2 = new google.auth.OAuth2(saved.client_id, saved.client_secret);
    oauth2.setCredentials({ refresh_token: saved.refresh_token });
    // Force a token refresh to verify credentials are valid
    await oauth2.getAccessToken();
    return oauth2;
  } catch {
    // No saved token — run OAuth flow
  }

  const key = await loadCredentials();
  const oauth2 = new google.auth.OAuth2(
    key.client_id,
    key.client_secret,
    "urn:ietf:wg:oauth:2.0:oob"
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  if (authUrlCallback) authUrlCallback(authUrl);
  console.log("\n=== Gmail OAuth ===");
  console.log("Open this URL in your browser:");
  console.log(authUrl);
  console.log("Then submit the code via the gmail_auth_code endpoint.\n");

  // Wait for the auth code to be submitted
  const code = await new Promise<string>((resolve) => {
    pendingAuthResolve = resolve;
  });

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Save token for next time
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: tokens.refresh_token,
  });
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, payload);

  return oauth2;
}

async function getGmail() {
  const auth = await getAuthClient();
  return google.gmail({ version: "v1", auth });
}

export async function getGmailProfile() {
  const gmail = await getGmail();
  const profile = await gmail.users.getProfile({ userId: "me" });
  return profile.data.emailAddress;
}

export async function getGmailClient() {
  return getGmail();
}

// --- MCP Tools ---

export const gmailListTool = tool(
  "gmail_list",
  "List recent emails from Gmail inbox. Returns subject, from, date, and message ID.",
  {
    query: z.string().default("").describe("Gmail search query (e.g. 'is:unread', 'from:boss@company.com')"),
    maxResults: z.number().min(1).max(50).default(10).describe("Number of emails to return"),
  },
  async (args) => {
    try {
      const gmail = await getGmail();
      const res = await gmail.users.messages.list({
        userId: "me",
        q: args.query || undefined,
        maxResults: args.maxResults,
      });

      if (!res.data.messages?.length) {
        return { content: [{ type: "text" as const, text: "No emails found." }] };
      }

      const emails = await Promise.all(
        res.data.messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const headers = detail.data.payload?.headers ?? [];
          const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
          return {
            id: msg.id,
            subject: get("Subject"),
            from: get("From"),
            date: get("Date"),
            snippet: detail.data.snippet,
          };
        })
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(emails, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Gmail error: ${err}` }] };
    }
  }
);

export const gmailReadTool = tool(
  "gmail_read",
  "Read the full content of a specific email by its message ID.",
  {
    messageId: z.string().describe("The Gmail message ID to read"),
  },
  async (args) => {
    try {
      const gmail = await getGmail();
      const res = await gmail.users.messages.get({
        userId: "me",
        id: args.messageId,
        format: "full",
      });

      const headers = res.data.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";

      // Extract body text
      let body = "";
      const parts = res.data.payload?.parts ?? [res.data.payload];
      for (const part of parts) {
        if (part?.mimeType === "text/plain" && part.body?.data) {
          body += Buffer.from(part.body.data, "base64url").toString("utf-8");
        }
      }

      if (!body && res.data.payload?.body?.data) {
        body = Buffer.from(res.data.payload.body.data, "base64url").toString("utf-8");
      }

      const email = {
        id: res.data.id,
        subject: get("Subject"),
        from: get("From"),
        to: get("To"),
        date: get("Date"),
        body: body || "(no plain text body)",
        labels: res.data.labelIds,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(email, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Gmail error: ${err}` }] };
    }
  }
);

export const gmailSendTool = tool(
  "gmail_send",
  "Send an email via Gmail. Composes and sends the message.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body (plain text)"),
  },
  async (args) => {
    try {
      const gmail = await getGmail();

      const raw = Buffer.from(
        `To: ${args.to}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${args.body}`
      ).toString("base64url");

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });

      return {
        content: [
          { type: "text" as const, text: `Email sent successfully. Message ID: ${res.data.id}` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Gmail send error: ${err}` }] };
    }
  }
);

export const gmailTrashTool = tool(
  "gmail_trash",
  "Move emails to trash by message ID. Use gmail_search first to find the IDs, then call this to delete them. Can handle multiple IDs at once.",
  {
    ids: z.array(z.string()).describe("Array of Gmail message IDs to trash"),
  },
  async (args) => {
    try {
      const gmail = await getGmail();
      const CHUNK = 1000;
      for (let i = 0; i < args.ids.length; i += CHUNK) {
        const chunk = args.ids.slice(i, i + CHUNK);
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: chunk, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
        });
      }
      return { content: [{ type: "text" as const, text: `Trashed ${args.ids.length} email(s).` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Gmail trash error: ${err}` }] };
    }
  }
);

export const gmailSearchTool = tool(
  "gmail_search",
  "Search Gmail with advanced queries. Supports Gmail search operators like from:, to:, subject:, has:attachment, after:, before:, label:, is:unread, etc.",
  {
    query: z.string().describe("Gmail search query"),
    maxResults: z.number().min(1).max(50).default(10).describe("Number of results"),
  },
  async (args) => {
    // Reuses gmail_list logic — same API, just emphasizing search capability
    try {
      const gmail = await getGmail();
      const res = await gmail.users.messages.list({
        userId: "me",
        q: args.query,
        maxResults: args.maxResults,
      });

      if (!res.data.messages?.length) {
        return { content: [{ type: "text" as const, text: `No emails matching: "${args.query}"` }] };
      }

      const emails = await Promise.all(
        res.data.messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const headers = detail.data.payload?.headers ?? [];
          const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
          return {
            id: msg.id,
            subject: get("Subject"),
            from: get("From"),
            date: get("Date"),
            snippet: detail.data.snippet,
          };
        })
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(emails, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Gmail error: ${err}` }] };
    }
  }
);
