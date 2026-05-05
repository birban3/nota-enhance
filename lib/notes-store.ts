// Server-side storage for the synced note archive — multi-user.
//
// Each user's archive is stored at its own KV key:
//   nota-enhance:notes-archive-v1:<lowercased-username>
// Lookups MUST go through the per-user wrappers exported below; the API
// route reads the username from the verified JWT, so there's no cross-user
// path that doesn't go through auth.
//
// Mirrors `lib/credential-store.ts` exactly (KV via REST in prod, JSON file in
// dev). The shape we persist is `RemoteShape` below, NOT the raw archive: we
// keep tombstones alongside the live notes so that a delete made on one
// device propagates correctly to others (without tombstones, the other device
// would re-upload its still-present copy and "resurrect" the deleted note on
// the next merge).
//
// Server-only — never import from a client component.

import "server-only";

export interface AskMsg {
  role: "user" | "assistant";
  content: string;
}

export interface ArchivedNoteServer {
  id: string;
  title: string;
  notes: string;
  transcript: string;
  enhancedHtml: string;
  createdAt: number;
  updatedAt: number;
  manualTitle?: boolean;
  pinned?: boolean;
  splitRatio?: number;
  askMessages?: AskMsg[];
}

export interface RemoteShape {
  archive: ArchivedNoteServer[];
  /** id → deletedAt epoch ms. A note id present here was deleted; if its
   *  tombstone is newer than any live copy's `updatedAt`, the live copy is
   *  dropped during merge. */
  tombstones: Record<string, number>;
  /** When this snapshot was last written, server clock. Returned to clients
   *  so they can show a "last synced" timestamp. */
  serverUpdatedAt: number;
}

const KV_PREFIX = "nota-enhance:notes-archive-v1:";
// Pre-multi-user deploys stored a single archive at this key. We migrate
// transparently the first time the original user reads — if their per-user
// key is empty and the legacy key has data, we hand back the legacy archive,
// and `setRemoteArchive` will write to the new per-user key on the next
// sync (after which we delete the legacy key so future reads don't keep
// shadowing the per-user data).
const KV_LEGACY_SINGLETON = "nota-enhance:notes-archive-v1";
// Tracks which legacy migrations have already been performed in this process,
// so we don't repeatedly issue a DEL for the same user across requests. KV
// is the source of truth — this is just a cheap memo.
const legacyMigrated = new Set<string>();

function userKey(username: string): string {
  return KV_PREFIX + username.trim().toLowerCase();
}

function kvCreds(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

function kvConfigured(): boolean {
  return kvCreds() !== null;
}

// ── KV backend ──
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

async function kvGet(username: string): Promise<RemoteShape | null> {
  const key = userKey(username);
  const raw = await kvGetRaw(key);
  if (raw) {
    try { return JSON.parse(raw) as RemoteShape; } catch { return null; }
  }
  // Legacy migration: single-archive deploy. We only honor this when the
  // legacy archive *has* data — there's no way to tell which user owned it,
  // so we hand it to whoever asks first. In practice that user is the one
  // existing pre-multi-user account holder, who gets logged in via the
  // migrated credential (see lib/credential-store.ts).
  if (legacyMigrated.has(username.toLowerCase())) return null;
  const legacyRaw = await kvGetRaw(KV_LEGACY_SINGLETON);
  if (!legacyRaw) {
    legacyMigrated.add(username.toLowerCase());
    return null;
  }
  try {
    return JSON.parse(legacyRaw) as RemoteShape;
  } catch {
    return null;
  }
}

async function kvSet(username: string, shape: RemoteShape): Promise<void> {
  await kvSetRaw(userKey(username), JSON.stringify(shape));
  // First write under the new per-user key — clear the legacy singleton so
  // its data doesn't keep shadowing future reads (and so it's not exposed
  // to a different user's first read).
  if (!legacyMigrated.has(username.toLowerCase())) {
    legacyMigrated.add(username.toLowerCase());
    try { await kvDeleteRaw(KV_LEGACY_SINGLETON); } catch {}
  }
}

// ── File backend (dev only) ──
//
// New shape: { byUsername: { [lowercaseUsername]: RemoteShape } }. We
// transparently upgrade the legacy flat shape on first read.

interface FileShape {
  byUsername: Record<string, RemoteShape>;
}

async function readFileShape(): Promise<FileShape> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".notes-archive.json");
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FileShape> & Partial<RemoteShape>;
    if (parsed && typeof parsed === "object" && "byUsername" in parsed && parsed.byUsername) {
      return { byUsername: parsed.byUsername };
    }
    // Legacy flat shape — no username info, so we can't safely assign it
    // to a specific user. Stash it under a placeholder key the public API
    // never reads; the dev user will simply see an empty archive on first
    // run after the upgrade. (Production migration uses the KV path above.)
    if (parsed && Array.isArray((parsed as RemoteShape).archive)) {
      return { byUsername: { __legacy__: parsed as RemoteShape } };
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
  const file = path.join(process.cwd(), ".notes-archive.json");
  await fs.writeFile(file, JSON.stringify(shape), { mode: 0o600 });
}

async function fileGet(username: string): Promise<RemoteShape | null> {
  const shape = await readFileShape();
  return shape.byUsername[username.trim().toLowerCase()] ?? null;
}

async function fileSet(username: string, archive: RemoteShape): Promise<void> {
  const shape = await readFileShape();
  shape.byUsername[username.trim().toLowerCase()] = archive;
  await writeFileShape(shape);
}

// ── Public API ──
export async function getRemoteArchive(username: string): Promise<RemoteShape | null> {
  if (!username) return null;
  return kvConfigured() ? kvGet(username) : fileGet(username);
}

export async function setRemoteArchive(username: string, shape: RemoteShape): Promise<void> {
  if (!username) throw new Error("setRemoteArchive: username required");
  return kvConfigured() ? kvSet(username, shape) : fileSet(username, shape);
}

// ── Merge ──
//
// Per-id last-write-wins, with tombstones acting as a "no-resurrect" guard.
// Both inputs are treated symmetrically — the result is the same regardless
// of which side is "remote" vs "incoming", which means concurrent pushes
// from two devices converge on the same answer (eventual consistency).
export function mergeArchives(a: RemoteShape, b: RemoteShape): RemoteShape {
  // 1. Tombstones: union, latest wins per id.
  const tombstones: Record<string, number> = { ...a.tombstones };
  for (const [id, ts] of Object.entries(b.tombstones || {})) {
    const cur = tombstones[id];
    if (!cur || ts > cur) tombstones[id] = ts;
  }

  // 2. Live notes: per id, take the version with the higher updatedAt. Drop
  //    any note whose id has a tombstone with deletedAt >= updatedAt (i.e.
  //    the delete happened after this version was written).
  const noteMap = new Map<string, ArchivedNoteServer>();
  const consider = (n: ArchivedNoteServer) => {
    const tomb = tombstones[n.id];
    if (tomb && tomb >= n.updatedAt) return;
    const cur = noteMap.get(n.id);
    if (!cur || n.updatedAt > cur.updatedAt) noteMap.set(n.id, n);
  };
  for (const n of a.archive) consider(n);
  for (const n of b.archive) consider(n);

  // 3. Garbage-collect tombstones for which no live note remains AND whose
  //    deletedAt is older than 30 days. Keeps the payload from growing
  //    unbounded across years of deletes.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(tombstones)) {
    if (ts < cutoff && !noteMap.has(id)) delete tombstones[id];
  }

  return {
    archive: [...noteMap.values()],
    tombstones,
    serverUpdatedAt: Date.now(),
  };
}
