import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { Storage } from "@google-cloud/storage";

/** Local-first session log cache with GCS sync. */

const CACHE_DIR = join(homedir(), ".gmailcode", "sessions");

export interface SessionLog {
  sessionId: string;
  startedAt: string;
  messages: Array<{ role: string; content: string; timestamp: string }>;
}

export async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
}

function sessionPath(sessionId: string): string {
  return join(CACHE_DIR, `${sessionId}.json`);
}

export async function saveLocal(log: SessionLog): Promise<void> {
  await ensureCacheDir();
  await writeFile(sessionPath(log.sessionId), JSON.stringify(log, null, 2));
}

export async function loadLocal(sessionId: string): Promise<SessionLog | null> {
  try {
    const data = await readFile(sessionPath(sessionId), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function listLocalSessions(): Promise<string[]> {
  await ensureCacheDir();
  const files = await readdir(CACHE_DIR);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
}

export async function syncToGCS(
  log: SessionLog,
  bucket: string
): Promise<void> {
  // Uses application-default credentials (ADC) from the user's local gcloud setup
  const storage = new Storage();
  const file = storage.bucket(bucket).file(`sessions/${log.sessionId}.json`);
  await file.save(JSON.stringify(log, null, 2), {
    contentType: "application/json",
  });
}
