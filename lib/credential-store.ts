// Credential storage — single-user, "first user wins" model.
//
// Two backends, picked at runtime:
//   • Vercel KV (REST):   used when KV_REST_API_URL + KV_REST_API_TOKEN exist.
//                         This is the production path on Vercel deploys.
//   • Local JSON file:    fallback for `npm run dev`. Stored in
//                         `<repo>/.credentials.json` (gitignored).
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

const KV_KEY = "nota-enhance:admin-credential";

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
async function kvGet(): Promise<Credential | null> {
  const c = kvCreds()!;
  const url = `${c.url}/get/${encodeURIComponent(KV_KEY)}`;
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
  if (!data.result) return null;
  try {
    return JSON.parse(data.result) as Credential;
  } catch {
    return null;
  }
}

async function kvSet(cred: Credential): Promise<void> {
  const c = kvCreds()!;
  const url = `${c.url}/set/${encodeURIComponent(KV_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
    // Upstash REST `set` takes the raw value as the request body.
    body: JSON.stringify(cred),
  });
  if (!res.ok) throw new Error(`KV SET failed: ${res.status}`);
}

// ── File backend (dev only) ─────────────────────────────────────────────────
async function fileGet(): Promise<Credential | null> {
  // Dynamic-import fs/path so this module stays edge-safe when KV is in use.
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".credentials.json");
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as Credential;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

async function fileSet(cred: Credential): Promise<void> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".credentials.json");
  await fs.writeFile(file, JSON.stringify(cred, null, 2), { mode: 0o600 });
}

// ── Public API ──────────────────────────────────────────────────────────────
export async function getCredential(): Promise<Credential | null> {
  return kvConfigured() ? kvGet() : fileGet();
}

export async function setCredential(cred: Credential): Promise<void> {
  return kvConfigured() ? kvSet(cred) : fileSet(cred);
}
