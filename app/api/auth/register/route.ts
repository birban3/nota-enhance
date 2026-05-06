import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getCredential, setCredential } from "@/lib/credential-store";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

// Node runtime: bcryptjs is too slow on edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Naive in-memory rate limit (per Vercel function instance — best effort).
// Keeps a single IP from spamming new accounts.
const ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 6;

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
  return entry.count > MAX_ATTEMPTS;
}

// Pragmatic email validator — RFC-strict regexes are huge and reject more
// than they should. This catches the obvious mistakes (no @, no TLD,
// whitespace) without rejecting legitimate addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Allow letters from any alphabet (Italian users have accented chars; we
// also want to support hyphens, apostrophes, and inner spaces for
// multi-word names).
const NAME_RE = /^[\p{L}][\p{L}\p{M}\s'.\-]{0,49}$/u;

export async function POST(req: NextRequest) {
  try {
    const ip = clientKey(req);
    if (rateLimited(ip)) {
      return NextResponse.json(
        { error: "Troppi tentativi. Riprova tra un minuto." },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      firstName?: unknown;
      lastName?: unknown;
      email?: unknown;
      password?: unknown;
    };
    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!NAME_RE.test(firstName)) {
      return NextResponse.json(
        { error: "Nome non valido (1–50 caratteri, solo lettere e segni comuni)." },
        { status: 400 }
      );
    }
    if (!NAME_RE.test(lastName)) {
      return NextResponse.json(
        { error: "Cognome non valido (1–50 caratteri, solo lettere e segni comuni)." },
        { status: 400 }
      );
    }
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return NextResponse.json(
        { error: "Email non valida." },
        { status: 400 }
      );
    }
    if (password.length < 8 || password.length > 200) {
      return NextResponse.json(
        { error: "La password deve avere tra 8 e 200 caratteri." },
        { status: 400 }
      );
    }

    // Email is the unique identifier. Reject duplicates case-insensitively
    // (already lowercased above).
    const existing = await getCredential(email);
    if (existing) {
      return NextResponse.json(
        { error: "Email già registrata. Prova ad accedere." },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await setCredential({
      // `username` doubles as the storage key; for email-based registrations
      // we use the lowercased email so we don't need a separate index.
      username: email,
      email,
      firstName,
      lastName,
      passwordHash,
      createdAt: Date.now(),
    });

    const token = await createSessionToken(email);
    const res = NextResponse.json({ ok: true, email, firstName, lastName });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    console.error("Register error:", err);
    return NextResponse.json(
      { error: "Errore di registrazione." },
      { status: 500 }
    );
  }
}
