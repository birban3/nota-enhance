// Server-side storage for the synced note archive.
//
// Mirrors `lib/credential-store.ts` exactly (KV via REST in prod, JSON file in
// dev). The whole thing is a single value at one key — single-user app, so
// there's nothing to scope by tenant. The shape we persist is `RemoteShape`
// below, NOT the raw archive: we keep tombstones alongside the live notes so
// that a delete made on one device propagates correctly to others (without
// tombstones, the other device would re-upload its still-present copy and
// "resurrect" the deleted note on the next merge).
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

const KV_KEY = "nota-enhance:notes-archive-v1";

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
async function kvGet(): Promise<RemoteShape | null> {
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
    return JSON.parse(data.result) as RemoteShape;
  } catch {
    return null;
  }
}

async function kvSet(shape: RemoteShape): Promise<void> {
  const c = kvCreds()!;
  const url = `${c.url}/set/${encodeURIComponent(KV_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(shape),
  });
  if (!res.ok) throw new Error(`KV SET failed: ${res.status}`);
}

// ── File backend (dev only) ──
async function fileGet(): Promise<RemoteShape | null> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".notes-archive.json");
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as RemoteShape;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

async function fileSet(shape: RemoteShape): Promise<void> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const file = path.join(process.cwd(), ".notes-archive.json");
  await fs.writeFile(file, JSON.stringify(shape), { mode: 0o600 });
}

// ── Public API ──
export async function getRemoteArchive(): Promise<RemoteShape | null> {
  return kvConfigured() ? kvGet() : fileGet();
}

export async function setRemoteArchive(shape: RemoteShape): Promise<void> {
  return kvConfigured() ? kvSet(shape) : fileSet(shape);
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
