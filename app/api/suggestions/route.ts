// /api/suggestions — POST a new improvement suggestion.
//
// Auth required (we want to attribute suggestions to a username so spam can
// be triaged later). Middleware already enforces the JWT cookie before this
// handler runs, but we re-verify here as defence in depth.

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth";
import { appendSuggestion, type Suggestion } from "@/lib/suggestions-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-instance, per-IP rate limit: avoid one user mashing submit and pushing
// older suggestions out of the cap. KV-backed limits would be more robust
// across function instances but this is enough for a beta.
const ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_HOUR = 10;

function clientKey(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = ATTEMPTS.get(key);
  if (!entry || entry.resetAt < now) {
    ATTEMPTS.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_HOUR;
}

const TEXT_MIN = 5;
const TEXT_MAX = 4000;
const CONTACT_MAX = 200;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const username = token ? await verifySessionToken(token) : null;
  if (!username) {
    return NextResponse.json({ error: "Non autenticato." }, { status: 401 });
  }

  const ip = clientKey(req);
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Hai inviato troppi suggerimenti di recente. Riprova più tardi." },
      { status: 429 }
    );
  }

  let body: { text?: unknown; contact?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  if (text.length < TEXT_MIN) {
    return NextResponse.json(
      { error: `Suggerimento troppo corto (min ${TEXT_MIN} caratteri).` },
      { status: 400 }
    );
  }
  if (text.length > TEXT_MAX) {
    return NextResponse.json(
      { error: `Suggerimento troppo lungo (max ${TEXT_MAX} caratteri).` },
      { status: 400 }
    );
  }
  if (contact.length > CONTACT_MAX) {
    return NextResponse.json(
      { error: `Campo contatto troppo lungo (max ${CONTACT_MAX} caratteri).` },
      { status: 400 }
    );
  }

  const entry: Suggestion = {
    id: uid(),
    username,
    text,
    createdAt: Date.now(),
    ...(contact ? { contact } : {}),
  };

  try {
    await appendSuggestion(entry);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("suggestions POST failed:", err);
    return NextResponse.json(
      { error: "Salvataggio del suggerimento fallito." },
      { status: 500 }
    );
  }
}
