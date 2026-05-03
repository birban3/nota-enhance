// /api/notes/sync — pull-and-push sync endpoint.
//
//   GET  → returns the server-side archive (or null if never written). The
//          client uses this on hydrate to know what other devices have
//          pushed since it last opened the app.
//   POST → accepts the client's current archive + tombstones, merges with
//          whatever is on the server (per-note last-write-wins, tombstones
//          win over older edits), writes the merged result, returns it.
//
// Auth: middleware already enforces the JWT cookie before we ever get
// here, but we ALSO verify the cookie inside the handler as defence in
// depth — if a future middleware refactor or a public-paths regression
// accidentally exposed this route, the archive (potentially containing
// private notes / images / API call history) would not become world-
// readable. Single-user model means we don't scope storage by username,
// only gate access on a valid session.

import { NextRequest, NextResponse } from "next/server";
import {
  getRemoteArchive,
  setRemoteArchive,
  mergeArchives,
  type RemoteShape,
  type ArchivedNoteServer,
} from "@/lib/notes-store";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY: RemoteShape = { archive: [], tombstones: {}, serverUpdatedAt: 0 };

async function isAuthed(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const username = await verifySessionToken(token);
  return !!username;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  }
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
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  }
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
