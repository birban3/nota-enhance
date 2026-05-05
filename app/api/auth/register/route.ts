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

// Usernames double as KV partition keys, so we restrict the alphabet to
// printable ASCII letters/digits and a small set of separators. This rules
// out whitespace, control characters, and anything that would break URL
// encoding in the KV REST path. Lowercase is enforced at storage time so
// "Mario" and "mario" can't both exist.
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

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
      username?: unknown;
      password?: unknown;
    };
    const usernameRaw =
      typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!USERNAME_RE.test(usernameRaw)) {
      return NextResponse.json(
        {
          error:
            "Username non valido: 3–32 caratteri, solo lettere, numeri, punto, trattino e underscore.",
        },
        { status: 400 }
      );
    }
    if (password.length < 8 || password.length > 200) {
      return NextResponse.json(
        { error: "La password deve avere tra 8 e 200 caratteri." },
        { status: 400 }
      );
    }

    // Username uniqueness — case-insensitive lookup.
    const existing = await getCredential(usernameRaw);
    if (existing) {
      return NextResponse.json(
        { error: "Username già registrato. Prova un altro nome o accedi." },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // Persist the username in its lowercase canonical form so JWTs we mint
    // and the storage keys never disagree.
    const username = usernameRaw.toLowerCase();
    await setCredential({
      username,
      passwordHash,
      createdAt: Date.now(),
    });

    const token = await createSessionToken(username);
    const res = NextResponse.json({ ok: true, username });
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
