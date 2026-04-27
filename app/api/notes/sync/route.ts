// /api/notes/sync — pull-and-push sync endpoint.
//
//   GET  → returns the server-side archive (or null if never written). The
//          client uses this on hydrate to know what other devices have
//          pushed since it last opened the app.
//   POST → accepts the client's current archive + tombstones, merges with
//          whatever is on the server (per-note last-write-wins, tombstones
//          win over older edits), writes the merged result, returns it.
//
// Auth: middleware enforces the JWT cookie before we ever get here. The
// app is single-user so we don't carry username into the storage key — the
// archive is a single shared blob.

import { NextRequest, NextResponse } from "next/server";
import {
  getRemoteArchive,
  setRemoteArchive,
  mergeArchives,
  type RemoteShape,
  type ArchivedNoteServer,
} from "@/lib/notes-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY: RemoteShape = { archive: [], tombstones: {}, serverUpdatedAt: 0 };

export async function GET() {
  try {
    const remote = (await getRemoteArchive()) ?? EMPTY;
    return NextResponse.json(remote);
  } catch (err) {
    console.error("notes/sync GET failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync read failed." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { archive?: unknown; tombstones?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Tolerant validation: accept anything shaped like the server type and let
  // the merge silently drop nodes that don't have an id+updatedAt. This keeps
  // sync robust against client-side schema drift across deploys.
  const incomingArchive: ArchivedNoteServer[] = Array.isArray(body.archive)
    ? (body.archive as unknown[])
        .filter(
          (n): n is ArchivedNoteServer =>
            !!n &&
            typeof n === "object" &&
            typeof (n as { id?: unknown }).id === "string" &&
            typeof (n as { updatedAt?: unknown }).updatedAt === "number"
        )
    : [];
  const incomingTombstones: Record<string, number> =
    body.tombstones && typeof body.tombstones === "object"
      ? Object.fromEntries(
          Object.entries(body.tombstones as Record<string, unknown>).filter(
            ([, v]) => typeof v === "number"
          ) as [string, number][]
        )
      : {};

  const incoming: RemoteShape = {
    archive: incomingArchive,
    tombstones: incomingTombstones,
    serverUpdatedAt: 0,
  };

  try {
    const remote = (await getRemoteArchive()) ?? EMPTY;
    const merged = mergeArchives(remote, incoming);
    await setRemoteArchive(merged);
    return NextResponse.json(merged);
  } catch (err) {
    console.error("notes/sync POST failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync write failed." },
      { status: 500 }
    );
  }
}
