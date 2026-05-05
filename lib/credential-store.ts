// Credential storage — multi-user.
//
// Each user's hashed credential lives at its own KV key:
//   nota-enhance:user:<lowercased-username>
// Usernames are case-insensitive: we always look them up via `userKey()`,
// which lowercases. This avoids "Mario" and "mario" colliding silently.
//
// Two backends, picked at runtime:
//   • Vercel KV (REST):   used when KV_REST_API_URL + KV_REST_API_TOKEN exist.
//                         This is the production path on Vercel deploys.
//   • Local JSON file:    fallback for `npm run dev`. Stored in
//                         `<repo>/.credentials.json` (gitignored), now
//                         shaped as a username-keyed object instead of a
//                         single record.
//
// We use Vercel KV's REST endpoint via fetch instead of `@vercel/kv` so we
// don't add another dep and so this file can run on either Node or Edge.
//
// Server-only — never import from a client component.

import "server-only";

export interface Credential {
  username: string;
  passwordHash: string;
  createdAt: number;
}

const KV_USER_PREFIX = "nota-enhance:user:";
// Legacy single-user key from the first-user-wins era. We migrate transparently
// on first read so the existing deploy's account keeps working.
const KV_LEGACY_SINGLETON = "nota-enhance:admin-credential";

function userKey(username: string): string {
  return KV_USER_PREFIX + username.trim().toLowerCase();
}

// Vercel KV (legacy) populated KV_REST_API_*. The marketplace replacement
// (Upstash via Vercel) typically populates UPSTASH_REDIS_REST_*. Some
// connections expose both. Accept either so we don't depend on the exact
// integration shape.
function kvCreds(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

function kvConfigured(): boolean {
  return kvCreds() !== null;
}

// ── KV backend ──────────────────────────────────────────────────────────────
async function kvGetRaw(key: string): Promise<string | null> {
  const c = kvCreds()!;
  const url = `${c.url}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${c.token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`KV GET failed: ${res.status}`);
  }
  const data = (await res.json()) as { result: string | null };
  return data.result ?? null;
}

async function kvSetRaw(key: string, value: string): Promise<void> {
  const c = kvCreds()!;
  const url = `${c.url}/set/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
    body: value,
  });
  if (!res.ok) throw new Error(`KV SET failed: ${res.status}`);
}

async function kvDeleteRaw(key: string): Promise<void> {
  const c = kvCreds()!;
  const url = `${c.url}/del/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`KV DEL failed: ${res.status}`);
  }
}

async function kvGet(username: string): Promise<Credential | null> {
  const raw = await kvGetRaw(userKey(username));
  if (raw) {
    try { return JSON.parse(raw) as Credential; } catch { return null; }
  }
  // Fallback: pre-multi-user deploys stored a single credential at the legacy
  // key. If the requested username matches that record, surface it (and let
  // the caller migrate it forward on the next setCredential).
  const legacyRaw = await kvGetRaw(KV_LEGACY_SINGLETON);
  if (!legacyRaw) return null;
  try {
    const cred = JSON.parse(legacyRaw) as Credential;
    if (cred.username?.toLowerCase() === username.trim().toLowerCase()) {
      return cred;
    }
    return null;
  } catch {
    return null;
  }
}

async function kvSet(cred: Credential): Promise<void> {
  await kvSetRaw(userKey(cred.username), JSON.stringify(cred));
  // Migration: if the legacy singleton holds the same user we just wrote,
  // remove it so a future migration doesn't keep returning a stale copy.
  try {
    const legacyRaw = await kvGetRaw(KV_LEGACY_SINGLETON);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as Credential;
      if (legacy.username?.toLowerCase() === cred.username.toLowerCase()) {
        await kvDeleteRaw(KV_LEGACY_SINGLETON);
      }
    }
  } catch {
    // Best-effort cleanup — the legacy key being left behind is harmless
    // (it just gets shadowed by the new per-user key on read).
  }
}

// ── File backend (dev only) ─────────────────────────────────────────────────
//
// New shape: { byUsername: { [lowercaseUsername]: Credential } }.
// The dev file used to be a flat single-credential object — we read both
// shapes so existing local dev installs keep working.

interface FileShape {
  byUsername: Record<string, Credential>;
}

async function readFileShape(): Promise<FileShape> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".credentials.json");
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FileShape> & Partial<Credential>;
    if (parsed && typeof parsed === "object" && "byUsername" in parsed && parsed.byUsername) {
      return { byUsername: parsed.byUsername };
    }
    // Legacy flat shape — wrap into the new map.
    if (parsed && typeof (parsed as Credential).username === "string") {
      const legacy = parsed as Credential;
      return { byUsername: { [legacy.username.toLowerCase()]: legacy } };
    }
    return { byUsername: {} };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { byUsername: {} };
    }
    throw err;
  }
}

async function writeFileShape(shape: FileShape): Promise<void> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".credentials.json");
  await fs.writeFile(file, JSON.stringify(shape, null, 2), { mode: 0o600 });
}

async function fileGet(username: string): Promise<Credential | null> {
  const shape = await readFileShape();
  return shape.byUsername[username.trim().toLowerCase()] ?? null;
}

async function fileSet(cred: Credential): Promise<void> {
  const shape = await readFileShape();
  shape.byUsername[cred.username.toLowerCase()] = cred;
  await writeFileShape(shape);
}

// ── Public API ──────────────────────────────────────────────────────────────
export async function getCredential(username: string): Promise<Credential | null> {
  if (!username || typeof username !== "string") return null;
  return kvConfigured() ? kvGet(username) : fileGet(username);
}

export async function setCredential(cred: Credential): Promise<void> {
  return kvConfigured() ? kvSet(cred) : fileSet(cred);
}
