// Server-side storage for user-submitted improvement suggestions.
//
// Single global queue at one KV key — suggestions aren't user-private (the
// admin reads them off the same shelf), so there's no per-user partition.
// Storage cap: most recent N entries; older ones are dropped on append so
// the value can't grow without bound.
//
// Server-only — never import from a client component.

import "server-only";

export interface Suggestion {
  id: string;
  username: string;
  text: string;
  createdAt: number;
  /** Optional contact address — users may leave it blank if they don't want
   *  to be contacted. Trimmed and length-limited at submission time. */
  contact?: string;
}

const KV_KEY = "nota-enhance:suggestions:list";
// Hard cap: enough headroom for a public beta but well below KV's 1 MB
// per-value soft limit. When we reach the cap, oldest entries fall off.
const MAX_SUGGESTIONS = 500;

function kvCreds(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

function kvConfigured(): boolean {
  return kvCreds() !== null;
}

async function kvGet(): Promise<Suggestion[]> {
  const c = kvCreds()!;
  const url = `${c.url}/get/${encodeURIComponent(KV_KEY)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${c.token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`KV GET failed: ${res.status}`);
  }
  const data = (await res.json()) as { result: string | null };
  if (!data.result) return [];
  try {
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function kvSet(list: Suggestion[]): Promise<void> {
  const c = kvCreds()!;
  const url = `${c.url}/set/${encodeURIComponent(KV_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(list),
  });
  if (!res.ok) throw new Error(`KV SET failed: ${res.status}`);
}

// ── File backend (dev only) ─────────────────────────────────────────────────
async function fileGet(): Promise<Suggestion[]> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".suggestions.json");
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

async function fileSet(list: Suggestion[]): Promise<void> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".suggestions.json");
  await fs.writeFile(file, JSON.stringify(list, null, 2), { mode: 0o600 });
}

// ── Public API ──────────────────────────────────────────────────────────────
export async function listSuggestions(): Promise<Suggestion[]> {
  return kvConfigured() ? kvGet() : fileGet();
}

export async function appendSuggestion(s: Suggestion): Promise<void> {
  const current = await listSuggestions();
  // Newest first — readers (admin tooling) almost always want recency.
  const next = [s, ...current].slice(0, MAX_SUGGESTIONS);
  return kvConfigured() ? kvSet(next) : fileSet(next);
}
